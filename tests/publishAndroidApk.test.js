import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ApkPublicationError,
  hashReleaseFile,
  publishAndroidApk,
  selectReleaseCandidate,
} from '../scripts/publish-android-apk.mjs'

const SOURCE_REVISION = 'a354ae432ed8139e501b57ef1e0fd1c93ee51b91'
const APPLICATION_ID = 'com.vivekmarco.trader'
const VERSION_CODE = 3
const VERSION_NAME = '1.0.2'
const SIGNER_FINGERPRINT = '5E:15:FD:1B:BA:A7:C3:AE:CC:BF:67:71:0F:DC:E2:E1:45:CE:B7:01:A8:62:A6:EB:ED:E2:FA:3A:F4:9F:1B:5E'
const APK_BYTES = (() => {
  const value = Buffer.alloc(1024 * 1024 + 64, 0x41)
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(value)
  return value
})()

function validMetadata(overrides = {}) {
  return {
    version: 3,
    artifactType: { type: 'APK', kind: 'Directory' },
    applicationId: APPLICATION_ID,
    variantName: 'release',
    elements: [{
      type: 'SINGLE',
      filters: [],
      attributes: [],
      versionCode: VERSION_CODE,
      versionName: VERSION_NAME,
      outputFile: 'app-release.apk',
    }],
    elementType: 'File',
    ...overrides,
  }
}

function publicationOptions(fixture, overrides = {}) {
  return {
    metadataPath: fixture.metadataPath,
    destinationDirectory: fixture.destinationDirectory,
    distPath: fixture.distPath,
    sourceRevision: SOURCE_REVISION,
    applicationId: APPLICATION_ID,
    versionCode: VERSION_CODE,
    versionName: VERSION_NAME,
    label: 'Vivek Marco Trader',
    launchableActivity: 'com.vivekmarco.trader.MainActivity',
    minSdk: 24,
    targetSdk: 36,
    compileSdk: 36,
    signerFingerprint: SIGNER_FINGERPRINT,
    signerClassification: 'approved-release',
    sdkRoot: fixture.sdkRoot,
    javaHome: fixture.javaHome,
    ...overrides,
  }
}

async function createFixture(metadata = validMetadata()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmt-apk-publication-'))
  const releaseDirectory = path.join(root, 'isolated-release', 'release')
  const destinationDirectory = path.join(root, 'public', 'downloads')
  const distPath = path.join(root, 'dist')
  const sdkRoot = path.join(root, 'sdk')
  const javaHome = path.join(root, 'java')
  await Promise.all([
    mkdir(releaseDirectory, { recursive: true }),
    mkdir(destinationDirectory, { recursive: true }),
    mkdir(distPath, { recursive: true }),
    mkdir(sdkRoot, { recursive: true }),
    mkdir(javaHome, { recursive: true }),
  ])
  const metadataPath = path.join(releaseDirectory, 'output-metadata.json')
  const candidatePath = path.join(releaseDirectory, 'app-release.apk')
  await writeFile(metadataPath, JSON.stringify(metadata), 'utf8')
  await writeFile(candidatePath, APK_BYTES)
  return { root, releaseDirectory, destinationDirectory, distPath, sdkRoot, javaHome, metadataPath, candidatePath }
}

async function approvedInspection(candidatePath) {
  const streamed = await hashReleaseFile(candidatePath)
  return {
    schemaVersion: 1,
    status: 'pass',
    sourceRevision: SOURCE_REVISION,
    artifact: {
      filename: 'app-release.apk',
      applicationId: APPLICATION_ID,
      versionCode: VERSION_CODE,
      versionName: VERSION_NAME,
      signer: {
        classification: 'approved-release',
        certificateSha256: SIGNER_FINGERPRINT,
      },
      byteSize: streamed.byteSize,
      sha256: streamed.sha256,
    },
    outcomes: { archiveIntegrity: 'pass', signature: 'pass', sensitiveContent: 'pass' },
  }
}

async function expectCode(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ApkPublicationError)
    assert.equal(error.code, code)
    return true
  })
}

async function seedPreviousPair(destinationDirectory) {
  await writeFile(path.join(destinationDirectory, 'vivek-marco-trader.apk'), 'previous-apk', 'utf8')
  await writeFile(path.join(destinationDirectory, 'vivek-marco-trader.apk.json'), 'previous-descriptor', 'utf8')
}

async function assertPreviousPair(destinationDirectory) {
  assert.equal(await readFile(path.join(destinationDirectory, 'vivek-marco-trader.apk'), 'utf8'), 'previous-apk')
  assert.equal(await readFile(path.join(destinationDirectory, 'vivek-marco-trader.apk.json'), 'utf8'), 'previous-descriptor')
}

test('selects only the one explicit unfiltered release APK from output metadata', async () => {
  // **Validates: Requirements 2.2, 2.3, 2.8, 3.6, 3.7**
  const fixture = await createFixture()
  try {
    const selected = await selectReleaseCandidate(publicationOptions(fixture))
    assert.equal(selected.metadataPath, fixture.metadataPath)
    assert.equal(selected.candidatePath, fixture.candidatePath)
    assert.equal(selected.sourceFilename, 'app-release.apk')
    assert.equal(selected.byteSize, APK_BYTES.length)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('fails closed for ambiguous, stale, filtered, non-release, and unsafe metadata outputs', async t => {
  // **Validates: Requirements 2.2, 2.3, 2.8, 3.6, 3.7**
  const cases = [
    ['multiple elements', metadata => ({ ...metadata, elements: [...metadata.elements, { ...metadata.elements[0], outputFile: 'other-release.apk' }] }), 'ELEMENT_COUNT_INVALID'],
    ['filtered split', metadata => ({ ...metadata, elements: [{ ...metadata.elements[0], filters: [{ filterType: 'ABI', value: 'arm64-v8a' }] }] }), 'FILTERED_APK_INVALID'],
    ['debug variant', metadata => ({ ...metadata, variantName: 'debug' }), 'VARIANT_INVALID'],
    ['stale version', metadata => ({ ...metadata, elements: [{ ...metadata.elements[0], versionName: '1.0.0' }] }), 'VERSION_MISMATCH'],
    ['traversal', metadata => ({ ...metadata, elements: [{ ...metadata.elements[0], outputFile: '../app-release.apk' }] }), 'OUTPUT_FILE_UNSAFE'],
    ['absolute path', metadata => ({ ...metadata, elements: [{ ...metadata.elements[0], outputFile: path.resolve('app-release.apk') }] }), 'OUTPUT_FILE_UNSAFE'],
    ['debug artifact', metadata => ({ ...metadata, elements: [{ ...metadata.elements[0], outputFile: 'app-debug.apk' }] }), 'OUTPUT_FILE_UNSAFE'],
    ['instrumentation test artifact', metadata => ({ ...metadata, elements: [{ ...metadata.elements[0], outputFile: 'app-release-androidTest.apk' }] }), 'OUTPUT_FILE_UNSAFE'],
    ['bundle output', metadata => ({ ...metadata, artifactType: { type: 'AAB', kind: 'Directory' } }), 'ARTIFACT_TYPE_INVALID'],
  ]

  for (const [name, mutate, code] of cases) {
    await t.test(name, async () => {
      const metadata = mutate(validMetadata())
      const fixture = await createFixture(metadata)
      try {
        await expectCode(() => selectReleaseCandidate(publicationOptions(fixture)), code)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    })
  }
})

test('rejects a metadata-selected APK symlink or reparse-point candidate', async t => {
  const fixture = await createFixture()
  const actualApk = path.join(fixture.releaseDirectory, 'actual-release.apk')
  try {
    await writeFile(actualApk, APK_BYTES)
    await rm(fixture.candidatePath)
    try {
      await symlink(actualApk, fixture.candidatePath, 'file')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('This environment does not permit creation of a synthetic file symlink')
        return
      }
      throw error
    }
    await expectCode(() => selectReleaseCandidate(publicationOptions(fixture)), 'APK_UNSAFE')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('publishes only a canonical APK and schema-v2 descriptor after inspection and scanning', async () => {
  // **Validates: Requirements 2.2, 2.3, 2.8, 3.5, 3.6, 3.7, 3.8**
  const fixture = await createFixture()
  const inspectionArguments = []
  const scanSelections = []
  try {
    const result = await publishAndroidApk(publicationOptions(fixture, {
      dependencies: {
        inspect: async args => {
          inspectionArguments.push(args)
          return approvedInspection(fixture.candidatePath)
        },
        scan: async paths => {
          scanSelections.push(paths)
          return { checked: paths.length, findings: [] }
        },
      },
    }))

    const inventory = (await import('node:fs/promises')).readdir(fixture.destinationDirectory)
    assert.deepEqual((await inventory).sort(), ['vivek-marco-trader.apk', 'vivek-marco-trader.apk.json'])
    assert.deepEqual(await readFile(result.apkPath), APK_BYTES)
    const descriptor = JSON.parse(await readFile(result.descriptorPath, 'utf8'))
    const streamed = await hashReleaseFile(fixture.candidatePath)
    assert.deepEqual(descriptor, {
      schemaVersion: 2,
      path: '/downloads/vivek-marco-trader.apk',
      filename: 'vivek-marco-trader.apk',
      mediaType: 'application/vnd.android.package-archive',
      applicationId: APPLICATION_ID,
      versionCode: VERSION_CODE,
      versionName: VERSION_NAME,
      sourceRevision: SOURCE_REVISION,
      byteSize: streamed.byteSize,
      sha256: streamed.sha256,
      signer: {
        classification: 'approved-release',
        certificateSha256: SIGNER_FINGERPRINT,
      },
    })
    assert.equal(inspectionArguments.length, 1)
    assert.deepEqual(inspectionArguments[0].slice(0, 2), ['--apk', fixture.candidatePath])
    assert.equal(scanSelections.length, 1)
    assert.equal(scanSelections[0].length, 2)
    assert.equal(scanSelections[0][0], fixture.candidatePath)
    assert.match(scanSelections[0][1], /vivek-marco-trader\.apk\.json$/u)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('retains the prior reviewed pair when inspection or secret scanning fails', async t => {
  // **Validates: Requirements 2.8, 3.6, 3.7, 3.8**
  for (const [name, dependencies, code] of [
    ['inspection', { inspect: async () => { throw new ApkPublicationError('INSPECTOR_REJECTED', 'inspection') } }, 'INSPECTOR_REJECTED'],
    ['secret scan', {
      inspect: async (_args, fixture) => approvedInspection(fixture.candidatePath),
      scan: async () => ({ checked: 2, findings: [{ path: '<sanitized>', category: 'fixture' }] }),
    }, 'SECRET_SCAN_FAILED'],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture()
      await seedPreviousPair(fixture.destinationDirectory)
      try {
        const resolvedDependencies = name === 'secret scan'
          ? {
              inspect: args => dependencies.inspect(args, fixture),
              scan: dependencies.scan,
            }
          : dependencies
        await expectCode(() => publishAndroidApk(publicationOptions(fixture, { dependencies: resolvedDependencies })), code)
        await assertPreviousPair(fixture.destinationDirectory)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    })
  }
})

test('rolls back both files when descriptor-last commit fails after APK replacement', async () => {
  // **Validates: Requirements 2.8, 3.6, 3.7, 3.8**
  const fixture = await createFixture()
  await seedPreviousPair(fixture.destinationDirectory)
  let injected = false
  const { rename: realRename, rm: realRm } = await import('node:fs/promises')
  try {
    await expectCode(() => publishAndroidApk(publicationOptions(fixture, {
      dependencies: {
        inspect: async () => approvedInspection(fixture.candidatePath),
        scan: async paths => ({ checked: paths.length, findings: [] }),
      },
      fileOperations: {
        rename: async (source, destination) => {
          if (!injected
            && path.basename(destination) === 'vivek-marco-trader.apk.json'
            && path.basename(source) === 'vivek-marco-trader.apk.json') {
            injected = true
            throw new Error('synthetic descriptor commit failure')
          }
          return realRename(source, destination)
        },
        rm: realRm,
      },
    })), 'PUBLICATION_COMMIT_FAILED')
    assert.equal(injected, true)
    await assertPreviousPair(fixture.destinationDirectory)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects a partial or unexpected destination inventory without modifying it', async t => {
  for (const [name, seed, code] of [
    ['partial pair', async directory => writeFile(path.join(directory, 'vivek-marco-trader.apk'), 'old'), 'DESTINATION_PAIR_INCOMPLETE'],
    ['unexpected file', async directory => writeFile(path.join(directory, 'debug.apk'), 'unsafe'), 'DESTINATION_INVENTORY_INVALID'],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture()
      await seed(fixture.destinationDirectory)
      try {
        await expectCode(() => publishAndroidApk(publicationOptions(fixture, {
          dependencies: {
            inspect: async () => approvedInspection(fixture.candidatePath),
            scan: async paths => ({ checked: paths.length, findings: [] }),
          },
        })), code)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    })
  }
})

test('Property: generated release inventories never displace the explicit metadata-selected APK', async () => {
  // **Validates: Requirements 2.2, 2.3, 2.8, 3.6, 3.7**
  const fixture = await createFixture()
  const decoys = [
    'app-debug.apk',
    'app-profile.apk',
    'app-release-androidTest.apk',
    'release.aab',
    'baseline.dm',
    'mapping.txt',
    'bundle.js.map',
    'build.log',
    'google-services.json',
    'signing.properties',
    'release.keystore',
  ]

  try {
    for (let seed = 0; seed < decoys.length; seed += 1) {
      const name = decoys[seed]
      await writeFile(path.join(fixture.releaseDirectory, name), `synthetic-decoy-${seed}`, 'utf8')
      const selected = await selectReleaseCandidate(publicationOptions(fixture))
      assert.equal(selected.candidatePath, fixture.candidatePath, `${name} must not become the release candidate`)
      assert.equal(selected.sourceFilename, 'app-release.apk', `${name} must not alter release identity`)
    }

    const scanMarker = 'synthetic-secret-marker-must-not-escape'
    await assert.rejects(
      publishAndroidApk(publicationOptions(fixture, {
        dependencies: {
          inspect: async () => approvedInspection(fixture.candidatePath),
          scan: async () => ({
            checked: 2,
            findings: [{ path: '<sanitized>', category: scanMarker }],
          }),
        },
      })),
      error => {
        assert.ok(error instanceof ApkPublicationError)
        assert.equal(error.code, 'SECRET_SCAN_FAILED')
        assert.equal(error.outcome, 'security')
        assert.doesNotMatch(error.message, new RegExp(scanMarker, 'u'))
        assert.doesNotMatch(error.message, new RegExp(fixture.candidatePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
        return true
      },
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})