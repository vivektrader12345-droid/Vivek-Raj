import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 30_000
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024
const SIGNER_CLASSIFICATIONS = new Set(['approved-release', 'owner-approved-non-release', 'development/debug'])
const REQUIRED_DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']
const GENERATED_CAPACITOR_ASSETS = new Set(['cordova.js', 'cordova_plugins.js'])
const HOST_ONLY_ASSETS = new Set(['404.html', '_redirects', 'sw.js'])
const TEXT_ASSET_PATTERN = /\.(?:css|html|js|json|svg|txt|xml)$/iu
const PROHIBITED_ASSET_PATH_PATTERN = /(^|\/)(?:\.env(?:\.|$)|[^/]*\.(?:jks|keystore|p12|pfx|pem|key)|(?:local|signing|keystore)[^/]*\.properties$|google-services\.json$)/iu
const PROHIBITED_LOCAL_ENDPOINT_PATTERN = /@vite\/client|vite-hmr|(?:localhost|127\.0\.0\.1|10\.0\.2\.2)(?::\d+)?|https?:\/\/(?:localhost|127\.0\.0\.1|10\.0\.2\.2)/iu
const FIREBASE_AUTH_VENDOR_ASSET_PATTERN = /^assets\/firebase-auth-[A-Za-z0-9_-]+\.js$/u
const PROHIBITED_CONTENT_PATTERNS = [
  /(?:file:\/{2,3}|[A-Za-z]:\\(?:Users|Program Files)\\|\/(?:Users|home)\/)[^\s"']+/u,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u,
  /(?:storePassword|keyPassword|keystorePassword|keyAlias)\s*[:=]\s*[^\s<]+/iu,
  /(?:sourceMappingURL\s*=|\.map(?:[?#"']|$))/iu,
]

class ValidationError extends Error {
  constructor(code, outcome) {
    super(code)
    this.name = 'ValidationError'
    this.code = code
    this.outcome = outcome
  }
}

function fail(code, outcome) {
  throw new ValidationError(code, outcome)
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) fail('ARGUMENTS_INVALID', 'input')
    const name = key.slice(2)
    if (Object.hasOwn(values, name)) fail('ARGUMENTS_INVALID', 'input')
    values[name] = value
  }
  const required = [
    'apk', 'dist', 'source-revision', 'application-id', 'version-code', 'version-name', 'label',
    'launchable-activity', 'min-sdk', 'target-sdk', 'compile-sdk', 'signer-fingerprint',
    'signer-classification', 'sdk-root', 'java-home',
  ]
  if (required.some(name => !values[name]) || Object.keys(values).some(name => !required.includes(name))) {
    fail('ARGUMENTS_INVALID', 'input')
  }
  return values
}

function validateExpected(values) {
  if (!/^[0-9a-f]{40}$/iu.test(values['source-revision'])) fail('SOURCE_REVISION_INVALID', 'input')
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(values['application-id'])) fail('APPLICATION_ID_INVALID', 'input')
  if (!/^\d+$/u.test(values['version-code']) || Number(values['version-code']) < 1) fail('VERSION_CODE_INVALID', 'input')
  for (const name of ['version-name', 'label', 'launchable-activity']) {
    if (!values[name].trim() || /[\0\r\n]/u.test(values[name])) fail('EXPECTED_VALUE_INVALID', 'input')
  }
  for (const name of ['min-sdk', 'target-sdk', 'compile-sdk']) {
    if (!/^\d+$/u.test(values[name]) || Number(values[name]) < 1) fail('SDK_EXPECTATION_INVALID', 'input')
  }
  if (!SIGNER_CLASSIFICATIONS.has(values['signer-classification'])) fail('SIGNER_CLASSIFICATION_INVALID', 'input')
  const signerFingerprint = normalizeFingerprint(values['signer-fingerprint'])
  if (!/^[A-F0-9]{64}$/u.test(signerFingerprint)) fail('SIGNER_FINGERPRINT_INVALID', 'input')
  const sdkRoot = path.resolve(values['sdk-root'])
  const javaHome = path.resolve(values['java-home'])
  if (!path.isAbsolute(values['sdk-root']) || !path.isAbsolute(values['java-home'])) fail('TOOL_ROOT_INVALID', 'toolchain')
  return {
    apk: path.resolve(values.apk),
    dist: path.resolve(values.dist),
    sourceRevision: values['source-revision'].toLowerCase(),
    applicationId: values['application-id'],
    versionCode: values['version-code'],
    versionName: values['version-name'],
    label: values.label,
    launchableActivity: values['launchable-activity'],
    minSdk: values['min-sdk'],
    targetSdk: values['target-sdk'],
    compileSdk: values['compile-sdk'],
    signerFingerprint,
    signerClassification: values['signer-classification'],
    sdkRoot,
    javaHome,
  }
}

function normalizeFingerprint(value) {
  return value.replaceAll(':', '').replaceAll(/\s/gu, '').toUpperCase()
}

function displayFingerprint(value) {
  return normalizeFingerprint(value).match(/.{2}/gu).join(':')
}

async function sha256(filePath) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  return hash.digest('hex')
}

async function runTool(executable, args, options = {}) {
  try {
    return await execFileAsync(executable, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env: options.env ?? process.env,
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (error) {
    if (error?.killed || error?.signal) fail('TOOL_TIMEOUT', options.outcome ?? 'toolchain')
    fail(options.code ?? 'TOOL_FAILED', options.outcome ?? 'toolchain')
  }
}

function executableName(base) {
  if (process.platform !== 'win32') return base
  if (base === 'apksigner') return 'apksigner.bat'
  return `${base}.exe`
}

function compareBuildToolVersions(left, right) {
  const leftParts = left.split(/[.-]/u).map(part => Number.parseInt(part, 10) || 0)
  const rightParts = right.split(/[.-]/u).map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return right.localeCompare(left)
}

async function resolveTools(expected) {
  const buildToolsRoot = path.join(expected.sdkRoot, 'build-tools')
  let versions
  try {
    versions = (await readdir(buildToolsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort(compareBuildToolVersions)
  } catch {
    fail('SDK_BUILD_TOOLS_MISSING', 'toolchain')
  }
  for (const version of versions) {
    const root = path.join(buildToolsRoot, version)
    const aapt2 = path.join(root, executableName('aapt2'))
    const apksigner = path.join(root, executableName('apksigner'))
    const apksignerJar = process.platform === 'win32' ? path.join(root, 'lib', 'apksigner.jar') : null
    try {
      const jar = path.join(expected.javaHome, 'bin', executableName('jar'))
      const java = path.join(expected.javaHome, 'bin', executableName('java'))
      await Promise.all([access(aapt2), access(apksignerJar ?? apksigner), access(jar), access(java)])
      return { aapt2, apksigner, apksignerJar, jar, java }
    } catch {
      // Try the next installed build-tools version as one compatible unit.
    }
  }
  fail('COMPATIBLE_SDK_TOOLS_MISSING', 'toolchain')
}

async function runApksigner(tools, args, options = {}) {
  if (tools.apksignerJar) return runTool(tools.java, ['-jar', tools.apksignerJar, ...args], options)
  return runTool(tools.apksigner, args, options)
}

async function validateInputFile(expected) {
  if (path.extname(expected.apk).toLowerCase() !== '.apk') fail('APK_EXTENSION_INVALID', 'archive')
  let metadata
  try {
    metadata = await lstat(expected.apk)
  } catch {
    fail('APK_MISSING', 'archive')
  }
  if (!metadata.isFile()) fail('APK_NOT_FILE', 'archive')
  if (metadata.size === 0) fail('APK_EMPTY', 'archive')
  const handle = await import('node:fs/promises').then(module => module.open(expected.apk, 'r'))
  try {
    const magic = Buffer.alloc(4)
    const { bytesRead } = await handle.read(magic, 0, 4, 0)
    if (bytesRead !== 4 || !magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) fail('APK_MAGIC_INVALID', 'archive')
  } finally {
    await handle.close()
  }
  try {
    const distMetadata = await lstat(expected.dist)
    if (!distMetadata.isDirectory()) fail('DIST_NOT_DIRECTORY', 'assets')
  } catch (error) {
    if (error instanceof ValidationError) throw error
    fail('DIST_MISSING', 'assets')
  }
  return metadata
}

function parseSingleMatch(text, pattern, code, outcome) {
  const match = text.match(pattern)
  if (!match) fail(code, outcome)
  return match[1]
}

function resourceBlock(resources, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = resources.match(new RegExp(`resource [^\\n]+ ${escapedName}\\r?\\n([\\s\\S]*?)(?=    resource |  type |$)`, 'u'))
  if (!match) fail('LAUNCHER_RESOURCE_MISSING', 'launcher-resources')
  return match[1]
}

function validateResources(resources) {
  const launcher = resourceBlock(resources, 'mipmap/ic_launcher')
  const round = resourceBlock(resources, 'mipmap/ic_launcher_round')
  const foreground = resourceBlock(resources, 'mipmap/ic_launcher_foreground')
  for (const density of REQUIRED_DENSITIES) {
    const densityPattern = new RegExp(`\\(${density}\\) \\(file\\) [^\\n]+ type=PNG`, 'u')
    if (!densityPattern.test(launcher) || !densityPattern.test(round) || !densityPattern.test(foreground)) {
      fail('LEGACY_LAUNCHER_DENSITY_MISSING', 'launcher-resources')
    }
  }
  if (!/\(anydpi-v26\) \(file\) [^\n]+ type=XML/u.test(launcher) || !/\(anydpi-v26\) \(file\) [^\n]+ type=XML/u.test(round)) {
    fail('ADAPTIVE_LAUNCHER_MISSING', 'launcher-resources')
  }
}

function validateBadging(badging, expected) {
  const packageName = parseSingleMatch(badging, /^package: name='([^']+)'/mu, 'PACKAGE_METADATA_MISSING', 'identity')
  const versionCode = parseSingleMatch(badging, /^package: .* versionCode='([^']+)'/mu, 'VERSION_METADATA_MISSING', 'metadata')
  const versionName = parseSingleMatch(badging, /^package: .* versionName='([^']+)'/mu, 'VERSION_METADATA_MISSING', 'metadata')
  const compileSdk = parseSingleMatch(badging, /^package: .* compileSdkVersion='([^']+)'/mu, 'SDK_METADATA_MISSING', 'metadata')
  const minSdk = parseSingleMatch(badging, /^minSdkVersion:'([^']+)'/mu, 'SDK_METADATA_MISSING', 'metadata')
  const targetSdk = parseSingleMatch(badging, /^targetSdkVersion:'([^']+)'/mu, 'SDK_METADATA_MISSING', 'metadata')
  const label = parseSingleMatch(badging, /^application-label:'([^']+)'/mu, 'LABEL_MISSING', 'identity')
  const launchableActivity = parseSingleMatch(badging, /^launchable-activity: name='([^']+)'/mu, 'LAUNCHABLE_ACTIVITY_MISSING', 'identity')
  if (packageName !== expected.applicationId) fail('IDENTITY_MISMATCH', 'identity')
  if (versionCode !== expected.versionCode || versionName !== expected.versionName) fail('VERSION_MISMATCH', 'metadata')
  if (label !== expected.label || launchableActivity !== expected.launchableActivity) fail('IDENTITY_MISMATCH', 'identity')
  if (minSdk !== expected.minSdk || targetSdk !== expected.targetSdk || compileSdk !== expected.compileSdk) fail('SDK_METADATA_MISMATCH', 'metadata')
}

function validateSignature(output, expected) {
  if (!/^Verifies$/mu.test(output)) fail('SIGNATURE_INVALID', 'signature')
  const signerCount = parseSingleMatch(output, /^Number of signers: (\d+)$/mu, 'SIGNER_METADATA_MISSING', 'signature')
  if (signerCount !== '1') fail('SIGNER_COUNT_INVALID', 'signature')
  const fingerprint = normalizeFingerprint(parseSingleMatch(output, /^Signer #1 certificate SHA-256 digest: ([0-9a-f:]+)$/imu, 'SIGNER_METADATA_MISSING', 'signature'))
  if (fingerprint !== expected.signerFingerprint) fail('SIGNER_MISMATCH', 'signature')
  const verifiedV2 = /^Verified using v2 scheme \(APK Signature Scheme v2\): true$/mu.test(output)
  const verifiedNewer = /^Verified using v(?:3|3\.1|4) scheme .*: true$/mu.test(output)
  if (!verifiedV2 && !verifiedNewer) fail('SIGNATURE_SCHEME_UNAPPROVED', 'signature')
}

function normalizeArchiveEntry(entry) {
  return entry.replaceAll('\\', '/')
}

async function walkFiles(root) {
  const files = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const destination = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(destination)
      else if (entry.isFile()) files.push(destination)
      else fail('UNSUPPORTED_ASSET_TYPE', 'assets')
    }
  }
  await visit(root)
  return files
}

function relativeAsset(root, filePath) {
  return path.relative(root, filePath).replaceAll('\\', '/')
}

async function validateAssetContent(assetRoot, relativeFiles) {
  for (const relative of relativeFiles) {
    if (relative.endsWith('.map')) fail('SOURCE_MAP_PRESENT', 'assets')
    if (PROHIBITED_ASSET_PATH_PATTERN.test(relative)) fail('SENSITIVE_ASSET_PRESENT', 'assets')
    if (!TEXT_ASSET_PATTERN.test(relative)) continue
    const content = await readFile(path.join(assetRoot, ...relative.split('/')), 'utf8')
    const hasProhibitedLocalEndpoint = !FIREBASE_AUTH_VENDOR_ASSET_PATTERN.test(relative)
      && PROHIBITED_LOCAL_ENDPOINT_PATTERN.test(content)
    if (hasProhibitedLocalEndpoint || PROHIBITED_CONTENT_PATTERNS.some(pattern => pattern.test(content))) {
      fail('PROHIBITED_ASSET_CONTENT', 'assets')
    }
  }
}

async function validateArchive(expected, tools) {
  const { stdout: archiveOutput } = await runTool(tools.jar, ['tf', expected.apk], { code: 'ARCHIVE_INVALID', outcome: 'archive' })
  const archiveEntries = archiveOutput.split(/\r?\n/u).filter(Boolean).map(normalizeArchiveEntry)
  if (archiveEntries.length === 0 || !archiveEntries.includes('AndroidManifest.xml') || !archiveEntries.includes('resources.arsc')) {
    fail('APK_STRUCTURE_INVALID', 'archive')
  }
  if (archiveEntries.some(entry => entry.startsWith('/') || /^[A-Za-z]:/u.test(entry) || entry.split('/').includes('..'))) {
    fail('ARCHIVE_PATH_INVALID', 'archive')
  }
  return archiveEntries
}

async function validateAssets(expected, tools, archiveEntries) {
  await validateAssetContent(expected.dist, (await walkFiles(expected.dist)).map(file => relativeAsset(expected.dist, file)))

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vmt-apk-inspect-'))
  try {
    await runTool(tools.jar, ['xf', expected.apk, 'assets/public'], {
      cwd: temporaryRoot,
      code: 'ARCHIVE_EXTRACTION_FAILED',
      outcome: 'archive',
    })
    const packagedRoot = path.join(temporaryRoot, 'assets', 'public')
    const packagedFiles = await walkFiles(packagedRoot)
    const packagedRelative = packagedFiles.map(file => relativeAsset(packagedRoot, file))
    const distFiles = (await walkFiles(expected.dist))
      .map(file => relativeAsset(expected.dist, file))
      .filter(relative => relative !== 'downloads' && !relative.startsWith('downloads/') && !HOST_ONLY_ASSETS.has(relative))
    if (!distFiles.includes('index.html')) fail('PRODUCTION_ENTRY_MISSING', 'assets')
    for (const relative of distFiles) {
      if (!packagedRelative.includes(relative)) fail('PRODUCTION_ASSET_MISSING', 'assets')
      const [distHash, packagedHash] = await Promise.all([
        sha256(path.join(expected.dist, ...relative.split('/'))),
        sha256(path.join(packagedRoot, ...relative.split('/'))),
      ])
      if (distHash !== packagedHash) fail('PRODUCTION_ASSET_MISMATCH', 'assets')
    }
    const unexpected = packagedRelative.filter(relative => (
      !distFiles.includes(relative) && !GENERATED_CAPACITOR_ASSETS.has(relative) && !HOST_ONLY_ASSETS.has(relative)
    ))
    if (unexpected.length > 0) fail('UNEXPECTED_PACKAGED_ASSET', 'assets')
    await validateAssetContent(packagedRoot, packagedRelative)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function safeVersion(output) {
  const firstLine = output.split(/\r?\n/u).find(Boolean)?.trim() ?? 'unknown'
  return firstLine.replace(/[\0\r\n]/gu, '').slice(0, 160)
}

export async function inspectAndroidApk(argv) {
  const expected = validateExpected(parseArguments(argv))
  const metadata = await validateInputFile(expected)
  const tools = await resolveTools(expected)
  const toolEnvironment = { ...process.env, JAVA_HOME: expected.javaHome, ANDROID_SDK_ROOT: expected.sdkRoot }
  const archiveEntries = await validateArchive(expected, tools)
  const [aaptVersion, apksignerVersion, javaVersion] = await Promise.all([
    runTool(tools.aapt2, ['version'], { outcome: 'toolchain' }),
    runApksigner(tools, ['version'], { env: toolEnvironment, outcome: 'toolchain' }),
    runTool(tools.java, ['-version'], { env: toolEnvironment, outcome: 'toolchain' }),
  ])
  const [signature, badging, resources] = await Promise.all([
    runApksigner(tools, ['verify', '--verbose', '--print-certs', expected.apk], {
      env: toolEnvironment,
      code: 'SIGNATURE_INVALID',
      outcome: 'signature',
    }),
    runTool(tools.aapt2, ['dump', 'badging', expected.apk], { code: 'APK_MANIFEST_INVALID', outcome: 'identity' }),
    runTool(tools.aapt2, ['dump', 'resources', expected.apk], { code: 'APK_RESOURCES_INVALID', outcome: 'launcher-resources' }),
  ])
  validateSignature(`${signature.stdout}\n${signature.stderr}`, expected)
  validateBadging(badging.stdout, expected)
  validateResources(resources.stdout)
  await validateAssets(expected, tools, archiveEntries)
  return {
    schemaVersion: 1,
    status: 'pass',
    sourceRevision: expected.sourceRevision,
    artifact: {
      filename: path.basename(expected.apk),
      applicationId: expected.applicationId,
      versionCode: Number(expected.versionCode),
      versionName: expected.versionName,
      signer: {
        classification: expected.signerClassification,
        certificateSha256: displayFingerprint(expected.signerFingerprint),
      },
      byteSize: metadata.size,
      sha256: await sha256(expected.apk),
    },
    tools: {
      aapt2: safeVersion(`${aaptVersion.stdout}\n${aaptVersion.stderr}`),
      apksigner: safeVersion(`${apksignerVersion.stdout}\n${apksignerVersion.stderr}`),
      java: safeVersion(`${javaVersion.stdout}\n${javaVersion.stderr}`),
    },
    outcomes: {
      archiveIntegrity: 'pass',
      signature: 'pass',
      identityAndVersion: 'pass',
      sdkAndLaunchMetadata: 'pass',
      launcherResources: 'pass',
      productionAssets: 'pass',
      sensitiveContent: 'pass',
    },
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  try {
    console.log(JSON.stringify(await inspectAndroidApk(process.argv.slice(2)), null, 2))
  } catch (error) {
    const validationError = error instanceof ValidationError ? error : new ValidationError('INSPECTION_FAILED', 'inspection')
    console.error(JSON.stringify({ schemaVersion: 1, status: 'fail', outcome: validationError.outcome, code: validationError.code }))
    process.exitCode = 1
  }
}
