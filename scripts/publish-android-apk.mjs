import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CANONICAL_APK_FILENAME,
  CANONICAL_APK_MEDIA_TYPE,
  CANONICAL_APK_PATH,
  validateApkDescriptor,
} from '../src/components/apkDescriptorContract.js'
import { inspectAndroidApk } from './inspect-android-apk.mjs'
import { scanFiles } from './scan-release-secrets.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CANONICAL_DESCRIPTOR_FILENAME = `${CANONICAL_APK_FILENAME}.json`
const DEFAULT_DESTINATION_DIRECTORY = path.join(root, 'public', 'downloads')
const MAX_METADATA_BYTES = 1024 * 1024
const SAFE_APK_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/u
const PROHIBITED_RELEASE_BASENAME = /(?:^|[._-])(?:androidtest|unittest|debug|profile|test|benchmark)(?:[._-]|$)/iu
const REQUIRED_OPTION_KEYS = Object.freeze([
  'applicationId',
  'compileSdk',
  'distPath',
  'javaHome',
  'label',
  'launchableActivity',
  'metadataPath',
  'minSdk',
  'sdkRoot',
  'signerClassification',
  'signerFingerprint',
  'sourceRevision',
  'targetSdk',
  'versionCode',
  'versionName',
])
const OPTIONAL_OPTION_KEYS = new Set([
  'dependencies',
  'destinationDirectory',
  'fileOperations',
])

export class ApkPublicationError extends Error {
  constructor(code, outcome = 'publication') {
    super(code)
    this.name = 'ApkPublicationError'
    this.code = code
    this.outcome = outcome
  }
}

function fail(code, outcome) {
  throw new ApkPublicationError(code, outcome)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameResolvedPath(left, right) {
  const normalize = value => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string') fail('SIGNER_FINGERPRINT_INVALID', 'input')
  const compact = value.replaceAll(':', '').replaceAll(/\s/gu, '').toUpperCase()
  if (!/^[A-F0-9]{64}$/u.test(compact)) fail('SIGNER_FINGERPRINT_INVALID', 'input')
  return compact.match(/.{2}/gu).join(':')
}

function validateExpectedOptions(options) {
  if (!isRecord(options)) fail('OPTIONS_INVALID', 'input')
  for (const key of REQUIRED_OPTION_KEYS) {
    if (!Object.hasOwn(options, key)) fail('OPTION_MISSING', 'input')
  }
  for (const key of Object.keys(options)) {
    if (!REQUIRED_OPTION_KEYS.includes(key) && !OPTIONAL_OPTION_KEYS.has(key)) fail('OPTION_UNEXPECTED', 'input')
  }
  if (!/^[0-9a-f]{40}$/u.test(options.sourceRevision)) fail('SOURCE_REVISION_INVALID', 'input')
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u.test(options.applicationId)) fail('APPLICATION_ID_INVALID', 'input')
  const versionCode = typeof options.versionCode === 'string' ? Number(options.versionCode) : options.versionCode
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) fail('VERSION_CODE_INVALID', 'input')
  if (typeof options.versionName !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(options.versionName)) {
    fail('VERSION_NAME_INVALID', 'input')
  }
  for (const key of ['label', 'launchableActivity']) {
    if (typeof options[key] !== 'string' || !options[key].trim() || /[\0\r\n]/u.test(options[key])) fail('IDENTITY_VALUE_INVALID', 'input')
  }
  for (const key of ['minSdk', 'targetSdk', 'compileSdk']) {
    if (!/^\d+$/u.test(String(options[key])) || Number(options[key]) < 1) fail('SDK_EXPECTATION_INVALID', 'input')
  }
  if (options.signerClassification !== 'approved-release') fail('SIGNER_CLASSIFICATION_INVALID', 'input')
  for (const key of ['metadataPath', 'distPath', 'sdkRoot', 'javaHome']) {
    if (typeof options[key] !== 'string' || !options[key]) fail('PATH_INVALID', 'input')
  }
  if (options.destinationDirectory !== undefined
    && (typeof options.destinationDirectory !== 'string' || !options.destinationDirectory)) fail('PATH_INVALID', 'input')

  return Object.freeze({
    metadataPath: path.resolve(options.metadataPath),
    destinationDirectory: path.resolve(options.destinationDirectory ?? DEFAULT_DESTINATION_DIRECTORY),
    distPath: path.resolve(options.distPath),
    sourceRevision: options.sourceRevision,
    applicationId: options.applicationId,
    versionCode,
    versionName: options.versionName,
    label: options.label,
    launchableActivity: options.launchableActivity,
    minSdk: String(options.minSdk),
    targetSdk: String(options.targetSdk),
    compileSdk: String(options.compileSdk),
    signerFingerprint: normalizeFingerprint(options.signerFingerprint),
    signerClassification: options.signerClassification,
    sdkRoot: path.resolve(options.sdkRoot),
    javaHome: path.resolve(options.javaHome),
  })
}

async function requireRealRegularFile(filePath, missingCode, unsafeCode) {
  let metadata
  try {
    metadata = await lstat(filePath)
  } catch {
    fail(missingCode, 'selection')
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(unsafeCode, 'selection')
  let resolved
  try {
    resolved = await realpath(filePath)
  } catch {
    fail(unsafeCode, 'selection')
  }
  if (!sameResolvedPath(resolved, filePath)) fail(unsafeCode, 'selection')
  return metadata
}

async function requireRealDirectory(directoryPath, code, create = false) {
  if (create) await mkdir(directoryPath, { recursive: true })
  let metadata
  try {
    metadata = await lstat(directoryPath)
  } catch {
    fail(code, 'selection')
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code, 'selection')
  const resolved = await realpath(directoryPath).catch(() => null)
  if (!resolved || !sameResolvedPath(resolved, directoryPath)) fail(code, 'selection')
}

function parseMetadata(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    fail('METADATA_JSON_INVALID', 'selection')
  }
  if (!isRecord(value)) fail('METADATA_INVALID', 'selection')
  return value
}

function selectMetadataElement(metadata, expected) {
  if (!isRecord(metadata.artifactType) || metadata.artifactType.type !== 'APK') fail('ARTIFACT_TYPE_INVALID', 'selection')
  if (metadata.variantName !== 'release') fail('VARIANT_INVALID', 'selection')
  if (metadata.applicationId !== expected.applicationId) fail('APPLICATION_ID_MISMATCH', 'selection')
  if (!Array.isArray(metadata.elements) || metadata.elements.length !== 1) fail('ELEMENT_COUNT_INVALID', 'selection')

  const element = metadata.elements[0]
  if (!isRecord(element) || element.type !== 'SINGLE') fail('ELEMENT_TYPE_INVALID', 'selection')
  if (!Array.isArray(element.filters) || element.filters.length !== 0) fail('FILTERED_APK_INVALID', 'selection')
  if (element.versionCode !== expected.versionCode || element.versionName !== expected.versionName) fail('VERSION_MISMATCH', 'selection')
  if (typeof element.outputFile !== 'string'
    || !SAFE_APK_BASENAME.test(element.outputFile)
    || path.basename(element.outputFile) !== element.outputFile
    || element.outputFile.includes('%')
    || PROHIBITED_RELEASE_BASENAME.test(element.outputFile)) fail('OUTPUT_FILE_UNSAFE', 'selection')
  return element
}

export async function selectReleaseCandidate(options) {
  const expected = validateExpectedOptions(options)
  if (path.basename(expected.metadataPath) !== 'output-metadata.json') fail('METADATA_FILENAME_INVALID', 'selection')
  const releaseDirectory = path.dirname(expected.metadataPath)
  await requireRealDirectory(releaseDirectory, 'RELEASE_DIRECTORY_UNSAFE')
  const metadataStat = await requireRealRegularFile(expected.metadataPath, 'METADATA_MISSING', 'METADATA_UNSAFE')
  if (metadataStat.size < 2 || metadataStat.size > MAX_METADATA_BYTES) fail('METADATA_SIZE_INVALID', 'selection')
  const metadata = parseMetadata(await readFile(expected.metadataPath, 'utf8'))
  const element = selectMetadataElement(metadata, expected)
  const candidatePath = path.resolve(releaseDirectory, element.outputFile)
  if (path.dirname(candidatePath) !== releaseDirectory) fail('OUTPUT_FILE_OUTSIDE_RELEASE', 'selection')
  const candidateStat = await requireRealRegularFile(candidatePath, 'APK_MISSING', 'APK_UNSAFE')
  if (candidateStat.nlink !== 1) fail('APK_UNSAFE', 'selection')
  if (candidateStat.size === 0) fail('APK_EMPTY', 'selection')

  return Object.freeze({
    expected,
    metadataPath: expected.metadataPath,
    releaseDirectory,
    candidatePath,
    sourceFilename: element.outputFile,
    byteSize: candidateStat.size,
  })
}

export async function hashReleaseFile(filePath) {
  const hash = createHash('sha256')
  let byteSize = 0
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => {
      byteSize += chunk.length
      hash.update(chunk)
    })
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  return Object.freeze({ byteSize, sha256: hash.digest('hex') })
}

function inspectorArguments(selection) {
  const { expected } = selection
  return [
    '--apk', selection.candidatePath,
    '--dist', expected.distPath,
    '--source-revision', expected.sourceRevision,
    '--application-id', expected.applicationId,
    '--version-code', String(expected.versionCode),
    '--version-name', expected.versionName,
    '--label', expected.label,
    '--launchable-activity', expected.launchableActivity,
    '--min-sdk', expected.minSdk,
    '--target-sdk', expected.targetSdk,
    '--compile-sdk', expected.compileSdk,
    '--signer-fingerprint', expected.signerFingerprint,
    '--signer-classification', expected.signerClassification,
    '--sdk-root', expected.sdkRoot,
    '--java-home', expected.javaHome,
  ]
}

export function createReleaseDescriptor(selection, inspection, streamedArtifact) {
  if (!isRecord(inspection) || inspection.status !== 'pass' || !isRecord(inspection.artifact)) fail('INSPECTION_NOT_APPROVED', 'inspection')
  const { expected } = selection
  const artifact = inspection.artifact
  if (inspection.sourceRevision !== expected.sourceRevision
    || artifact.filename !== selection.sourceFilename
    || artifact.applicationId !== expected.applicationId
    || artifact.versionCode !== expected.versionCode
    || artifact.versionName !== expected.versionName) fail('INSPECTION_IDENTITY_MISMATCH', 'inspection')
  if (!isRecord(artifact.signer)
    || artifact.signer.classification !== expected.signerClassification
    || normalizeFingerprint(artifact.signer.certificateSha256) !== expected.signerFingerprint) fail('INSPECTION_SIGNER_MISMATCH', 'inspection')
  if (artifact.byteSize !== streamedArtifact.byteSize || artifact.sha256 !== streamedArtifact.sha256) fail('INSPECTION_DIGEST_MISMATCH', 'inspection')

  return validateApkDescriptor({
    schemaVersion: 2,
    path: CANONICAL_APK_PATH,
    filename: CANONICAL_APK_FILENAME,
    mediaType: CANONICAL_APK_MEDIA_TYPE,
    applicationId: expected.applicationId,
    versionCode: expected.versionCode,
    versionName: expected.versionName,
    sourceRevision: expected.sourceRevision,
    byteSize: streamedArtifact.byteSize,
    sha256: streamedArtifact.sha256,
    signer: {
      classification: expected.signerClassification,
      certificateSha256: expected.signerFingerprint,
    },
  }, {
    expectedIdentity: {
      applicationId: expected.applicationId,
      versionCode: expected.versionCode,
      versionName: expected.versionName,
      sourceRevision: expected.sourceRevision,
      signer: {
        classification: expected.signerClassification,
        certificateSha256: expected.signerFingerprint,
      },
    },
  })
}

async function validateExactInventory(directory, expectedNames, code) {
  const entries = await readdir(directory, { withFileTypes: true })
  const names = entries.map(entry => entry.name).sort()
  const expected = [...expectedNames].sort()
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) fail(code, 'publication')
  if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) fail(code, 'publication')
}

async function validateDestination(destinationDirectory) {
  await requireRealDirectory(destinationDirectory, 'DESTINATION_UNSAFE', true)
  const entries = await readdir(destinationDirectory, { withFileTypes: true })
  const allowed = new Set([CANONICAL_APK_FILENAME, CANONICAL_DESCRIPTOR_FILENAME])
  if (entries.some(entry => !allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())) {
    fail('DESTINATION_INVENTORY_INVALID', 'publication')
  }
  if (entries.length === 1) fail('DESTINATION_PAIR_INCOMPLETE', 'publication')
}

async function pathExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function commitPublishedPair(staged, destinationDirectory, operations) {
  const destinationApk = path.join(destinationDirectory, CANONICAL_APK_FILENAME)
  const destinationDescriptor = path.join(destinationDirectory, CANONICAL_DESCRIPTOR_FILENAME)
  const backupApk = path.join(staged.directory, 'previous.apk')
  const backupDescriptor = path.join(staged.directory, 'previous.apk.json')
  const hadPreviousPair = await pathExists(destinationApk) && await pathExists(destinationDescriptor)
  let movedPreviousApk = false
  let movedPreviousDescriptor = false
  let installedApk = false
  let installedDescriptor = false

  try {
    if (hadPreviousPair) {
      await operations.rename(destinationApk, backupApk)
      movedPreviousApk = true
      await operations.rename(destinationDescriptor, backupDescriptor)
      movedPreviousDescriptor = true
    }
    await operations.rename(staged.apk, destinationApk)
    installedApk = true
    await operations.rename(staged.descriptor, destinationDescriptor)
    installedDescriptor = true
  } catch (error) {
    try {
      if (installedDescriptor) await operations.rm(destinationDescriptor, { force: true })
      if (installedApk) await operations.rm(destinationApk, { force: true })
      if (movedPreviousApk) await operations.rename(backupApk, destinationApk)
      if (movedPreviousDescriptor) await operations.rename(backupDescriptor, destinationDescriptor)
    } catch {
      fail('PUBLICATION_ROLLBACK_FAILED', 'publication')
    }
    fail('PUBLICATION_COMMIT_FAILED', 'publication')
  }

  return Object.freeze({ apkPath: destinationApk, descriptorPath: destinationDescriptor })
}

export async function publishAndroidApk(options) {
  const selection = await selectReleaseCandidate(options)
  const dependencies = {
    inspect: options.dependencies?.inspect ?? inspectAndroidApk,
    scan: options.dependencies?.scan ?? scanFiles,
  }
  const operations = {
    rename: options.fileOperations?.rename ?? rename,
    rm: options.fileOperations?.rm ?? rm,
  }
  const inspection = await dependencies.inspect(inspectorArguments(selection))
  const streamedArtifact = await hashReleaseFile(selection.candidatePath)
  const descriptor = createReleaseDescriptor(selection, inspection, streamedArtifact)

  const destinationDirectory = selection.expected.destinationDirectory
  await validateDestination(destinationDirectory)
  const stagingDirectory = await mkdtemp(path.join(path.dirname(destinationDirectory), '.apk-publication-'))
  const stagedApk = path.join(stagingDirectory, CANONICAL_APK_FILENAME)
  const stagedDescriptor = path.join(stagingDirectory, CANONICAL_DESCRIPTOR_FILENAME)
  try {
    await copyFile(selection.candidatePath, stagedApk)
    await writeFile(stagedDescriptor, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await validateExactInventory(stagingDirectory, [CANONICAL_APK_FILENAME, CANONICAL_DESCRIPTOR_FILENAME], 'STAGING_INVENTORY_INVALID')

    const stagedArtifact = await hashReleaseFile(stagedApk)
    if (stagedArtifact.byteSize !== streamedArtifact.byteSize || stagedArtifact.sha256 !== streamedArtifact.sha256) {
      fail('STAGED_APK_MISMATCH', 'publication')
    }
    validateApkDescriptor(JSON.parse(await readFile(stagedDescriptor, 'utf8')), {
      expectedIdentity: {
        applicationId: selection.expected.applicationId,
        versionCode: selection.expected.versionCode,
        versionName: selection.expected.versionName,
        sourceRevision: selection.expected.sourceRevision,
        signer: {
          classification: selection.expected.signerClassification,
          certificateSha256: selection.expected.signerFingerprint,
        },
      },
    })

    const scanResult = await dependencies.scan([selection.candidatePath, stagedDescriptor])
    if (!isRecord(scanResult) || !Array.isArray(scanResult.findings) || scanResult.findings.length > 0) {
      fail('SECRET_SCAN_FAILED', 'security')
    }

    const published = await commitPublishedPair({
      directory: stagingDirectory,
      apk: stagedApk,
      descriptor: stagedDescriptor,
    }, destinationDirectory, operations)
    return Object.freeze({
      status: 'published',
      sourceRevision: descriptor.sourceRevision,
      byteSize: descriptor.byteSize,
      sha256: descriptor.sha256,
      apkPath: published.apkPath,
      descriptorPath: published.descriptorPath,
    })
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

function parseCliArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) fail('ARGUMENTS_INVALID', 'input')
    const name = key.slice(2)
    if (Object.hasOwn(values, name)) fail('ARGUMENTS_INVALID', 'input')
    values[name] = value
  }
  const names = {
    metadata: 'metadataPath',
    destination: 'destinationDirectory',
    dist: 'distPath',
    'source-revision': 'sourceRevision',
    'application-id': 'applicationId',
    'version-code': 'versionCode',
    'version-name': 'versionName',
    label: 'label',
    'launchable-activity': 'launchableActivity',
    'min-sdk': 'minSdk',
    'target-sdk': 'targetSdk',
    'compile-sdk': 'compileSdk',
    'signer-fingerprint': 'signerFingerprint',
    'signer-classification': 'signerClassification',
    'sdk-root': 'sdkRoot',
    'java-home': 'javaHome',
  }
  const options = {}
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(names, key)) fail('ARGUMENTS_INVALID', 'input')
    options[names[key]] = value
  }
  return options
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  try {
    const result = await publishAndroidApk(parseCliArguments(process.argv.slice(2)))
    console.log(JSON.stringify({
      status: result.status,
      sourceRevision: result.sourceRevision,
      byteSize: result.byteSize,
      sha256: result.sha256,
    }))
  } catch (error) {
    const publicationError = error instanceof ApkPublicationError
      ? error
      : new ApkPublicationError('PUBLICATION_FAILED', 'publication')
    console.error(JSON.stringify({ status: 'failed', outcome: publicationError.outcome, code: publicationError.code }))
    process.exitCode = 1
  }
}
