import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APK_DESCRIPTOR_PATH,
  ApkDescriptorValidationError,
  deriveAndroidApkUrl,
  validateApkDescriptor,
} from '../src/components/apkDescriptorContract.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const descriptorFile = path.join(root, 'public', APK_DESCRIPTOR_PATH.slice(1))
const apkFile = path.join(root, 'public', 'downloads', 'vivek-marco-trader.apk')

async function readCanonicalDescriptor() {
  return JSON.parse(await readFile(descriptorFile, 'utf8'))
}

function clone(value) {
  return structuredClone(value)
}

function expectInvalid(value, code, options) {
  assert.throws(
    () => validateApkDescriptor(value, options),
    error => error instanceof ApkDescriptorValidationError && error.code === code,
  )
}

test('canonical schema-v2 descriptor validates and derives only the exact same-origin APK URL', async () => {
  const source = await readCanonicalDescriptor()
  const descriptor = validateApkDescriptor(source, {
    expectedIdentity: {
      applicationId: source.applicationId,
      versionCode: source.versionCode,
      versionName: source.versionName,
      sourceRevision: source.sourceRevision,
      signer: source.signer,
    },
  })

  assert.notEqual(descriptor, source)
  assert.equal(Object.isFrozen(descriptor), true)
  assert.equal(Object.isFrozen(descriptor.signer), true)
  assert.deepEqual(Object.keys(descriptor).sort(), [
    'applicationId', 'byteSize', 'filename', 'mediaType', 'path', 'schemaVersion',
    'sha256', 'signer', 'sourceRevision', 'versionCode', 'versionName',
  ])
  assert.deepEqual(deriveAndroidApkUrl(source, 'https://app.example'), {
    descriptor,
    url: 'https://app.example/downloads/vivek-marco-trader.apk',
  })

  expectInvalid(source, 'option-field', { expectedIdentity: undefined, extra: true })
  assert.throws(
    () => deriveAndroidApkUrl(source, 'https://user:password@app.example'),
    error => error instanceof ApkDescriptorValidationError && error.code === 'application-origin',
  )
})

test('strict validation rejects missing, extra, malformed, unsafe, stale, and unapproved descriptor data', async () => {
  const valid = await readCanonicalDescriptor()
  const cases = [
    ['fields', value => { delete value.path }],
    ['fields', value => { value.localPath = 'C:\\Users\\example\\release.apk' }],
    ['schema-version', value => { value.schemaVersion = 1 }],
    ['path', value => { value.path = '/downloads/Vivek-Marco-Trader.apk' }],
    ['path', value => { value.path = '/downloads/../private/release.apk' }],
    ['path', value => { value.path = '/downloads/%76ivek-marco-trader.apk' }],
    ['path', value => { value.path = 'https://cdn.example/vivek-marco-trader.apk' }],
    ['filename', value => { value.filename = '../vivek-marco-trader.apk' }],
    ['media-type', value => { value.mediaType = 'text/html' }],
    ['application-id', value => { value.applicationId = 'C:\\local\\app' }],
    ['version-code', value => { value.versionCode = 0 }],
    ['version-code', value => { value.versionCode = 3.5 }],
    ['version-name', value => { value.versionName = '../../1.0.2' }],
    ['source-revision', value => { value.sourceRevision = 'A'.repeat(40) }],
    ['source-revision', value => { value.sourceRevision = 'token=not-a-revision' }],
    ['byte-size', value => { value.byteSize = 1_048_575 }],
    ['byte-size', value => { value.byteSize = 209_715_201 }],
    ['sha256', value => { value.sha256 = 'A'.repeat(64) }],
    ['sha256', value => { value.sha256 = 'secret-token' }],
    ['signer-fields', value => { value.signer.privateKey = 'not-allowed' }],
    ['signer-classification', value => { value.signer.classification = 'debug' }],
    ['signer-certificate', value => { value.signer.certificateSha256 = 'a'.repeat(64) }],
  ]

  for (const [code, mutate] of cases) {
    const candidate = clone(valid)
    mutate(candidate)
    expectInvalid(candidate, code)
  }

  for (const [field, staleValue] of [
    ['applicationId', 'com.example.other'],
    ['versionCode', valid.versionCode + 1],
    ['versionName', '9.9.9'],
    ['sourceRevision', 'f'.repeat(40)],
  ]) {
    expectInvalid(valid, `stale-${field}`, { expectedIdentity: { [field]: staleValue } })
  }

  expectInvalid(valid, 'stale-signer-certificateSha256', {
    expectedIdentity: {
      signer: { certificateSha256: 'AA:'.repeat(31) + 'AA' },
    },
  })
})

test('canonical descriptor size and digest identify the reviewed public APK bytes', async () => {
  const descriptor = validateApkDescriptor(await readCanonicalDescriptor())
  const apk = await readFile(apkFile)

  assert.equal(apk.length, descriptor.byteSize)
  assert.equal(createHash('sha256').update(apk).digest('hex'), descriptor.sha256)
  assert.deepEqual([...apk.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
})
