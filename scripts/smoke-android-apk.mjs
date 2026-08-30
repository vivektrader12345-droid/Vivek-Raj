import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { access, lstat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

class SmokeError extends Error {
  constructor(code, outcome, skipped = false) {
    super(code)
    this.name = 'SmokeError'
    this.code = code
    this.outcome = outcome
    this.skipped = skipped
  }
}

function fail(code, outcome) {
  throw new SmokeError(code, outcome)
}

function skip(code, outcome = 'target') {
  throw new SmokeError(code, outcome, true)
}

function executableName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base
}

function parseArguments(argv) {
  const values = {}
  const flags = new Set()
  for (let index = 0; index < argv.length;) {
    const key = argv[index]
    if (key === '--allow-install') {
      if (flags.has(key)) fail('ARGUMENTS_INVALID', 'input')
      flags.add(key)
      index += 1
      continue
    }
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) fail('ARGUMENTS_INVALID', 'input')
    const name = key.slice(2)
    if (Object.hasOwn(values, name)) fail('ARGUMENTS_INVALID', 'input')
    values[name] = value
    index += 2
  }
  const required = ['apk', 'application-id', 'activity', 'mode', 'sdk-root']
  const allowed = new Set([...required, 'serial', 'timeout-ms'])
  if (required.some(name => !values[name]) || Object.keys(values).some(name => !allowed.has(name))) fail('ARGUMENTS_INVALID', 'input')
  return { values, allowInstall: flags.has('--allow-install') }
}

async function validateOptions(argv) {
  const { values, allowInstall } = parseArguments(argv)
  if (!['fresh-install', 'replace'].includes(values.mode)) fail('SMOKE_MODE_INVALID', 'input')
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(values['application-id'])) fail('APPLICATION_ID_INVALID', 'input')
  if (!/^[A-Za-z0-9_.$]+$/u.test(values.activity)) fail('ACTIVITY_INVALID', 'input')
  if (values.serial && !/^[A-Za-z0-9._:-]+$/u.test(values.serial)) fail('SERIAL_INVALID', 'input')
  const timeoutMs = Number(values['timeout-ms'] ?? 120_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) fail('TIMEOUT_INVALID', 'input')
  if (!path.isAbsolute(values['sdk-root'])) fail('SDK_ROOT_INVALID', 'toolchain')
  const apk = path.resolve(values.apk)
  let metadata
  try {
    metadata = await lstat(apk)
  } catch {
    fail('APK_MISSING', 'input')
  }
  if (!metadata.isFile() || metadata.size === 0 || path.extname(apk).toLowerCase() !== '.apk') fail('APK_INVALID', 'input')
  const adb = path.join(path.resolve(values['sdk-root']), 'platform-tools', executableName('adb'))
  try {
    await access(adb)
  } catch {
    fail('ADB_MISSING', 'toolchain')
  }
  return {
    apk,
    applicationId: values['application-id'],
    activity: values.activity,
    mode: values.mode,
    serial: values.serial,
    timeoutMs,
    adb,
    allowInstall,
  }
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  await new Promise(resolve => server.close(resolve))
  if (!port) fail('ADB_PORT_UNAVAILABLE', 'toolchain')
  return port
}

async function runAdb(options, port, args, settings = {}) {
  try {
    return await execFileAsync(options.adb, ['-P', String(port), ...args], {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: settings.timeout ?? options.timeoutMs,
      windowsHide: true,
    })
  } catch (error) {
    if (settings.allowFailure) return { stdout: error?.stdout ?? '', stderr: error?.stderr ?? '', failed: true }
    if (error?.killed || error?.signal) fail('ADB_TIMEOUT', settings.outcome ?? 'device-command')
    fail(settings.code ?? 'ADB_COMMAND_FAILED', settings.outcome ?? 'device-command')
  }
}

function parseAuthorizedDevices(output) {
  return output.split(/\r?\n/u)
    .slice(1)
    .map(line => line.trim().split(/\s+/u))
    .filter(parts => parts.length >= 2 && parts[1] === 'device')
    .map(parts => parts[0])
}

async function selectTarget(options, port) {
  const devices = await runAdb(options, port, ['devices'], { timeout: 15_000, outcome: 'target' })
  const authorized = parseAuthorizedDevices(devices.stdout)
  if (options.serial) {
    if (!authorized.includes(options.serial)) skip('TARGET_NOT_AUTHORIZED')
    return options.serial
  }
  if (authorized.length === 0) skip('NO_AUTHORIZED_ADB_TARGET')
  if (authorized.length > 1) skip('MULTIPLE_TARGETS_REQUIRE_SERIAL')
  return authorized[0]
}

async function packageInstalled(options, port, serial) {
  const result = await runAdb(options, port, ['-s', serial, 'shell', 'pm', 'path', options.applicationId], {
    allowFailure: true,
    timeout: 15_000,
    outcome: 'preflight',
  })
  return !result.failed && /^package:/mu.test(result.stdout)
}

async function installAndLaunch(options, port, serial) {
  const installedBefore = await packageInstalled(options, port, serial)
  if (options.mode === 'fresh-install' && installedBefore) skip('FRESH_INSTALL_REQUIRES_ABSENT_PACKAGE', 'preflight')
  if (options.mode === 'replace' && !installedBefore) skip('REPLACE_REQUIRES_INSTALLED_PACKAGE', 'preflight')
  if (!options.allowInstall) skip('EXPLICIT_INSTALL_CONFIRMATION_REQUIRED', 'preflight')

  const installArgs = ['-s', serial, 'install', '--no-streaming']
  if (options.mode === 'replace') installArgs.push('-r')
  installArgs.push(options.apk)
  const installation = await runAdb(options, port, installArgs, { code: 'INSTALL_FAILED', outcome: 'install' })
  if (!/^Success\s*$/mu.test(installation.stdout)) fail('INSTALL_FAILED', 'install')
  if (!(await packageInstalled(options, port, serial))) fail('INSTALLED_PACKAGE_NOT_FOUND', 'install')

  await runAdb(options, port, ['-s', serial, 'shell', 'am', 'force-stop', options.applicationId], {
    timeout: 15_000,
    code: 'FORCE_STOP_FAILED',
    outcome: 'launch',
  })
  const component = `${options.applicationId}/${options.activity}`
  const launch = await runAdb(options, port, ['-s', serial, 'shell', 'am', 'start', '-W', '-n', component], {
    code: 'LAUNCH_FAILED',
    outcome: 'launch',
  })
  if (!/^Status: ok$/mu.test(launch.stdout)) fail('LAUNCH_FAILED', 'launch')
  const windowState = await runAdb(options, port, ['-s', serial, 'shell', 'dumpsys', 'window', 'windows'], {
    timeout: 20_000,
    code: 'APP_SHELL_NOT_VISIBLE',
    outcome: 'launch',
  })
  if (!windowState.stdout.includes(options.applicationId)) fail('APP_SHELL_NOT_VISIBLE', 'launch')
}

export async function smokeAndroidApk(argv) {
  const options = await validateOptions(argv)
  const port = await reservePort()
  let adbVersion = 'unknown'
  try {
    const version = await runAdb(options, port, ['version'], { timeout: 15_000, outcome: 'toolchain' })
    adbVersion = version.stdout.split(/\r?\n/u).find(Boolean)?.trim().slice(0, 160) ?? 'unknown'
    const serial = await selectTarget(options, port)
    await installAndLaunch(options, port, serial)
    return {
      schemaVersion: 1,
      status: 'pass',
      mode: options.mode,
      package: options.applicationId,
      tools: { adb: adbVersion },
      outcomes: {
        authorizedNonProductionTarget: 'pass',
        install: 'pass',
        packagedShellLaunch: 'pass',
        productionAuthentication: 'not-performed',
        webhooksExchangesTrading: 'not-performed',
      },
    }
  } finally {
    try {
      await runAdb(options, port, ['kill-server'], { allowFailure: true, timeout: 10_000 })
    } catch {
      // The isolated ADB server is best-effort cleaned even after a failed smoke command.
    }
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  try {
    console.log(JSON.stringify(await smokeAndroidApk(process.argv.slice(2)), null, 2))
  } catch (error) {
    const smokeError = error instanceof SmokeError ? error : new SmokeError('SMOKE_FAILED', 'smoke')
    console.error(JSON.stringify({
      schemaVersion: 1,
      status: smokeError.skipped ? 'skipped' : 'fail',
      outcome: smokeError.outcome,
      code: smokeError.code,
    }))
    process.exitCode = smokeError.skipped ? 3 : 1
  }
}
