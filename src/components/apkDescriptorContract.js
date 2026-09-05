export const APK_DESCRIPTOR_PATH = '/downloads/vivek-marco-trader.apk.json'
export const CANONICAL_APK_PATH = APK_DESCRIPTOR_PATH.slice(0, -'.json'.length)
export const CANONICAL_APK_FILENAME = CANONICAL_APK_PATH.slice(CANONICAL_APK_PATH.lastIndexOf('/') + 1)
export const CANONICAL_APK_MEDIA_TYPE = 'application/vnd.android.package-archive'
export const APK_DESCRIPTOR_SCHEMA_VERSION = 2
export const MIN_APK_BYTE_SIZE = 1024 * 1024
export const MAX_APK_BYTE_SIZE = 200 * 1024 * 1024

const DESCRIPTOR_KEYS = Object.freeze([
  'applicationId',
  'byteSize',
  'filename',
  'mediaType',
  'path',
  'schemaVersion',
  'sha256',
  'signer',
  'sourceRevision',
  'versionCode',
  'versionName',
])
const SIGNER_KEYS = Object.freeze(['certificateSha256', 'classification'])
const IDENTITY_KEYS = Object.freeze([
  'applicationId',
  'sourceRevision',
  'versionCode',
  'versionName',
])

export class ApkDescriptorValidationError extends TypeError {
  constructor(code) {
    super(`Invalid APK descriptor: ${code}`)
    this.name = 'ApkDescriptorValidationError'
    this.code = code
  }
}

function reject(code) {
  throw new ApkDescriptorValidationError(code)
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false
  const actualKeys = Object.keys(value).sort()
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
}

function assertExpectedIdentity(descriptor, expectedIdentity) {
  if (expectedIdentity === undefined) return
  if (!isRecord(expectedIdentity)) reject('expected-identity')

  const allowedKeys = new Set([...IDENTITY_KEYS, 'signer'])
  for (const key of Object.keys(expectedIdentity)) {
    if (!allowedKeys.has(key)) reject('expected-identity-field')
  }

  for (const key of IDENTITY_KEYS) {
    if (Object.hasOwn(expectedIdentity, key) && descriptor[key] !== expectedIdentity[key]) {
      reject(`stale-${key}`)
    }
  }

  if (Object.hasOwn(expectedIdentity, 'signer')) {
    const expectedSigner = expectedIdentity.signer
    if (!isRecord(expectedSigner)) reject('expected-signer')
    for (const key of Object.keys(expectedSigner)) {
      if (!SIGNER_KEYS.includes(key)) reject('expected-signer-field')
      if (descriptor.signer[key] !== expectedSigner[key]) reject(`stale-signer-${key}`)
    }
  }
}

export function validateApkDescriptor(value, options = {}) {
  if (!isRecord(options)) reject('options')
  for (const key of Object.keys(options)) {
    if (key !== 'expectedIdentity') reject('option-field')
  }

  if (!hasExactKeys(value, DESCRIPTOR_KEYS)) reject('fields')
  if (value.schemaVersion !== APK_DESCRIPTOR_SCHEMA_VERSION) reject('schema-version')
  if (value.path !== CANONICAL_APK_PATH) reject('path')
  if (value.filename !== CANONICAL_APK_FILENAME) reject('filename')
  if (value.path.slice(value.path.lastIndexOf('/') + 1) !== value.filename) reject('path-filename')
  if (value.mediaType !== CANONICAL_APK_MEDIA_TYPE) reject('media-type')
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(value.applicationId)) reject('application-id')
  if (!Number.isSafeInteger(value.versionCode) || value.versionCode < 1 || value.versionCode > 2_147_483_647) reject('version-code')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value.versionName)) reject('version-name')
  if (!/^[0-9a-f]{40}$/.test(value.sourceRevision)) reject('source-revision')
  if (!Number.isSafeInteger(value.byteSize)
    || value.byteSize < MIN_APK_BYTE_SIZE
    || value.byteSize > MAX_APK_BYTE_SIZE) reject('byte-size')
  if (!/^[0-9a-f]{64}$/.test(value.sha256)) reject('sha256')
  if (!hasExactKeys(value.signer, SIGNER_KEYS)) reject('signer-fields')
  if (value.signer.classification !== 'approved-release') reject('signer-classification')
  if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value.signer.certificateSha256)) reject('signer-certificate')

  assertExpectedIdentity(value, options.expectedIdentity)

  return Object.freeze({
    schemaVersion: value.schemaVersion,
    path: value.path,
    filename: value.filename,
    mediaType: value.mediaType,
    applicationId: value.applicationId,
    versionCode: value.versionCode,
    versionName: value.versionName,
    sourceRevision: value.sourceRevision,
    byteSize: value.byteSize,
    sha256: value.sha256,
    signer: Object.freeze({
      classification: value.signer.classification,
      certificateSha256: value.signer.certificateSha256,
    }),
  })
}

export function deriveAndroidApkUrl(value, applicationOrigin, options = {}) {
  const descriptor = validateApkDescriptor(value, options)
  if (typeof applicationOrigin !== 'string') reject('application-origin')

  let origin
  try {
    const parsed = new URL(applicationOrigin)
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.origin !== applicationOrigin) reject('application-origin')
    origin = parsed.origin
  } catch (error) {
    if (error instanceof ApkDescriptorValidationError) throw error
    reject('application-origin')
  }

  const url = new URL(descriptor.path, `${origin}/`)
  if (url.origin !== origin
    || url.pathname !== CANONICAL_APK_PATH
    || url.pathname.slice(url.pathname.lastIndexOf('/') + 1) !== descriptor.filename
    || url.search
    || url.hash) reject('derived-url')

  return Object.freeze({ descriptor, url: url.href })
}
