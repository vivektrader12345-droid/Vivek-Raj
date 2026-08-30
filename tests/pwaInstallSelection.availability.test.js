import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ANDROID_APK_FILENAME,
  ANDROID_APK_PATH,
  ANDROID_APK_UNAVAILABLE_REASONS,
  checkAndroidApkAvailability,
  selectAndroidApk,
} from '../src/components/pwaInstallSelection.js'

const ORIGIN = 'https://app.invalid'
const DESCRIPTOR_PATH = `${ANDROID_APK_PATH}.json`
const DESCRIPTOR = Object.freeze({
  schemaVersion: 2,
  path: ANDROID_APK_PATH,
  filename: ANDROID_APK_FILENAME,
  mediaType: 'application/vnd.android.package-archive',
  applicationId: 'com.vivekmarco.trader',
  versionCode: 3,
  versionName: '1.0.2',
  sourceRevision: 'a'.repeat(40),
  byteSize: 2_000_000,
  sha256: 'b'.repeat(64),
  signer: Object.freeze({
    classification: 'approved-release',
    certificateSha256: Array(32).fill('CC').join(':'),
  }),
})
const VERSIONED_URL = `${ORIGIN}${ANDROID_APK_PATH}?v=${DESCRIPTOR.sha256}`

function bytes(value) {
  if (value instanceof Uint8Array) return value
  return new TextEncoder().encode(String(value))
}

function response(body, { status = 200, url, redirected = false, headers = {} } = {}) {
  const payload = bytes(body)
  const stream = new Response(payload).body
  return {
    status,
    url,
    redirected,
    headers: new Headers(headers),
    body: stream,
    async arrayBuffer() {
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
    },
  }
}

function mergeHeaders(defaults, overrides) {
  return Object.fromEntries(new Headers({ ...defaults, ...(overrides || {}) }).entries())
}

function createDocumentFixture({ clickThrows = false } = {}) {
  const observations = { created: [], appended: [], clicks: 0, removals: 0 }
  const anchor = {
    href: '',
    download: '',
    click() {
      observations.clicks += 1
      if (clickThrows) throw new Error('synthetic browser restriction')
    },
    remove() { observations.removals += 1 },
  }
  return {
    anchor,
    observations,
    document: {
      body: { appendChild(value) { observations.appended.push(value) } },
      createElement(tagName) {
        observations.created.push(tagName)
        return anchor
      },
    },
  }
}

function createNetworkFixture(overrides = {}) {
  const calls = []
  const fetch = async (input, options) => {
    const url = new URL(input)
    const stage = url.pathname === DESCRIPTOR_PATH
      ? 'descriptor'
      : options?.headers?.Range === 'bytes=0-3' ? 'prefix' : 'tail'
    calls.push({ stage, url: url.href, options })

    if (overrides.throwAt === stage) throw new TypeError('synthetic network error')
    const stageOverride = overrides[stage] || {}
    if (typeof stageOverride.respond === 'function') return stageOverride.respond({ url, options })

    if (stage === 'descriptor') {
      const payload = stageOverride.body ?? JSON.stringify(stageOverride.descriptor ?? DESCRIPTOR)
      return response(payload, {
        status: stageOverride.status ?? 200,
        url: stageOverride.url ?? url.href,
        redirected: stageOverride.redirected ?? false,
        headers: mergeHeaders({ 'content-type': 'application/json' }, stageOverride.headers),
      })
    }

    const isPrefix = stage === 'prefix'
    const finalOffset = DESCRIPTOR.byteSize - 1
    const expectedLength = isPrefix ? 4 : 1
    const payload = stageOverride.body ?? (isPrefix
      ? new Uint8Array([0x50, 0x4b, 0x03, 0x04])
      : new Uint8Array([0x00]))
    return response(payload, {
      status: stageOverride.status ?? 206,
      url: stageOverride.url ?? url.href,
      redirected: stageOverride.redirected ?? false,
      headers: mergeHeaders({
        'content-type': 'application/vnd.android.package-archive',
        'content-disposition': `attachment; filename="${ANDROID_APK_FILENAME}"`,
        'content-range': isPrefix
          ? `bytes 0-3/${DESCRIPTOR.byteSize}`
          : `bytes ${finalOffset}-${finalOffset}/${DESCRIPTOR.byteSize}`,
        'content-length': String(expectedLength),
      }, stageOverride.headers),
    })
  }

  return { calls, fetch }
}

function preflightOptions(network, overrides = {}) {
  return {
    fetch: network.fetch,
    location: { origin: ORIGIN },
    nonce: overrides.nonce ?? 'unit-attempt',
    timeoutMs: overrides.timeoutMs ?? 1_000,
    now: overrides.now ?? (() => 1_000),
    signal: overrides.signal,
  }
}

test('availability preflight uses credential-free no-store requests and proves both APK boundaries', async () => {
  // **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
  const network = createNetworkFixture()
  const result = await checkAndroidApkAvailability(preflightOptions(network))

  assert.equal(result.status, 'available')
  assert.equal(result.url, VERSIONED_URL)
  assert.equal(result.manualUrl, VERSIONED_URL)
  assert.equal(result.descriptor.sha256, DESCRIPTOR.sha256)
  assert.equal(result.claimedDownloadStarted, false)
  assert.equal(result.claimedTransferCompleted, false)
  assert.deepEqual(network.calls.map(call => call.stage), ['descriptor', 'prefix', 'tail'])
  assert.equal(network.calls[0].url, `${ORIGIN}${DESCRIPTOR_PATH}?revalidate=unit-attempt`)
  assert.equal(network.calls[1].url, VERSIONED_URL)
  assert.equal(network.calls[2].url, VERSIONED_URL)
  assert.equal(network.calls[1].options.headers.Range, 'bytes=0-3')
  assert.equal(network.calls[2].options.headers.Range, `bytes=${DESCRIPTOR.byteSize - 1}-${DESCRIPTOR.byteSize - 1}`)
  for (const call of network.calls) {
    assert.equal(call.options.cache, 'no-store', call.stage)
    assert.equal(call.options.credentials, 'omit', call.stage)
    assert.equal(call.options.redirect, 'error', call.stage)
    assert.ok(call.options.signal instanceof AbortSignal, call.stage)
  }
})

test('selection is single-flight and activates exactly one temporary anchor with manual recovery URL', async () => {
  // **Validates: Requirements 2.5, 2.6, 2.7**
  const network = createNetworkFixture()
  const documentFixture = createDocumentFixture()
  const options = {
    ...preflightOptions(network, { nonce: 'single-flight' }),
    document: documentFixture.document,
  }

  const first = selectAndroidApk(options)
  const second = selectAndroidApk(options)
  assert.equal(first, second)
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(firstResult, secondResult)
  assert.equal(firstResult.status, 'requested')
  assert.equal(firstResult.url, VERSIONED_URL)
  assert.equal(firstResult.manualUrl, VERSIONED_URL)
  assert.equal(firstResult.selectedCount, 1)
  assert.equal(firstResult.claimedDownloadStarted, false)
  assert.equal(firstResult.claimedTransferCompleted, false)
  assert.equal(network.calls.length, 3)
  assert.deepEqual(documentFixture.observations.created, ['a'])
  assert.equal(documentFixture.observations.appended.length, 1)
  assert.equal(documentFixture.observations.clicks, 1)
  assert.equal(documentFixture.observations.removals, 1)
  assert.equal(documentFixture.anchor.href, VERSIONED_URL)
  assert.equal(documentFixture.anchor.download, ANDROID_APK_FILENAME)

  await selectAndroidApk({ ...options, nonce: 'fresh-second-attempt' })
  assert.equal(network.calls.length, 6, 'a settled selection always revalidates before another activation')
  assert.equal(documentFixture.observations.clicks, 2)
})

test('bounded preflight classifies timeout and caller cleanup without creating an activation', async () => {
  // **Validates: Requirements 2.5, 2.7**
  let timedOutSignal
  const neverSettles = (_url, options) => new Promise((_resolve, reject) => {
    timedOutSignal = options.signal
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
  const timeout = await checkAndroidApkAvailability({
    fetch: neverSettles,
    location: { origin: ORIGIN },
    nonce: 'timeout',
    timeoutMs: 10,
  })
  assert.equal(timeout.status, 'unavailable')
  assert.equal(timeout.reason, ANDROID_APK_UNAVAILABLE_REASONS.TIMEOUT)
  assert.equal(timedOutSignal.aborted, true)

  const caller = new AbortController()
  let inFlightSignal
  const waitsForCaller = (_url, options) => new Promise((_resolve, reject) => {
    inFlightSignal = options.signal
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
  const pending = checkAndroidApkAvailability({
    fetch: waitsForCaller,
    location: { origin: ORIGIN },
    nonce: 'caller-cleanup',
    timeoutMs: 1_000,
    signal: caller.signal,
  })
  caller.abort()
  const cancelled = await pending
  assert.equal(cancelled.status, 'unavailable')
  assert.equal(cancelled.reason, ANDROID_APK_UNAVAILABLE_REASONS.CANCELLED)
  assert.equal(inFlightSignal.aborted, true)
})

test('activation restriction removes its temporary anchor and returns non-sensitive manual guidance state', async () => {
  // **Validates: Requirements 2.6, 2.7**
  const network = createNetworkFixture()
  const documentFixture = createDocumentFixture({ clickThrows: true })
  const result = await selectAndroidApk({
    ...preflightOptions(network, { nonce: 'blocked-browser' }),
    document: documentFixture.document,
  })

  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, ANDROID_APK_UNAVAILABLE_REASONS.ACTIVATION_RESTRICTED)
  assert.equal(result.url, VERSIONED_URL)
  assert.equal(result.manualUrl, VERSIONED_URL)
  assert.equal(result.selectedCount, 0)
  assert.equal(documentFixture.observations.clicks, 1)
  assert.equal(documentFixture.observations.removals, 1)
})

test('Property 1 generated response failures always fail closed with zero activation', async () => {
  // **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7**
  const cases = [
    ['missing descriptor', { descriptor: { status: 404 } }, 'missing'],
    ['descriptor redirect', { descriptor: { redirected: true } }, 'redirect'],
    ['off-origin descriptor', { descriptor: { url: `https://cdn.invalid${DESCRIPTOR_PATH}?revalidate=property` } }, 'off-origin'],
    ['HTML descriptor', { descriptor: { body: '<!doctype html>', headers: { 'content-type': 'text/html' } } }, 'invalid-metadata'],
    ['malformed descriptor', { descriptor: { body: '{not-json' } }, 'invalid-metadata'],
    ['wrong-case metadata path', { descriptor: { descriptor: { ...DESCRIPTOR, path: '/downloads/Vivek-Marco-Trader.apk' } } }, 'invalid-metadata'],
    ['range ignored with full response', { prefix: { status: 200 } }, 'wrong-content'],
    ['range redirect', { prefix: { redirected: true } }, 'redirect'],
    ['off-origin APK', { prefix: { url: `https://cdn.invalid${ANDROID_APK_PATH}?v=${DESCRIPTOR.sha256}` } }, 'off-origin'],
    ['HTML APK', { prefix: { headers: { 'content-type': 'text/html' } } }, 'wrong-content'],
    ['wrong disposition', { prefix: { headers: { 'content-disposition': 'inline' } } }, 'wrong-content'],
    ['wrong total', { prefix: { headers: { 'content-range': `bytes 0-3/${DESCRIPTOR.byteSize - 1}` } } }, 'wrong-content'],
    ['wrong prefix', { prefix: { body: new Uint8Array([0, 1, 2, 3]) } }, 'wrong-content'],
    ['missing final byte', { tail: { status: 416 } }, 'truncation'],
    ['truncated final byte', { tail: { body: new Uint8Array(), headers: { 'content-length': '1' } } }, 'truncation'],
    ['network failure', { throwAt: 'descriptor' }, 'network-error'],
  ]

  for (let seed = 0; seed < cases.length; seed += 1) {
    const [name, fixtureOverrides, expectedReason] = cases[seed]
    const network = createNetworkFixture(fixtureOverrides)
    const documentFixture = createDocumentFixture()
    const result = await selectAndroidApk({
      ...preflightOptions(network, { nonce: 'property' }),
      document: documentFixture.document,
    })

    assert.equal(result.status, 'unavailable', `${name} (seed ${seed})`)
    assert.equal(result.reason, expectedReason, `${name} (seed ${seed})`)
    assert.equal(result.selectedCount, 0, `${name} (seed ${seed})`)
    assert.equal(result.claimedDownloadStarted, false, `${name} (seed ${seed})`)
    assert.equal(result.claimedTransferCompleted, false, `${name} (seed ${seed})`)
    assert.deepEqual(documentFixture.observations.created, [], `${name} (seed ${seed})`)
  }
})
