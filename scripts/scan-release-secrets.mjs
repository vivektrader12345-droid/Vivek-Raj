import { execFile } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_SCAN_BYTES = 100 * 1024 * 1024

const sensitivePathPatterns = [
  /(^|\/)(?:local|signing|keystore)[^/]*\.properties$/iu,
  /\.(?:jks|keystore|p12|pfx|pem|key)$/iu,
]
const sensitiveContentPatterns = [
  ['private-key-material', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u],
  ['signing-secret-assignment', /^(?:storePassword|keyPassword|keystorePassword|password|passphrase|keyAlias)\s*[:=]\s*(?!\s*(?:process\.env|System\.getenv|\$\{|<|example\b))\S.+$/imu],
  ['credential-assignment', /^\s*(?:api[_-]?key|client[_-]?secret|secret|token)\s*[:=]\s*["']?(?!process\.env|\$\{|<|example\b)[A-Za-z0-9+/_=-]{8,}/imu],
  ['local-tool-path', /^\s*(?:sdk\.dir|ndk\.dir|java\.home|org\.gradle\.java\.home|storeFile)\s*[:=]\s*(?:[A-Za-z]:[\\/]|\/(?:Users|home|opt|Applications|Library)\/)/imu],
]

function sanitizePath(filePath) {
  const absolute = path.resolve(filePath)
  const relative = path.relative(root, absolute)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.replaceAll('\\', '/')
  return `<external>/${path.basename(absolute).replace(/[^A-Za-z0-9._-]/gu, '_')}`
}

export async function scanFiles(filePaths, read = readFile) {
  const findings = []
  let checked = 0
  for (const filePath of [...new Set(filePaths.map(value => path.resolve(value)))]) {
    let metadata
    try {
      metadata = await lstat(filePath)
    } catch {
      findings.push({ path: sanitizePath(filePath), category: 'unreadable-path' })
      continue
    }
    if (!metadata.isFile()) continue
    checked += 1
    const safePath = sanitizePath(filePath)
    const normalizedPath = safePath.toLowerCase()
    for (const pattern of sensitivePathPatterns) {
      if (pattern.test(normalizedPath)) findings.push({ path: safePath, category: 'sensitive-file-type' })
    }
    if (metadata.size > MAX_SCAN_BYTES) {
      findings.push({ path: safePath, category: 'scan-size-limit' })
      continue
    }
    const content = await read(filePath)
    const text = content.toString('utf8')
    for (const [category, pattern] of sensitiveContentPatterns) {
      if (pattern.test(text)) findings.push({ path: safePath, category })
    }
  }
  return { checked, findings }
}

export function formatReport(result) {
  const byPath = new Map()
  for (const finding of result.findings) {
    const categories = byPath.get(finding.path) ?? new Set()
    categories.add(finding.category)
    byPath.set(finding.path, categories)
  }
  const lines = [`Secret-safe scan: ${result.checked} files checked; ${byPath.size} paths flagged; ${result.findings.length} findings.`]
  for (const [filePath, categories] of [...byPath].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`- ${filePath} (${categories.size} finding categories)`)
  }
  return lines.join('\n')
}

async function gitPaths(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 })
  return stdout.toString('utf8').split('\0').filter(Boolean).map(filePath => path.join(root, filePath))
}

async function releaseFiles(directory) {
  const files = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const destination = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(destination)
      else if (entry.isFile()) files.push(destination)
    }
  }
  await visit(path.resolve(directory))
  return files
}

async function readStagedFile(filePath) {
  const relative = path.relative(root, path.resolve(filePath)).replaceAll('\\', '/')
  const { stdout } = await execFileAsync('git', ['show', `:${relative}`], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: MAX_SCAN_BYTES,
  })
  return stdout
}

async function resolveCliSelection(args) {
  if (args[0] === '--staged' && args.length === 1) {
    return {
      paths: await gitPaths(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']),
      read: readStagedFile,
    }
  }
  if (args[0] === '--changed' && args.length === 1) {
    const groups = await Promise.all([
      gitPaths(['diff', '--name-only', '--diff-filter=ACMR', '-z']),
      gitPaths(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']),
      gitPaths(['ls-files', '--others', '--exclude-standard', '-z']),
    ])
    return { paths: groups.flat(), read: readFile }
  }
  if (args[0] === '--release' && args.length === 2) return { paths: await releaseFiles(args[1]), read: readFile }
  if (args.length > 0 && args.every(argument => !argument.startsWith('--'))) {
    return { paths: args.map(argument => path.resolve(root, argument)), read: readFile }
  }
  throw new Error('Use --changed, --staged, --release <directory>, or an explicit path list')
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  try {
    const selection = await resolveCliSelection(process.argv.slice(2))
    const result = await scanFiles(selection.paths, selection.read)
    console.log(formatReport(result))
    if (result.findings.length > 0) process.exitCode = 1
  } catch (error) {
    console.error(`Secret-safe scan failed: ${error?.code ?? error?.name ?? 'ERROR'}`)
    process.exitCode = 2
  }
}
