import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForHttp(url, process, output, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Process exited before ${url} became ready.\n${output.join('')}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${url}.\n${output.join('')}`)
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (!message.id) {
        this.events.push(message)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
      else pending.resolve(message.result)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new CdpClient(socket)
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

function runtimeErrorDetails(events) {
  return events
    .filter(event => event.method === 'Runtime.exceptionThrown')
    .map(event => {
      const details = event.params?.exceptionDetails
      return details?.exception?.description || details?.text || 'Unknown runtime exception'
    })
}

function consoleErrorDetails(events) {
  return events.flatMap(event => {
    if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') {
      const message = event.params.args
        ?.map(argument => argument.value ?? argument.description ?? argument.type)
        .join(' ')
      return [message || 'Unknown console error']
    }
    if (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error') {
      return [event.params.entry.text || 'Unknown log error']
    }
    return []
  })
}

function networkDiagnostics(events, origin) {
  const requests = new Map()
  const failedRequests = []
  const httpErrors = []

  for (const event of events) {
    if (event.method === 'Network.requestWillBeSent') {
      requests.set(event.params.requestId, event.params.request.url)
    } else if (event.method === 'Network.loadingFailed') {
      failedRequests.push({
        url: requests.get(event.params.requestId) || 'unknown',
        error: event.params.errorText || 'Unknown network failure',
      })
    } else if (event.method === 'Network.responseReceived' && event.params.response.status >= 400) {
      httpErrors.push({ url: event.params.response.url, status: event.params.response.status })
    }
  }

  const urls = [...requests.values()]
  const isLocalModule = url => url.startsWith(origin) && (
    url.includes('/src/') || url.includes('/@fs/') || url.includes('/node_modules/') ||
    url.includes('/@vite/') || url.includes('/@react-refresh')
  )

  return {
    requestCount: urls.length,
    localModuleRequestCount: urls.filter(isLocalModule).length,
    localFailures: failedRequests.filter(request => request.url.startsWith(origin)),
    localHttpErrors: httpErrors.filter(response => response.url.startsWith(origin)),
  }
}

async function readStartupSnapshot(client) {
  return client.evaluate(`(() => {
    const root = document.getElementById('root')
    const rect = root?.getBoundingClientRect()
    const rootText = root?.innerText?.trim().slice(0, 500) || ''
    return {
      href: location.href,
      readyState: document.readyState,
      rootChildCount: root?.childElementCount ?? -1,
      rootText,
      bodyText: document.body?.innerText?.trim().slice(0, 500) || '',
      rootVisible: Boolean(root && root.childElementCount > 0 && rect && rect.width > 0 && rect.height > 0),
      authPending: rootText === 'Loading...',
    }
  })()`)
}

async function waitForStartupResult(client, timeout = 60_000) {
  const startedAt = Date.now()
  const deadline = startedAt + timeout
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = await readStartupSnapshot(client)
    if ((snapshot.rootVisible && !snapshot.authPending) || runtimeErrorDetails(client.events).length > 0) {
      return { ...snapshot, elapsedMs: Date.now() - startedAt }
    }
    await delay(100)
  }
  return { ...snapshot, elapsedMs: Date.now() - startedAt }
}

test('application startup renders visible UI without runtime exceptions', { timeout: 120_000 }, async () => {
  const vitePort = await freePort()
  const debuggingPort = await freePort()
  const output = []
  const vite = spawn(process.execPath, [
    path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host', '127.0.0.1',
    '--port', String(vitePort),
    '--strictPort',
  ], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  vite.stdout.on('data', chunk => output.push(chunk.toString()))
  vite.stderr.on('data', chunk => output.push(chunk.toString()))

  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  let browserPath = null
  for (const candidate of candidates) {
    try {
      await access(candidate)
      browserPath = candidate
      break
    } catch {}
  }
  assert.ok(browserPath, 'Microsoft Edge was not found. Set EDGE_PATH to a Chromium-compatible browser executable.')

  const profileDirectory = path.join(os.tmpdir(), `vmt-startup-smoke-${process.pid}-${Date.now()}`)
  await mkdir(profileDirectory, { recursive: true })
  const browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let client
  try {
    const origin = `http://127.0.0.1:${vitePort}`
    await waitForHttp(`${origin}/`, vite, output)
    await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, browser, [])
    const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, 'No debuggable browser page was available')

    client = await CdpClient.connect(page.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Page.setLifecycleEventsEnabled', { enabled: true })
    await client.send('Runtime.enable')
    await client.send('Log.enable')
    await client.send('Network.enable')

    for (const pathname of ['/', '/pro-trading']) {
      client.events.length = 0
      await client.send('Page.navigate', { url: `${origin}${pathname}` })

      const snapshot = await waitForStartupResult(client)
      await delay(250)
      const runtimeErrors = runtimeErrorDetails(client.events)
      const consoleErrors = consoleErrorDetails(client.events)
      const network = networkDiagnostics(client.events, origin)
      const lifecycle = client.events
        .filter(event => event.method === 'Page.lifecycleEvent')
        .map(event => event.params.name)
      const diagnostic = { pathname, ...snapshot, runtimeErrors, consoleErrors, network, lifecycle }

      assert.deepEqual(runtimeErrors, [], `Startup runtime exceptions: ${JSON.stringify(diagnostic, null, 2)}`)
      assert.deepEqual(network.localFailures, [], `Startup local module failures: ${JSON.stringify(diagnostic, null, 2)}`)
      assert.deepEqual(network.localHttpErrors, [], `Startup local HTTP errors: ${JSON.stringify(diagnostic, null, 2)}`)
      assert.equal(snapshot?.rootVisible, true, `Application root remained blank: ${JSON.stringify(diagnostic, null, 2)}`)
      assert.equal(snapshot?.authPending, false, `Application remained on auth loading UI: ${JSON.stringify(diagnostic, null, 2)}`)
      console.log(`Startup smoke route: ${JSON.stringify(diagnostic)}`)
    }
  } finally {
    client?.close()
    vite.kill()
    browser.kill()
    await delay(400)
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {})
  }
})
