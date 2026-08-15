import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { formatReport, scanFiles } from '../scripts/scan-release-secrets.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wrapperJar = path.join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.jar')
const signingScript = path.join(root, 'android', 'app', 'release-signing.gradle')
const requiredToolchain = Boolean(process.env.JAVA_HOME && process.env.ANDROID_SDK_ROOT)
const approvedCertificateSha256 = 'BB996DAFB55BE208C0CE30782F5D22ED5E1674646175E1828B3583BD290C6483'

function sanitizedSigningEnvironment(overrides = {}) {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (name.startsWith('VMT_ANDROID_')) delete environment[name]
  }
  return { ...environment, ...overrides }
}

function runSigningPreflight(environment) {
  const gradleArgs = ['-q', 'verifyReleaseSigning', '--no-daemon']
  const javaExecutable = path.join(environment.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  return spawnSync(javaExecutable, [
    '-Xmx64m',
    '-Xms64m',
    '-Dorg.gradle.appname=gradlew',
    '-classpath',
    '',
    '-jar',
    wrapperJar,
    ...gradleArgs,
  ], {
    cwd: path.join(root, 'android'),
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  })
}

test('release signing is external-only and attached to release artifact tasks', async () => {
  const source = await readFile(signingScript, 'utf8')
  assert.match(source, /VMT_ANDROID_SIGNING_PROPERTIES/u)
  assert.match(source, /VMT_ANDROID_KEYSTORE_PATH/u)
  assert.match(source, /Android signing certificate does not match the approved release gate/u)
  assert.match(source, new RegExp(`approvedCertificateSha256 = '${approvedCertificateSha256}'`, 'u'))
  assert.match(source, /createsReleaseArtifact/u)
  assert.doesNotMatch(source, /signingConfig\s+signingConfigs\.debug/u)
})

test('Android ignore rules exclude local inputs and outputs but not the public release APK', () => {
  const ignored = [
    'android/local.properties',
    'android/signing.properties',
    'android/private-release.jks',
    'android/.gradle/cache.bin',
    'android/app/build/output.apk',
    'android/reports/local-report.json',
  ]
  for (const candidate of ignored) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', candidate], { cwd: root })
    assert.equal(result.status, 0, `${candidate} must be ignored`)
  }
  const publicArtifacts = [
    'public/downloads/vivek-marco-trader.apk',
  ]
  for (const candidate of publicArtifacts) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', candidate], { cwd: root })
    assert.equal(result.status, 1, `${candidate} must remain trackable`)
  }
})

test('secret-safe scan reports only sanitized paths and counts', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vmt-secret-scan-'))
  const marker = `fixture-${Date.now()}-must-not-appear`
  const privateKeyHeader = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
  const fixture = path.join(temporaryRoot, 'signing.properties')
  try {
    await writeFile(fixture, `storePassword=${marker}\nkeyAlias=${marker}\nsdk.dir=C:\\Users\\fixture\\Sdk\n${privateKeyHeader}\n${marker}\n`, 'utf8')
    const result = await scanFiles([fixture])
    const report = formatReport(result)
    assert.ok(result.findings.length >= 3)
    assert.match(report, /<external>\/signing\.properties/u)
    assert.doesNotMatch(report, new RegExp(marker, 'u'))
    assert.doesNotMatch(report, /C:\\Users/u)
    assert.doesNotMatch(report, /BEGIN PRIVATE KEY/u)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('tracked signing and scan configuration passes the secret-safe scan', async () => {
  const result = await scanFiles([
    signingScript,
    path.join(root, 'android', 'app', 'build.gradle'),
    path.join(root, 'scripts', 'scan-release-secrets.mjs'),
  ])
  assert.deepEqual(result.findings, [])
})

test('release signing preflight fails closed when inputs are missing', { skip: !requiredToolchain }, () => {
  const result = runSigningPreflight(sanitizedSigningEnvironment())
  const output = `${result.stdout}${result.stderr}`
  assert.notEqual(result.status, 0)
  assert.match(output, /Android release signing inputs are required/u)
})

test('external signing classification mismatch fails without echoing values', { skip: !requiredToolchain }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vmt-signing-classification-'))
  const marker = `fixture-${Date.now()}-must-not-appear`
  const propertiesFile = path.join(temporaryRoot, 'signing.properties')
  try {
    await writeFile(propertiesFile, [
      `storeFile=${path.join(temporaryRoot, 'missing-keystore.jks')}`,
      `keyAlias=${marker}`,
      `storePassword=${marker}`,
      `keyPassword=${marker}`,
      'signerClassification=development/debug',
    ].join('\n'), 'utf8')
    const result = runSigningPreflight(sanitizedSigningEnvironment({ VMT_ANDROID_SIGNING_PROPERTIES: propertiesFile }))
    const output = `${result.stdout}${result.stderr}`
    assert.notEqual(result.status, 0)
    assert.match(output, /classification does not match/u)
    assert.doesNotMatch(output, new RegExp(marker, 'u'))
    assert.doesNotMatch(output, new RegExp(propertiesFile.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('synthetic external keystore is consumed and an unexpected certificate fails closed', { skip: !requiredToolchain }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vmt-signing-certificate-'))
  const marker = `fixture-${Date.now()}-must-not-appear`
  const alias = ['my', 'key'].join('')
  const keystore = path.join(temporaryRoot, 'synthetic.jks')
  const propertiesFile = path.join(temporaryRoot, 'signing.properties')
  const keytool = path.join(process.env.JAVA_HOME ?? '', 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool')
  try {
    execFileSync(keytool, [
      '-genkeypair', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '1',
      '-dname', 'CN=Local Test, OU=Test, O=VMT, C=US', '-keystore', keystore,
      '-storepass:env', 'VMT_TEST_STORE_PASSWORD', '-keypass:env', 'VMT_TEST_KEY_PASSWORD', '-noprompt',
    ], {
      stdio: 'ignore',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, VMT_TEST_STORE_PASSWORD: marker, VMT_TEST_KEY_PASSWORD: marker },
    })
    await writeFile(propertiesFile, [
      `storeFile=${keystore.replaceAll('\\', '/')}`,
      `keyAlias=${alias}`,
      `storePassword=${marker}`,
      `keyPassword=${marker}`,
      'signerClassification=approved-release',
    ].join('\n'), 'utf8')
    const result = runSigningPreflight(sanitizedSigningEnvironment({ VMT_ANDROID_SIGNING_PROPERTIES: propertiesFile }))
    const output = `${result.stdout}${result.stderr}`
    assert.notEqual(result.status, 0)
    assert.match(output, /certificate does not match/u)
    assert.doesNotMatch(output, new RegExp(marker, 'u'))
    assert.doesNotMatch(output, new RegExp(alias, 'u'))
    assert.doesNotMatch(output, new RegExp(propertiesFile.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
