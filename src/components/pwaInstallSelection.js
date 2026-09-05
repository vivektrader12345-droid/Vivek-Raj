import {
  APK_DESCRIPTOR_PATH,
  deriveAndroidApkUrl,
  validateApkDescriptor,
} from './apkDescriptorContract.js'

export {
  APK_DESCRIPTOR_PATH,
  deriveAndroidApkUrl,
  validateApkDescriptor,
}

// Compatibility exports are derived from the sole bootstrap locator rather than
// maintaining a second release path constant.
export const ANDROID_APK_PATH = APK_DESCRIPTOR_PATH.slice(0, -'.json'.length)
export const ANDROID_APK_FILENAME = ANDROID_APK_PATH.slice(ANDROID_APK_PATH.lastIndexOf('/') + 1)
export const ANDROID_APK_AVAILABILITY_TTL_MS = 30_000
export const ANDROID_APK_PREFLIGHT_TIMEOUT_MS = 8_000

const MAX_DESCRIPTOR_BYTES = 64 * 1024
const APK_PREFIX = Object.freeze([0x50, 0x4b, 0x03, 0x04])
const ALLOWED_APK_MEDIA_TYPES = new Set([
  'application/vnd.android.package-archive',
  'application/octet-stream',
])
const REASON = Object.freeze({
  ACTIVATION_RESTRICTED: 'activation-restricted',
  CANCELLED: 'cancelled',
  INVALID_ENVIRONMENT: 'invalid-environment',
  INVALID_METADATA: 'invalid-metadata',
  MISSING: 'missing',
  NETWORK_ERROR: 'network-error',
  OFF_ORIGIN: 'off-origin',
  REDIRECT: 'redirect',
  TIMEOUT: 'timeout',
  TRUNCATION: 'truncation',
  WRONG_CONTENT: 'wrong-content',
})

export const ANDROID_APK_UNAVAILABLE_REASONS = REASON

let nextAttemptId = 0
let selectionInFlight = null

class AvailabilityFailure extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'AvailabilityFailure'
    this.reason = reason
  }
}

function fail(reason) {
  throw new AvailabilityFailure(reason)
}

function unavailable(reason, recovery) {
  return Object.freeze({
    status: 'unavailable',
    state: 'unavailable',
    reason,
    verifiedAvailable: false,
    selectedCount: 0,
    claimedDownloadStarted: false,
    claimedTransferCompleted: false,
    ...(recovery ? {
      descriptor: recovery.descriptor,
      url: recovery.url,
      manualUrl: recovery.url,
    } : {}),
  })
}

function safelyRead(value, key) {
  try {
    return value?.[key]
  } catch {
    return undefined
  }
}

function normalizeMediaType(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : ''
}

function normalizeApplicationOrigin(locationLike) {
  const candidate = typeof locationLike === 'string' ? locationLike : safelyRead(locationLike, 'origin')
  if (typeof candidate !== 'string') fail(REASON.INVALID_ENVIRONMENT)

  let url
  try {
    url = new URL(candidate)
  } catch {
    fail(REASON.INVALID_ENVIRONMENT)
  }

  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.origin !== candidate) fail(REASON.INVALID_ENVIRONMENT)
  return url.origin
}

function createAttemptNonce() {
  nextAttemptId += 1
  return `${nextAttemptId.toString(36)}-${Date.now().toString(36)}`
}

function exactResponseUrl(response, expectedUrl) {
  if (safelyRead(response, 'redirected') === true) fail(REASON.REDIRECT)

  let finalUrl
  try {
    finalUrl = new URL(safelyRead(response, 'url'))
  } catch {
    fail(REASON.OFF_ORIGIN)
  }

  if (finalUrl.origin !== expectedUrl.origin) fail(REASON.OFF_ORIGIN)
  if (finalUrl.pathname !== expectedUrl.pathname
    || finalUrl.search !== expectedUrl.search
    || finalUrl.hash) fail(REASON.REDIRECT)
}

function header(response, name) {
  try {
    return response.headers?.get(name)
  } catch {
    return null
  }
}

async function readLimitedBytes(response, maximumBytes) {
  const body = safelyRead(response, 'body')
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
        total += chunk.byteLength
        if (total > maximumBytes) fail(REASON.WRONG_CONTENT)
        chunks.push(chunk)
      }
    } finally {
      try { reader.releaseLock() } catch {}
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }

  if (typeof response?.arrayBuffer !== 'function') fail(REASON.WRONG_CONTENT)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > maximumBytes) fail(REASON.WRONG_CONTENT)
  return new Uint8Array(buffer)
}

function statusReason(status, tail = false) {
  if (status === 404 || status === 410) return REASON.MISSING
  if (tail && status === 416) return REASON.TRUNCATION
  return REASON.WRONG_CONTENT
}

async function fetchExactRange({ fetchLike, url, range, expectedLength, expectedContentRange, descriptor, signal, tail }) {
  const response = await fetchLike(url.href, {
    method: 'GET',
    headers: { Range: range },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal,
  })

  if (response?.status !== 206) fail(statusReason(response?.status, tail))
  exactResponseUrl(response, url)
  if (!ALLOWED_APK_MEDIA_TYPES.has(normalizeMediaType(header(response, 'content-type')))) {
    fail(REASON.WRONG_CONTENT)
  }
  if (header(response, 'content-disposition') !== `attachment; filename="${descriptor.filename}"`) {
    fail(REASON.WRONG_CONTENT)
  }
  if (header(response, 'content-range') !== expectedContentRange) {
    fail(tail ? REASON.TRUNCATION : REASON.WRONG_CONTENT)
  }
  if (header(response, 'content-length') !== String(expectedLength)) {
    fail(tail ? REASON.TRUNCATION : REASON.WRONG_CONTENT)
  }

  const bytes = await readLimitedBytes(response, expectedLength)
  if (bytes.byteLength !== expectedLength) fail(tail ? REASON.TRUNCATION : REASON.WRONG_CONTENT)
  return bytes
}

function normalizePreflightOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail(REASON.INVALID_ENVIRONMENT)
  }

  return {
    fetchLike: options.fetch ?? globalThis.fetch,
    locationLike: options.location ?? globalThis.location,
    nonce: options.nonce ?? createAttemptNonce(),
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? ANDROID_APK_PREFLIGHT_TIMEOUT_MS,
    now: options.now ?? Date.now,
  }
}

export function classifyAndroidPlatform(navigatorLike) {
  if (navigatorLike == null) return false

  let userAgentData
  try {
    userAgentData = navigatorLike.userAgentData
  } catch {
    return false
  }

  if (userAgentData !== undefined) {
    const platform = safelyRead(userAgentData, 'platform')
    return typeof platform === 'string' && platform.trim().toLowerCase() === 'android'
  }

  const userAgent = safelyRead(navigatorLike, 'userAgent')
  return typeof userAgent === 'string' && /android/i.test(userAgent)
}

export async function checkAndroidApkAvailability(options = {}) {
  let normalized
  try {
    normalized = normalizePreflightOptions(options)
  } catch (error) {
    return unavailable(error instanceof AvailabilityFailure ? error.reason : REASON.INVALID_ENVIRONMENT)
  }

  const { fetchLike, locationLike, nonce, signal: externalSignal, timeoutMs, now } = normalized
  if (typeof fetchLike !== 'function'
    || typeof nonce !== 'string'
    || nonce.length === 0
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
    || typeof now !== 'function') return unavailable(REASON.INVALID_ENVIRONMENT)

  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener?.('abort', abortFromCaller, { once: true })

  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const applicationOrigin = normalizeApplicationOrigin(locationLike)
    if (controller.signal.aborted) return unavailable(REASON.CANCELLED)

    const descriptorUrl = new URL(APK_DESCRIPTOR_PATH, `${applicationOrigin}/`)
    descriptorUrl.searchParams.set('revalidate', nonce)
    const descriptorResponse = await fetchLike(descriptorUrl.href, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })

    if (descriptorResponse?.status !== 200) fail(statusReason(descriptorResponse?.status))
    exactResponseUrl(descriptorResponse, descriptorUrl)
    if (normalizeMediaType(header(descriptorResponse, 'content-type')) !== 'application/json') {
      fail(REASON.INVALID_METADATA)
    }

    const descriptorBytes = await readLimitedBytes(descriptorResponse, MAX_DESCRIPTOR_BYTES)
    let descriptorSource
    try {
      descriptorSource = new TextDecoder('utf-8', { fatal: true }).decode(descriptorBytes)
    } catch {
      fail(REASON.INVALID_METADATA)
    }
    if (/^\s*</.test(descriptorSource)) fail(REASON.INVALID_METADATA)

    let descriptorValue
    try {
      descriptorValue = JSON.parse(descriptorSource)
    } catch {
      fail(REASON.INVALID_METADATA)
    }

    let descriptor
    let derived
    try {
      descriptor = validateApkDescriptor(descriptorValue)
      derived = deriveAndroidApkUrl(descriptor, applicationOrigin)
    } catch {
      fail(REASON.INVALID_METADATA)
    }

    const apkUrl = new URL(derived.url)
    apkUrl.searchParams.set('v', descriptor.sha256)
    apkUrl.searchParams.set('download', '1')

    const prefixUrl = new URL(apkUrl)
    prefixUrl.searchParams.set('probe', 'prefix')
    const prefix = await fetchExactRange({
      fetchLike,
      url: prefixUrl,
      range: 'bytes=0-3',
      expectedLength: 4,
      expectedContentRange: `bytes 0-3/${descriptor.byteSize}`,
      descriptor,
      signal: controller.signal,
      tail: false,
    })
    if (!APK_PREFIX.every((value, index) => prefix[index] === value)) fail(REASON.WRONG_CONTENT)

    const finalOffset = descriptor.byteSize - 1
    const tailUrl = new URL(apkUrl)
    tailUrl.searchParams.set('probe', 'tail')
    await fetchExactRange({
      fetchLike,
      url: tailUrl,
      range: `bytes=${finalOffset}-${finalOffset}`,
      expectedLength: 1,
      expectedContentRange: `bytes ${finalOffset}-${finalOffset}/${descriptor.byteSize}`,
      descriptor,
      signal: controller.signal,
      tail: true,
    })

    return Object.freeze({
      status: 'available',
      state: 'available',
      reason: null,
      descriptor,
      url: apkUrl.href,
      manualUrl: apkUrl.href,
      checkedAt: now(),
      expiresAt: now() + ANDROID_APK_AVAILABILITY_TTL_MS,
      verifiedAvailable: true,
      selectedCount: 0,
      claimedDownloadStarted: false,
      claimedTransferCompleted: false,
    })
  } catch (error) {
    if (timedOut) return unavailable(REASON.TIMEOUT)
    if (controller.signal.aborted) return unavailable(REASON.CANCELLED)
    if (error instanceof AvailabilityFailure) return unavailable(error.reason)
    return unavailable(REASON.NETWORK_ERROR)
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener?.('abort', abortFromCaller)
  }
}

function expectedVersionedUrl(descriptor, applicationOrigin) {
  const derived = deriveAndroidApkUrl(descriptor, applicationOrigin)
  const url = new URL(derived.url)
  url.searchParams.set('v', derived.descriptor.sha256)
  url.searchParams.set('download', '1')
  return { descriptor: derived.descriptor, url }
}

export function activateAndroidApk(options = {}) {
  let expected
  try {
    const applicationOrigin = normalizeApplicationOrigin(options.location ?? globalThis.location)
    expected = expectedVersionedUrl(options.descriptor, applicationOrigin)
    if (options.url !== expected.url.href) return unavailable(REASON.ACTIVATION_RESTRICTED)
  } catch {
    return unavailable(REASON.ACTIVATION_RESTRICTED)
  }

  const recovery = { descriptor: expected.descriptor, url: expected.url.href }
  const documentLike = options.document ?? globalThis.document
  if (typeof documentLike?.createElement !== 'function'
    || typeof documentLike?.body?.appendChild !== 'function') {
    return unavailable(REASON.ACTIVATION_RESTRICTED, recovery)
  }

  let anchor
  let appended = false
  try {
    anchor = documentLike.createElement('a')
    anchor.href = expected.url.href
    anchor.download = expected.descriptor.filename
    documentLike.body.appendChild(anchor)
    appended = true
    if (typeof anchor.click !== 'function') fail(REASON.ACTIVATION_RESTRICTED)
    anchor.click()
  } catch {
    return unavailable(REASON.ACTIVATION_RESTRICTED, recovery)
  } finally {
    if (appended) {
      if (typeof anchor?.remove === 'function') anchor.remove()
      else documentLike.body.removeChild?.(anchor)
    }
  }

  return Object.freeze({
    status: 'requested',
    state: 'requested',
    reason: null,
    descriptor: expected.descriptor,
    url: expected.url.href,
    manualUrl: expected.url.href,
    verifiedAvailable: true,
    selectedCount: 1,
    claimedDownloadStarted: false,
    claimedTransferCompleted: false,
  })
}

function normalizeSelectionOptions(input) {
  if (input && typeof input.createElement === 'function') return { document: input }
  if (input === undefined) return {}
  return input
}

async function performAndroidApkSelection(input) {
  const options = normalizeSelectionOptions(input)
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return unavailable(REASON.INVALID_ENVIRONMENT)
  }

  // Activation always revalidates. This is intentionally stronger than relying
  // on a cached available result, so TTL expiry and visibility regain can never
  // activate stale state. Task 3.3 may use the standalone check for display.
  const availability = await checkAndroidApkAvailability(options)
  if (availability.status !== 'available') return availability

  return activateAndroidApk({
    document: options.document,
    location: options.location,
    descriptor: availability.descriptor,
    url: availability.url,
  })
}

export function selectAndroidApk(input) {
  if (selectionInFlight) return selectionInFlight

  const attempt = Promise.resolve().then(() => performAndroidApkSelection(input))
  selectionInFlight = attempt
  void attempt.finally(() => {
    if (selectionInFlight === attempt) selectionInFlight = null
  })
  return attempt
}
