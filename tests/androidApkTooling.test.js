import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { inspectAndroidApk } from '../scripts/inspect-android-apk.mjs'
import { smokeAndroidApk } from '../scripts/smoke-android-apk.mjs'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apk = path.join(root, 'public', 'downloads', 'vivek-marco-trader.apk')
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vmt-apk-tooling-test-'))
let dist
const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || (
  process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : path.join(os.homedir(), 'Android', 'Sdk')
)
const javaHome = process.env.JAVA_HOME || (
  process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Android', 'Android Studio', 'jbr') : ''
)
const approvedReleaseFingerprint = '5E:15:FD:1B:BA:A7:C3:AE:CC:BF:67:71:0F:DC:E2:E1:45:CE:B7:01:A8:62:A6:EB:ED:E2:FA:3A:F4:9F:1B:5E'

before(async () => {
  const extractionRoot = path.join(temporaryRoot, 'packaged-production-assets')
  await mkdir(extractionRoot, { recursive: true })
  const jar = path.join(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar')
  await execFileAsync(jar, ['xf', apk, 'assets/public'], {
    cwd: extractionRoot,
    timeout: 30_000,
    windowsHide: true,
  })
  dist = path.join(extractionRoot, 'assets', 'public')
})

function inspectorArguments(overrides = {}) {
  const values = {
    apk,
    dist,
    'source-revision': 'a354ae432ed8139e501b57ef1e0fd1c93ee51b91',
    'application-id': 'com.vivekmarco.trader',
    'version-code': '3',
    'version-name': '1.0.2',
    label: 'Vivek Marco Trader',
    'launchable-activity': 'com.vivekmarco.trader.MainActivity',
    'min-sdk': '24',
    'target-sdk': '36',
    'compile-sdk': '36',
    'signer-fingerprint': approvedReleaseFingerprint,
    'signer-classification': 'approved-release',
    'sdk-root': sdkRoot,
    'java-home': javaHome,
    ...overrides,
  }
  return Object.entries(values).flatMap(([name, value]) => [`--${name}`, value])
}

function smokeArguments(extra = []) {
  return [
    '--apk', apk,
    '--application-id', 'com.vivekmarco.trader',
    '--activity', 'com.vivekmarco.trader.MainActivity',
    '--mode', 'fresh-install',
    '--sdk-root', sdkRoot,
    '--timeout-ms', '30000',
    ...extra,
  ]
}

async function rejectsWith(operation, code, outcome) {
  await assert.rejects(operation, error => {
    assert.equal(error?.code, code)
    if (outcome) assert.equal(error?.outcome, outcome)
    return true
  })
}

after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true })
})

test('positive APK inspection verifies approved release artifact and production assets', { timeout: 120_000 }, async () => {
  const report = await inspectAndroidApk(inspectorArguments())
  assert.equal(report.status, 'pass')
  assert.equal(report.sourceRevision, 'a354ae432ed8139e501b57ef1e0fd1c93ee51b91')
  assert.equal(report.artifact.byteSize, 5261539)
  assert.equal(report.artifact.sha256, '0289447d05d13138d512c5419db12e3ceb09db2e31a2a9454d957255c20be70c')
  assert.deepEqual(Object.values(report.outcomes), Array(Object.keys(report.outcomes).length).fill('pass'))
})

test('APK inspection rejects a missing file', async () => {
  await rejectsWith(
    () => inspectAndroidApk(inspectorArguments({ apk: path.join(temporaryRoot, 'missing.apk') })),
    'APK_MISSING',
    'archive',
  )
})

test('APK inspection rejects an empty file', async () => {
  const candidate = path.join(temporaryRoot, 'empty.apk')
  await writeFile(candidate, '')
  await rejectsWith(() => inspectAndroidApk(inspectorArguments({ apk: candidate })), 'APK_EMPTY', 'archive')
})

test('APK inspection rejects a corrupt ZIP-like APK', { timeout: 120_000 }, async () => {
  const candidate = path.join(temporaryRoot, 'corrupt.apk')
  await writeFile(candidate, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]))
  await rejectsWith(() => inspectAndroidApk(inspectorArguments({ apk: candidate })), 'ARCHIVE_INVALID', 'archive')
})

test('APK inspection rejects a non-APK filename', async () => {
  const candidate = path.join(temporaryRoot, 'not-an-apk.zip')
  await writeFile(candidate, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  await rejectsWith(() => inspectAndroidApk(inspectorArguments({ apk: candidate })), 'APK_EXTENSION_INVALID', 'archive')
})

test('APK inspection rejects wrong application identity', { timeout: 120_000 }, async () => {
  await rejectsWith(
    () => inspectAndroidApk(inspectorArguments({ 'application-id': 'com.example.wrong' })),
    'IDENTITY_MISMATCH',
    'identity',
  )
})

test('APK inspection rejects wrong signer fingerprint', { timeout: 120_000 }, async () => {
  await rejectsWith(
    () => inspectAndroidApk(inspectorArguments({ 'signer-fingerprint': '00'.repeat(32) })),
    'SIGNER_MISMATCH',
    'signature',
  )
})

test('APK inspection rejects a modified signed archive', { timeout: 120_000 }, async () => {
  const candidate = path.join(temporaryRoot, 'signature-modified.apk')
  const updateRoot = path.join(temporaryRoot, 'signature-update')
  await copyFile(apk, candidate)
  await mkdir(path.join(updateRoot, 'assets', 'public'), { recursive: true })
  await writeFile(path.join(updateRoot, 'assets', 'public', 'index.html'), '<!doctype html><title>modified fixture</title>', 'utf8')
  const jar = path.join(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar')
  await execFileAsync(jar, ['uf', candidate, 'assets/public/index.html'], {
    cwd: updateRoot,
    timeout: 30_000,
    windowsHide: true,
  })
  await rejectsWith(() => inspectAndroidApk(inspectorArguments({ apk: candidate })), 'SIGNATURE_INVALID', 'signature')
})

test('APK inspection rejects mismatched production assets', { timeout: 120_000 }, async () => {
  const changedDist = path.join(temporaryRoot, 'changed-dist')
  await cp(dist, changedDist, { recursive: true })
  await writeFile(path.join(changedDist, 'index.html'), '<!doctype html><title>different production fixture</title>', 'utf8')
  await rejectsWith(
    () => inspectAndroidApk(inspectorArguments({ dist: changedDist })),
    'PRODUCTION_ASSET_MISMATCH',
    'assets',
  )
})

test('APK inspection rejects sensitive files in production assets', { timeout: 120_000 }, async () => {
  const sensitiveDist = path.join(temporaryRoot, 'sensitive-dist')
  await cp(dist, sensitiveDist, { recursive: true })
  await writeFile(path.join(sensitiveDist, '.env.fixture'), 'fixture-only', 'utf8')
  await rejectsWith(
    () => inspectAndroidApk(inspectorArguments({ dist: sensitiveDist })),
    'SENSITIVE_ASSET_PRESENT',
    'assets',
  )
})

test('device smoke rejects unsafe activity and serial arguments before adb use', async () => {
  await rejectsWith(() => smokeAndroidApk(smokeArguments(['--activity', 'MainActivity;whoami'])), 'ARGUMENTS_INVALID', 'input')
  await rejectsWith(() => smokeAndroidApk(smokeArguments(['--serial', 'device & whoami'])), 'SERIAL_INVALID', 'input')
})

test('device smoke reports a bounded skipped status for an unauthorized explicit target', { timeout: 60_000 }, async () => {
  await assert.rejects(
    () => smokeAndroidApk(smokeArguments(['--serial', 'vmt-intentionally-absent-target'])),
    error => {
      assert.equal(error?.skipped, true)
      assert.equal(error?.code, 'TARGET_NOT_AUTHORIZED')
      assert.equal(error?.outcome, 'target')
      return true
    },
  )
})
