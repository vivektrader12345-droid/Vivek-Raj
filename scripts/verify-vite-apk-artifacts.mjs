import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CANONICAL_APK_FILENAME,
  validateApkDescriptor,
} from '../src/components/apkDescriptorContract.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CANONICAL_DESCRIPTOR_FILENAME = `${CANONICAL_APK_FILENAME}.json`
const EXPECTED_INVENTORY = Object.freeze([
  CANONICAL_APK_FILENAME,
  CANONICAL_DESCRIPTOR_FILENAME,
])
const MAX_DESCRIPTOR_BYTES = 64 * 1024
const ZIP_PREFIX = Buffer.from([0x50, 0x4b, 0x03, 0x04])

export class ViteApkArtifactError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ViteApkArtifactError'
    this.code = code
  }
}

function fail(code) {
  throw new ViteApkArtifactError(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateOptions(options) {
  if (!isRecord(options)) fail('OPTIONS_INVALID')
  const allowed = new Set(['distDirectory', 'expectedIdentity', 'publicDirectory'])
  if (Object.keys(options).some(key => !allowed.has(key))) fail('OPTIONS_INVALID')
  for (const key of ['publicDirectory', 'distDirectory']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key])) fail('OPTIONS_INVALID')
  }
  return {
    publicDirectory: path.resolve(options.publicDirectory ?? path.join(root, 'public', 'downloads')),
    distDirectory: path.resolve(options.distDirectory ?? path.join(root, 'dist', 'downloads')),
    expectedIdentity: options.expectedIdentity,
  }
}

async function requireExactInventory(directory, label) {
  let metadata
  let entries
  try {
    metadata = await lstat(directory)
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    fail(`${label}_INVENTORY_MISSING`)
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(`${label}_INVENTORY_INVALID`)

  const names = entries.map(entry => entry.name).sort()
  if (names.length !== EXPECTED_INVENTORY.length
    || names.some((name, index) => name !== EXPECTED_INVENTORY[index])) {
    fail(`${label}_INVENTORY_INVALID`)
  }
  if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) fail(`${label}_INVENTORY_INVALID`)
}

async function requireRegularFile(filePath, label) {
  let metadata
  try {
    metadata = await lstat(filePath)
  } catch {
    fail(`${label}_MISSING`)
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label}_INVALID`)
  return metadata
}

async function readDescriptor(filePath, label) {
  const metadata = await requireRegularFile(filePath, `${label}_DESCRIPTOR`)
  if (metadata.size < 2 || metadata.size > MAX_DESCRIPTOR_BYTES) fail(`${label}_DESCRIPTOR_SIZE_INVALID`)
  try {
    return await readFile(filePath)
  } catch {
    fail(`${label}_DESCRIPTOR_UNREADABLE`)
  }
}

function parseDescriptor(bytes, label, expectedIdentity) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
    return validateApkDescriptor(value, expectedIdentity === undefined ? {} : { expectedIdentity })
  } catch {
    fail(`${label}_DESCRIPTOR_INVALID`)
  }
}

function descriptorIdentity(descriptor) {
  return {
    applicationId: descriptor.applicationId,
    versionCode: descriptor.versionCode,
    versionName: descriptor.versionName,
    sourceRevision: descriptor.sourceRevision,
    signer: descriptor.signer,
  }
}

async function streamArtifact(filePath, label) {
  const hash = createHash('sha256')
  let byteSize = 0
  let prefix = Buffer.alloc(0)
  try {
    await new Promise((resolve, reject) => {
      const stream = createReadStream(filePath)
      stream.on('data', chunk => {
        if (prefix.length < ZIP_PREFIX.length) {
          prefix = Buffer.concat([prefix, chunk.subarray(0, ZIP_PREFIX.length - prefix.length)])
        }
        byteSize += chunk.length
        hash.update(chunk)
      })
      stream.once('end', resolve)
      stream.once('error', reject)
    })
  } catch {
    fail(`${label}_APK_UNREADABLE`)
  }
  return { byteSize, prefix, sha256: hash.digest('hex') }
}

async function verifyArtifact(filePath, label, descriptor) {
  const metadata = await requireRegularFile(filePath, `${label}_APK`)
  if (metadata.size !== descriptor.byteSize) fail(`${label}_APK_SIZE_MISMATCH`)

  const artifact = await streamArtifact(filePath, label)
  if (artifact.byteSize !== descriptor.byteSize) fail(`${label}_APK_SIZE_MISMATCH`)
  if (!artifact.prefix.equals(ZIP_PREFIX)) fail(`${label}_APK_PREFIX_INVALID`)
  if (artifact.sha256 !== descriptor.sha256) fail(`${label}_APK_DIGEST_MISMATCH`)
  return artifact
}

export async function verifyViteApkArtifacts(options = {}) {
  const resolved = validateOptions(options)
  await requireExactInventory(resolved.publicDirectory, 'PUBLIC')
  await requireExactInventory(resolved.distDirectory, 'DIST')

  const publicDescriptorPath = path.join(resolved.publicDirectory, CANONICAL_DESCRIPTOR_FILENAME)
  const distDescriptorPath = path.join(resolved.distDirectory, CANONICAL_DESCRIPTOR_FILENAME)
  const [publicDescriptorBytes, distDescriptorBytes] = await Promise.all([
    readDescriptor(publicDescriptorPath, 'PUBLIC'),
    readDescriptor(distDescriptorPath, 'DIST'),
  ])
  if (!publicDescriptorBytes.equals(distDescriptorBytes)) fail('DIST_DESCRIPTOR_BYTES_MISMATCH')

  const publicDescriptor = parseDescriptor(publicDescriptorBytes, 'PUBLIC', resolved.expectedIdentity)
  const approvedIdentity = descriptorIdentity(publicDescriptor)
  const distDescriptor = parseDescriptor(distDescriptorBytes, 'DIST', approvedIdentity)

  // Verify the canonical source before the copied build output. Sequential
  // ordering keeps fail-closed diagnostics deterministic when both sides share
  // the same stale descriptor, while still requiring both artifacts to pass.
  const publicArtifact = await verifyArtifact(
    path.join(resolved.publicDirectory, CANONICAL_APK_FILENAME),
    'PUBLIC',
    publicDescriptor,
  )
  const distArtifact = await verifyArtifact(
    path.join(resolved.distDirectory, CANONICAL_APK_FILENAME),
    'DIST',
    distDescriptor,
  )
  if (publicArtifact.byteSize !== distArtifact.byteSize
    || publicArtifact.sha256 !== distArtifact.sha256
    || !publicArtifact.prefix.equals(distArtifact.prefix)) fail('PUBLIC_DIST_APK_MISMATCH')

  return Object.freeze({
    status: 'verified',
    sourceRevision: distDescriptor.sourceRevision,
    byteSize: distArtifact.byteSize,
    sha256: distArtifact.sha256,
    inventory: EXPECTED_INVENTORY,
  })
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  try {
    if (process.argv.length !== 2) fail('ARGUMENTS_INVALID')
    const result = await verifyViteApkArtifacts()
    console.log(JSON.stringify(result))
  } catch (error) {
    const code = error instanceof ViteApkArtifactError ? error.code : 'ARTIFACT_VERIFICATION_FAILED'
    console.error(JSON.stringify({ status: 'failed', code }))
    process.exitCode = 1
  }
}
