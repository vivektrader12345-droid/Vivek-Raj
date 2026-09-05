import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APK_DESCRIPTOR_PATH,
  CANONICAL_APK_FILENAME,
  CANONICAL_APK_PATH,
  MAX_APK_BYTE_SIZE,
  validateApkDescriptor,
} from '../src/components/apkDescriptorContract.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_EXPECTED_DESCRIPTOR = path.join(root, 'public', 'downloads', `${CANONICAL_APK_FILENAME}.json`)
const APK_DISPOSITION = `attachment; filename="${CANONICAL_APK_FILENAME}"`
const ALLOWED_APK_MEDIA_TYPES = new Set([
  'application/octet-stream',
  'application/vnd.android.package-archive',
])
const MAX_DESCRIPTOR_BYTES = 64 * 1024
const MAX_AUXILIARY_BYTES = 1024 * 1024
const ZIP_PREFIX = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_BODY_TIMEOUT_MS = 30_000
const MISSING_DOWNLOAD_PATHS = Object.freeze([
  '/downloads/release-verifier-intentionally-absent.apk',
  '/downloads/Vivek-Marco-Trader.apk',
])

export class ApkReleaseVerificationError extends Error {
  constructor(code, classification = 'release-regression') {
    super(code)
    this.name = 'ApkReleaseVerificationError'
    this.code = code
    this.classification = classification
  }
}

function fail(code, classification) {
  throw new ApkReleaseVerificationError(code, classification)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requirePositiveTimeout(value, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) fail(code)
  return value
}

function parseOrigin(value, mode) {
  if (typeof value !== 'string' || !value) fail('ORIGIN_REQUIRED')
  let url
  try {
    url = new URL(value)
  } catch {
    fail('ORIGIN_INVALID')
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.origin !== value
    || url.pathname !== '/'
    || url.search
    || url.hash) fail('ORIGIN_INVALID')
  if (mode === 'production' && url.protocol !== 'https:') fail('PRODUCTION_HTTPS_REQUIRED')
  if (mode === 'preview' && url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    fail('PREVIEW_HTTP_LOOPBACK_REQUIRED')
  }
  return url.origin
}

function validateOptions(options) {
  if (!isRecord(options)) fail('OPTIONS_INVALID')
  const allowed = new Set([
    'bodyTimeoutMs',
    'connectTimeoutMs',
    'expectedDescriptor',
    'fetchImpl',
    'mode',
    'origin',
  ])
  if (Object.keys(options).some(key => !allowed.has(key))) fail('OPTIONS_INVALID')
  if (!['preview', 'production'].includes(options.mode)) fail('MODE_INVALID')
  if (typeof options.fetchImpl !== 'function') fail('FETCH_INVALID')

  let expectedDescriptor
  try {
    expectedDescriptor = validateApkDescriptor(options.expectedDescriptor)
  } catch {
    fail('EXPECTED_DESCRIPTOR_INVALID')
  }

  return {
    bodyTimeoutMs: requirePositiveTimeout(options.bodyTimeoutMs, 'BODY_TIMEOUT_INVALID'),
    connectTimeoutMs: requirePositiveTimeout(options.connectTimeoutMs, 'CONNECT_TIMEOUT_INVALID'),
    expectedDescriptor,
    fetchImpl: options.fetchImpl,
    mode: options.mode,
    origin: parseOrigin(options.origin, options.mode),
  }
}

function requestUrl(origin, pathname, search = '') {
  const url = new URL(pathname, `${origin}/`)
  url.search = search
  return url
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400
}

function requireStatus(response, expected, label) {
  if (isRedirectStatus(response.status)) fail(`${label}_REDIRECT`)
  if (response.status === 401 || response.status === 403) {
    fail(`${label}_AUTHORIZATION_UNAVAILABLE`, 'external-verification-failure')
  }
  if (response.status !== expected) fail(`${label}_STATUS_INVALID`)
}

function requireResponseLocation(response, expectedUrl, label) {
  let actual
  try {
    actual = new URL(response.url)
  } catch {
    fail(`${label}_URL_INVALID`)
  }
  if (response.redirected
    || actual.origin !== expectedUrl.origin
    || actual.pathname !== expectedUrl.pathname
    || actual.search !== expectedUrl.search
    || actual.hash) fail(`${label}_LOCATION_MISMATCH`)
}

function mediaType(response) {
  return (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
}

function requireNoStore(response, label) {
  if (!/(?:^|,)\s*no-store\b/i.test(response.headers.get('cache-control') || '')) {
    fail(`${label}_CACHE_POLICY_INVALID`)
  }
}

function requireNosniff(response, label) {
  if ((response.headers.get('x-content-type-options') || '').trim().toLowerCase() !== 'nosniff') {
    fail(`${label}_NOSNIFF_REQUIRED`)
  }
}

function requireApkHeaders(response, label) {
  if (!ALLOWED_APK_MEDIA_TYPES.has(mediaType(response))) fail(`${label}_MEDIA_TYPE_INVALID`)
  if ((response.headers.get('content-disposition') || '').trim() !== APK_DISPOSITION) {
    fail(`${label}_DISPOSITION_INVALID`)
  }
  requireNoStore(response, label)
  requireNosniff(response, label)
}

function parseContentLength(response, label, required = true) {
  const value = response.headers.get('content-length')
  if (value === null && !required) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value || '')) fail(`${label}_CONTENT_LENGTH_INVALID`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) fail(`${label}_CONTENT_LENGTH_INVALID`)
  return parsed
}

async function readBoundedBody(response, { label, limit, onChunk }) {
  const advertisedLength = parseContentLength(response, label, false)
  if (advertisedLength !== undefined && advertisedLength > limit) fail(`${label}_BODY_TOO_LARGE`)
  if (!response.body) fail(`${label}_BODY_MISSING`)

  const chunks = onChunk ? undefined : []
  let byteSize = 0
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value)
      byteSize += chunk.length
      if (byteSize > limit) fail(`${label}_BODY_TOO_LARGE`)
      if (onChunk) await onChunk(chunk)
      else chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof ApkReleaseVerificationError) throw error
    throw error
  }
  return { byteSize, bytes: chunks ? Buffer.concat(chunks, byteSize) : undefined }
}

async function boundedRequest(config, url, init, label, consume) {
  const controller = new AbortController()
  let phase = 'connect'
  let timedOut = false
  let timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, config.connectTimeoutMs)
  try {
    let response
    try {
      response = await config.fetchImpl(url, {
        ...init,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch {
      fail(timedOut ? `${label}_CONNECT_TIMEOUT` : `${label}_NETWORK_UNAVAILABLE`, 'external-verification-failure')
    }

    clearTimeout(timer)
    phase = 'body'
    timedOut = false
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.bodyTimeoutMs)

    try {
      return await consume(response)
    } catch (error) {
      if (error instanceof ApkReleaseVerificationError) throw error
      fail(timedOut ? `${label}_BODY_TIMEOUT` : `${label}_BODY_UNAVAILABLE`, 'external-verification-failure')
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function descriptorsEqual(actual, expected) {
  return actual.schemaVersion === expected.schemaVersion
    && actual.path === expected.path
    && actual.filename === expected.filename
    && actual.mediaType === expected.mediaType
    && actual.applicationId === expected.applicationId
    && actual.versionCode === expected.versionCode
    && actual.versionName === expected.versionName
    && actual.sourceRevision === expected.sourceRevision
    && actual.byteSize === expected.byteSize
    && actual.sha256 === expected.sha256
    && actual.signer.classification === expected.signer.classification
    && actual.signer.certificateSha256 === expected.signer.certificateSha256
}

async function verifyDescriptor(config) {
  const url = requestUrl(config.origin, APK_DESCRIPTOR_PATH, `?revalidate=${Date.now().toString(36)}`)
  return boundedRequest(config, url, {
    headers: { Accept: 'application/json' },
    method: 'GET',
  }, 'DESCRIPTOR', async response => {
    requireResponseLocation(response, url, 'DESCRIPTOR')
    requireStatus(response, 200, 'DESCRIPTOR')
    if (!['application/json', 'application/manifest+json'].includes(mediaType(response))) {
      fail('DESCRIPTOR_MEDIA_TYPE_INVALID')
    }
    requireNoStore(response, 'DESCRIPTOR')
    requireNosniff(response, 'DESCRIPTOR')
    const { bytes } = await readBoundedBody(response, {
      label: 'DESCRIPTOR',
      limit: MAX_DESCRIPTOR_BYTES,
    })
    if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(bytes.toString('utf8', 0, 256))) {
      fail('DESCRIPTOR_HTML_REJECTED')
    }

    let descriptor
    try {
      descriptor = validateApkDescriptor(JSON.parse(bytes.toString('utf8')), {
        expectedIdentity: {
          applicationId: config.expectedDescriptor.applicationId,
          sourceRevision: config.expectedDescriptor.sourceRevision,
          versionCode: config.expectedDescriptor.versionCode,
          versionName: config.expectedDescriptor.versionName,
          signer: config.expectedDescriptor.signer,
        },
      })
    } catch {
      fail('DESCRIPTOR_INVALID')
    }
    if (!descriptorsEqual(descriptor, config.expectedDescriptor)) fail('DESCRIPTOR_RELEASE_MISMATCH')
    return descriptor
  })
}

function versionedApkUrl(config, descriptor) {
  return requestUrl(config.origin, descriptor.path, `?v=${descriptor.sha256}`)
}

async function verifyRange(config, descriptor, { start, end, expectedBytes, label }) {
  const url = versionedApkUrl(config, descriptor)
  return boundedRequest(config, url, {
    headers: { Range: `bytes=${start}-${end}` },
    method: 'GET',
  }, label, async response => {
    requireResponseLocation(response, url, label)
    requireStatus(response, 206, label)
    requireApkHeaders(response, label)
    const expectedLength = end - start + 1
    if (response.headers.get('content-range') !== `bytes ${start}-${end}/${descriptor.byteSize}`) {
      fail(`${label}_CONTENT_RANGE_INVALID`)
    }
    if (parseContentLength(response, label) !== expectedLength) fail(`${label}_CONTENT_LENGTH_INVALID`)
    const { byteSize, bytes } = await readBoundedBody(response, { label, limit: expectedLength })
    if (byteSize !== expectedLength) fail(`${label}_BODY_LENGTH_INVALID`)
    if (expectedBytes && !bytes.equals(expectedBytes)) fail(`${label}_BYTES_INVALID`)
    return bytes
  })
}

async function writeAll(file, chunk) {
  let offset = 0
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset)
    if (bytesWritten < 1) fail('APK_TEMP_WRITE_FAILED', 'external-verification-failure')
    offset += bytesWritten
  }
}

async function verifyFullApk(config, descriptor) {
  const url = versionedApkUrl(config, descriptor)
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vmt-apk-verify-'))
  const temporaryFile = path.join(temporaryDirectory, CANONICAL_APK_FILENAME)
  let file
  try {
    file = await open(temporaryFile, 'wx', 0o600)
    const hash = createHash('sha256')
    let prefix = Buffer.alloc(0)

    const result = await boundedRequest(config, url, { method: 'GET' }, 'APK', async response => {
      requireResponseLocation(response, url, 'APK')
      requireStatus(response, 200, 'APK')
      requireApkHeaders(response, 'APK')
      const contentLength = parseContentLength(response, 'APK', false)
      if (contentLength !== undefined && contentLength !== descriptor.byteSize) fail('APK_CONTENT_LENGTH_MISMATCH')
      const streamed = await readBoundedBody(response, {
        label: 'APK',
        limit: descriptor.byteSize,
        onChunk: async chunk => {
          if (prefix.length < ZIP_PREFIX.length) {
            prefix = Buffer.concat([prefix, chunk.subarray(0, ZIP_PREFIX.length - prefix.length)])
          }
          hash.update(chunk)
          await writeAll(file, chunk)
        },
      })
      return { byteSize: streamed.byteSize }
    })

    await file.close()
    file = undefined
    if (result.byteSize !== descriptor.byteSize) fail('APK_SIZE_MISMATCH')
    if (!prefix.equals(ZIP_PREFIX)) fail('APK_PREFIX_INVALID')
    const sha256 = hash.digest('hex')
    if (sha256 !== descriptor.sha256) fail('APK_DIGEST_MISMATCH')

    // Read back through a stream to prove the bounded temporary artifact is complete; it is never executed.
    let readBackBytes = 0
    await new Promise((resolve, reject) => {
      const stream = createReadStream(temporaryFile)
      stream.on('data', chunk => { readBackBytes += chunk.length })
      stream.once('end', resolve)
      stream.once('error', reject)
    })
    if (readBackBytes !== descriptor.byteSize) fail('APK_TEMP_SIZE_MISMATCH')
    return { byteSize: result.byteSize, sha256 }
  } catch (error) {
    if (error instanceof ApkReleaseVerificationError) throw error
    fail('APK_TEMPORARY_FILE_UNAVAILABLE', 'external-verification-failure')
  } finally {
    if (file) await file.close().catch(() => undefined)
    await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined)
  }
}

async function verifyDownloadMisses(config) {
  for (const pathname of MISSING_DOWNLOAD_PATHS) {
    const url = requestUrl(config.origin, pathname, '?release-verifier=1')
    await boundedRequest(config, url, { method: 'GET' }, 'DOWNLOAD_MISS', async response => {
      requireResponseLocation(response, url, 'DOWNLOAD_MISS')
      if (isRedirectStatus(response.status)) fail('DOWNLOAD_MISS_REDIRECT')
      if (response.status === 401 || response.status === 403) {
        fail('DOWNLOAD_MISS_AUTHORIZATION_UNAVAILABLE', 'external-verification-failure')
      }
      if (response.status >= 200 && response.status < 300) fail('DOWNLOAD_MISS_STATUS_INVALID')
      const { bytes } = await readBoundedBody(response, {
        label: 'DOWNLOAD_MISS',
        limit: MAX_AUXILIARY_BYTES,
      })
      const prefix = bytes.toString('utf8', 0, 512)
      if (mediaType(response) === 'text/html' || /<!doctype\s+html|<html\b/i.test(prefix)) {
        fail('DOWNLOAD_MISS_HTML_REJECTED')
      }
    })
  }
}

async function fetchAuxiliary(config, pathname, label, expectedStatus = 200) {
  const url = requestUrl(config.origin, pathname)
  return boundedRequest(config, url, { method: 'GET' }, label, async response => {
    requireResponseLocation(response, url, label)
    requireStatus(response, expectedStatus, label)
    return {
      bytes: (await readBoundedBody(response, { label, limit: MAX_AUXILIARY_BYTES })).bytes,
      mediaType: mediaType(response),
    }
  })
}

async function verifySpaAndPwa(config) {
  const spa = await fetchAuxiliary(config, '/login', 'SPA')
  if (spa.mediaType !== 'text/html' || !/<!doctype\s+html|<html\b/i.test(spa.bytes.toString('utf8', 0, 1024))) {
    fail('SPA_SHELL_INVALID')
  }

  const manifestResponse = await fetchAuxiliary(config, '/manifest.json', 'MANIFEST')
  if (!['application/json', 'application/manifest+json'].includes(manifestResponse.mediaType)) {
    fail('MANIFEST_MEDIA_TYPE_INVALID')
  }
  let manifest
  try {
    manifest = JSON.parse(manifestResponse.bytes.toString('utf8'))
  } catch {
    fail('MANIFEST_INVALID')
  }
  if (!Array.isArray(manifest.icons) || manifest.icons.length < 1 || manifest.icons.length > 32) {
    fail('MANIFEST_ICONS_INVALID')
  }
  const iconPaths = [...new Set(manifest.icons.map(icon => icon?.src))]
  for (const iconPath of iconPaths) {
    if (typeof iconPath !== 'string' || !iconPath.startsWith('/icons/') || iconPath.includes('..')) {
      fail('MANIFEST_ICON_PATH_INVALID')
    }
    const icon = await fetchAuxiliary(config, iconPath, 'ICON')
    if (!icon.mediaType.startsWith('image/') || icon.bytes.length < 1) fail('ICON_INVALID')
  }

  const worker = await fetchAuxiliary(config, '/sw.js', 'SERVICE_WORKER')
  if (!['application/javascript', 'text/javascript'].includes(worker.mediaType)) {
    fail('SERVICE_WORKER_MEDIA_TYPE_INVALID')
  }
  const source = worker.bytes.toString('utf8')
  const fetchListenerIndex = source.search(/self\.addEventListener\(\s*['"]fetch['"]/)
  if (fetchListenerIndex < 0) fail('SERVICE_WORKER_FETCH_HANDLER_MISSING')
  const fetchHandler = source.slice(fetchListenerIndex)
  const bypassIndex = fetchHandler.search(/if\s*\(\s*url\.pathname\.startsWith\(\s*['"]\/downloads\/['"]\s*\)\s*\)\s*return\b/)
  const respondWithIndex = fetchHandler.indexOf('event.respondWith')
  if (bypassIndex < 0 || respondWithIndex < 0 || bypassIndex > respondWithIndex) {
    fail('SERVICE_WORKER_DOWNLOAD_BYPASS_INVALID')
  }
}

export async function verifyApkReleaseOrigin(options) {
  const config = validateOptions({
    bodyTimeoutMs: DEFAULT_BODY_TIMEOUT_MS,
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    fetchImpl: globalThis.fetch,
    ...options,
  })
  const descriptor = await verifyDescriptor(config)
  await verifyRange(config, descriptor, {
    end: 3,
    expectedBytes: ZIP_PREFIX,
    label: 'APK_PREFIX_RANGE',
    start: 0,
  })
  const finalOffset = descriptor.byteSize - 1
  await verifyRange(config, descriptor, {
    end: finalOffset,
    label: 'APK_TAIL_RANGE',
    start: finalOffset,
  })
  const artifact = await verifyFullApk(config, descriptor)
  await verifyDownloadMisses(config)
  await verifySpaAndPwa(config)

  return Object.freeze({
    status: 'verified',
    mode: config.mode,
    origin: config.origin,
    path: descriptor.path,
    sourceRevision: descriptor.sourceRevision,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
  })
}

async function loadExpectedDescriptor(filePath) {
  const absolutePath = path.resolve(filePath)
  let metadata
  try {
    metadata = await lstat(absolutePath)
  } catch {
    fail('EXPECTED_DESCRIPTOR_FILE_MISSING')
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_DESCRIPTOR_BYTES) {
    fail('EXPECTED_DESCRIPTOR_FILE_INVALID')
  }
  let value
  try {
    value = JSON.parse(await readFile(absolutePath, 'utf8'))
  } catch {
    fail('EXPECTED_DESCRIPTOR_FILE_INVALID')
  }
  try {
    return validateApkDescriptor(value)
  } catch {
    fail('EXPECTED_DESCRIPTOR_FILE_INVALID')
  }
}

function parseCliArguments(argv) {
  const values = new Map()
  const allowed = new Set([
    '--body-timeout-ms',
    '--connect-timeout-ms',
    '--expected-descriptor',
    '--mode',
    '--origin',
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(key) || value === undefined || values.has(key)) fail('ARGUMENTS_INVALID')
    values.set(key, value)
  }
  if (!values.has('--origin') || !values.has('--mode') || !values.has('--expected-descriptor')) {
    fail('ARGUMENTS_INVALID')
  }
  const integer = (key, fallback) => {
    if (!values.has(key)) return fallback
    if (!/^\d+$/.test(values.get(key))) fail('ARGUMENTS_INVALID')
    return Number(values.get(key))
  }
  return {
    bodyTimeoutMs: integer('--body-timeout-ms', DEFAULT_BODY_TIMEOUT_MS),
    connectTimeoutMs: integer('--connect-timeout-ms', DEFAULT_CONNECT_TIMEOUT_MS),
    expectedDescriptorPath: values.get('--expected-descriptor'),
    mode: values.get('--mode'),
    origin: values.get('--origin'),
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  let safeOrigin
  try {
    const args = parseCliArguments(process.argv.slice(2))
    try {
      const parsedOrigin = new URL(args.origin)
      if (['http:', 'https:'].includes(parsedOrigin.protocol)) safeOrigin = parsedOrigin.origin
    } catch {
      // Invalid origins are reported by a stable code without echoing raw input.
    }
    const expectedDescriptor = await loadExpectedDescriptor(args.expectedDescriptorPath || DEFAULT_EXPECTED_DESCRIPTOR)
    const result = await verifyApkReleaseOrigin({
      bodyTimeoutMs: args.bodyTimeoutMs,
      connectTimeoutMs: args.connectTimeoutMs,
      expectedDescriptor,
      mode: args.mode,
      origin: args.origin,
    })
    console.log(JSON.stringify(result))
  } catch (error) {
    const known = error instanceof ApkReleaseVerificationError
    console.error(JSON.stringify({
      status: 'failed',
      classification: known ? error.classification : 'release-regression',
      code: known ? error.code : 'RELEASE_VERIFICATION_FAILED',
      ...(safeOrigin ? { origin: safeOrigin } : {}),
    }))
    process.exitCode = 1
  }
}
