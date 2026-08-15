import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const androidRoot = path.join(root, 'android')
const wrapperJar = path.join(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar')
const javaHome = process.env.JAVA_HOME
const androidSdkRoot = process.env.ANDROID_SDK_ROOT

for (const [name, value] of [['JAVA_HOME', javaHome], ['ANDROID_SDK_ROOT', androidSdkRoot]]) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute process-local path`)
  await access(value)
}

const javaExecutable = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
await Promise.all([access(javaExecutable), access(wrapperJar)])

const args = process.argv.slice(2)
if (args.length === 0) args.push('assembleDebug')
if (args.some(argument => argument.length === 0 || /[\0\r\n]/u.test(argument))) {
  throw new Error('Gradle arguments must be non-empty and contain no control characters')
}

const child = spawn(javaExecutable, [
  '-Xmx64m',
  '-Xms64m',
  '-Dorg.gradle.appname=gradlew',
  '-classpath',
  '',
  '-jar',
  wrapperJar,
  ...args,
], {
  cwd: androidRoot,
  env: { ...process.env, JAVA_HOME: javaHome, ANDROID_SDK_ROOT: androidSdkRoot },
  stdio: 'inherit',
  shell: false,
})
child.once('error', error => {
  console.error(error.message)
  process.exitCode = 1
})
child.once('exit', code => {
  process.exitCode = code ?? 1
})
