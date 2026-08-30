import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MIN_APK_BYTE_SIZE,
  validateApkDescriptor,
} from '../src/components/apkDescriptorContract.js'
import {
  ViteApkArtifactError,
  verifyViteApkArtifacts,
} from '../scripts/verify-vite-apk-artifacts.mjs'

const APK_FILENAME = 'vivek-marco-trader.apk'
const DESCRIPTOR_FILENAME = `${APK_FILENAME}.json`
const SOURCE_REVISION = 'a'.repeat(40)
const CERTIFICATE_SHA256 = Array.from({ length: 32 }, () => 'AB').join(':')

function createApkBytes() {
  const bytes = Buffer.alloc(MIN_APK_BYTE_SIZE + 32, 0x5a)
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(bytes)
  return bytes
}

function createDescriptor(apk) {
  return {
    schemaVersion: 2,
    path: '/downloads/vivek-marco-trader.apk',
    filename: APK_FILENAME,
    mediaType: 'application/vnd.android.package-archive',
    applicationId: 'com.vivekmarco.trader',
    versionCode: 3,
    versionName: '1.0.2',
    sourceRevision: SOURCE_REVISION,
    byteSize: apk.length,
    sha256: createHash('sha256').update(apk).digest('hex'),
    signer: {
      classification: 'approved-release',
      certificateSha256: CERTIFICATE_SHA256,
    },
  }
}

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vite-apk-gate-'))
  const publicDirectory = path.join(directory, 'public', 'downloads')
  const distDirectory = path.join(directory, 'dist', 'downloads')
  await Promise.all([
    mkdir(publicDirectory, { recursive: true }),
    mkdir(distDirectory, { recursive: true }),
  ])

  const apk = createApkBytes()
  const descriptor = createDescriptor(apk)
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)
  await Promise.all([
    writeFile(path.join(publicDirectory, APK_FILENAME), apk),
    writeFile(path.join(distDirectory, APK_FILENAME), apk),
    writeFile(path.join(publicDirectory, DESCRIPTOR_FILENAME), descriptorBytes),
    writeFile(path.join(distDirectory, DESCRIPTOR_FILENAME), descriptorBytes),
  ])

  return {
    apk,
    descriptor,
    descriptorBytes,
    distDirectory,
    publicDirectory,
    remove: () => rm(directory, { force: true, recursive: true }),
  }
}

async function expectGateFailure(fixture, code) {
  await assert.rejects(
    verifyViteApkArtifacts({
      publicDirectory: fixture.publicDirectory,
      distDirectory: fixture.distDirectory,
    }),
    error => error instanceof ViteApkArtifactError && error.code === code,
  )
}

test('artifact equality gate accepts only a byte-identical canonical public/dist release pair', async t => {
  const fixture = await createFixture()
  t.after(fixture.remove)

  assert.deepEqual(await verifyViteApkArtifacts({
    publicDirectory: fixture.publicDirectory,
    distDirectory: fixture.distDirectory,
    expectedIdentity: {
      applicationId: fixture.descriptor.applicationId,
      versionCode: fixture.descriptor.versionCode,
      versionName: fixture.descriptor.versionName,
      sourceRevision: fixture.descriptor.sourceRevision,
      signer: fixture.descriptor.signer,
    },
  }), {
    status: 'verified',
    sourceRevision: SOURCE_REVISION,
    byteSize: fixture.apk.length,
    sha256: fixture.descriptor.sha256,
    inventory: [APK_FILENAME, DESCRIPTOR_FILENAME],
  })
})

test('artifact equality gate rejects missing, unexpected, and case-different dist inventories', async t => {
  await t.test('unexpected file', async t => {
    const fixture = await createFixture()
    t.after(fixture.remove)
    await writeFile(path.join(fixture.distDirectory, 'debug.apk'), fixture.apk)
    await expectGateFailure(fixture, 'DIST_INVENTORY_INVALID')
  })

  await t.test('case-different APK name', async t => {
    const fixture = await createFixture()
    t.after(fixture.remove)
    await rename(
      path.join(fixture.distDirectory, APK_FILENAME),
      path.join(fixture.distDirectory, 'Vivek-Marco-Trader.apk'),
    )
    await expectGateFailure(fixture, 'DIST_INVENTORY_INVALID')
  })

  await t.test('missing descriptor', async t => {
    const fixture = await createFixture()
    t.after(fixture.remove)
    await rm(path.join(fixture.distDirectory, DESCRIPTOR_FILENAME))
    await expectGateFailure(fixture, 'DIST_INVENTORY_INVALID')
  })
})

test('artifact equality gate rejects descriptor-byte drift and unapproved identity', async t => {
  await t.test('descriptor bytes differ despite equivalent JSON', async t => {
    const fixture = await createFixture()
    t.after(fixture.remove)
    await writeFile(
      path.join(fixture.distDirectory, DESCRIPTOR_FILENAME),
      Buffer.from(` ${fixture.descriptorBytes.toString('utf8')}`),
    )
    await expectGateFailure(fixture, 'DIST_DESCRIPTOR_BYTES_MISMATCH')
  })

  await t.test('descriptor does not match approved identity', async t => {
    const fixture = await createFixture()
    t.after(fixture.remove)
    await assert.rejects(
      verifyViteApkArtifacts({
        publicDirectory: fixture.publicDirectory,
        distDirectory: fixture.distDirectory,
        expectedIdentity: { sourceRevision: 'b'.repeat(40) },
      }),
      error => error instanceof ViteApkArtifactError && error.code === 'PUBLIC_DESCRIPTOR_INVALID',
    )
  })

  await t.test('descriptor digest is stale for both artifacts', async t => {
    const fixture = await createFixture()
    t.after(fixture.remove)
    const stale = structuredClone(fixture.descriptor)
    stale.sha256 = 'f'.repeat(64)
    validateApkDescriptor(stale)
    const bytes = Buffer.from(`${JSON.stringify(stale, null, 2)}\n`)
    await Promise.all([
      writeFile(path.join(fixture.publicDirectory, DESCRIPTOR_FILENAME), bytes),
      writeFile(path.join(fixture.distDirectory, DESCRIPTOR_FILENAME), bytes),
    ])
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await assert.rejects(
        verifyViteApkArtifacts({
          publicDirectory: fixture.publicDirectory,
          distDirectory: fixture.distDirectory,
        }),
        error => {
          assert.ok(error instanceof ViteApkArtifactError, `attempt ${attempt}`)
          assert.equal(error.code, 'PUBLIC_APK_DIGEST_MISMATCH', `attempt ${attempt}`)
          return true
        },
      )
    }
  })
})

test('artifact equality gate rejects truncated, HTML, and mismatched APK bytes', async t => {
  await t.test('truncated artifact', async t => {
    const fixture = await createFixture()
    t.after(fixture.remove)
    await writeFile(path.join(fixture.distDirectory, APK_FILENAME), fixture.apk.subarray(0, fixture.apk.length - 1))
    await expectGateFailure(fixture, 'DIST_APK_SIZE_MISMATCH')
  })

  await t.test('HTML-sized response', async t => {
    const fixture = await createFixture()
    t.after(fixture.remove)
    const html = Buffer.alloc(fixture.apk.length, 0x20)
    Buffer.from('<!doctype html>').copy(html)
    const htmlDescriptor = createDescriptor(html)
    const descriptorBytes = Buffer.from(`${JSON.stringify(htmlDescriptor, null, 2)}\n`)
    await Promise.all([
      writeFile(path.join(fixture.publicDirectory, APK_FILENAME), html),
      writeFile(path.join(fixture.distDirectory, APK_FILENAME), html),
      writeFile(path.join(fixture.publicDirectory, DESCRIPTOR_FILENAME), descriptorBytes),
      writeFile(path.join(fixture.distDirectory, DESCRIPTOR_FILENAME), descriptorBytes),
    ])
    await expectGateFailure(fixture, 'PUBLIC_APK_PREFIX_INVALID')
  })

  await t.test('same-size dist byte mismatch', async t => {
    const fixture = await createFixture()
    t.after(fixture.remove)
    const changed = Buffer.from(fixture.apk)
    changed[changed.length - 1] ^= 0xff
    await writeFile(path.join(fixture.distDirectory, APK_FILENAME), changed)
    await expectGateFailure(fixture, 'DIST_APK_DIGEST_MISMATCH')
  })
})
