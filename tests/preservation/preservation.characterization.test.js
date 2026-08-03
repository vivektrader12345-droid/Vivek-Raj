import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const fixtureUrl = '/tests/preservation/preservation.fixture.html'
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
    await delay(150)
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
        if (this.events.length > 200) this.events.shift()
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Browser debugging socket closed'))
      this.pending.clear()
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed')
    return result.result.value
  }

  close() { this.socket.close() }
}

async function waitForPage(client, expression, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(expression)) return
    } catch {}
    await delay(100)
  }
  const diagnostic = await client.evaluate(`JSON.stringify({
    url: location.href,
    bodyText: document.body?.innerText?.slice(0, 1000),
    bodyHtml: document.body?.innerHTML?.slice(0, 2000),
    ready: window.__preservationFixture?.ready,
  })`).catch(error => JSON.stringify({ diagnosticError: error.message }))
  const runtimeErrors = client.events.filter(event => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded').slice(-10)
  throw new Error(`Timed out waiting for ${expression}\nPage: ${diagnostic}\nRuntime: ${JSON.stringify(runtimeErrors, null, 2)}`)
}

async function startBrowserHarness() {
  const vitePort = await freePort()
  const debuggingPort = await freePort()
  const output = []
  const vite = spawn(process.execPath, [
    path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', path.join(testDirectory, 'vite.config.js'),
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
    try { await access(candidate); browserPath = candidate; break } catch {}
  }
  if (!browserPath) throw new Error('Microsoft Edge was not found. Set EDGE_PATH to a Chromium-compatible browser executable.')

  const profileDirectory = path.join(os.tmpdir(), `pro-preservation-${process.pid}-${Date.now()}`)
  await mkdir(profileDirectory, { recursive: true })
  const browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  try {
    await waitForHttp(`http://127.0.0.1:${vitePort}${fixtureUrl}`, vite, output)
    await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, browser, [])
    const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    if (!page?.webSocketDebuggerUrl) throw new Error('No debuggable browser page was available')
    const client = await CdpClient.connect(page.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Page.navigate', { url: `http://127.0.0.1:${vitePort}${fixtureUrl}` })
    await waitForPage(client, 'Boolean(window.__preservationFixture?.ready)')
    return { client, vite, browser, profileDirectory, output }
  } catch (error) {
    vite.kill()
    browser.kill()
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function stopBrowserHarness(harness) {
  harness.client?.close()
  harness.vite?.kill()
  harness.browser?.kill()
  await delay(400)
  await rm(harness.profileDirectory, { recursive: true, force: true }).catch(() => {})
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(target)
    return /\.(?:js|jsx|ts|tsx)$/.test(entry.name) ? [target] : []
  }))
  return nested.flat()
}

test('preservation manifest records the observed unfixed-product boundaries', async () => {
  const manifest = JSON.parse(await readFile(path.join(testDirectory, 'observed-contracts.json'), 'utf8'))
  assert.equal(manifest.observationBaseline, 'unfixed-product-before-terminal-layout-fix')
  assert.equal(manifest.paperStore.storageKey, 'pro-trading-store')
  assert.deepEqual(manifest.paperStore.persistedSubset, ['account', 'pendingOrders', 'positions', 'trades'])
  assert.equal(manifest.chart.version, '4.1.1')
  assert.equal(manifest.journalBridge.mountedWriters, 1)

  const srcFiles = await sourceFiles(path.join(repositoryRoot, 'src'))
  const sources = await Promise.all(srcFiles.map(async file => ({ file, text: await readFile(file, 'utf8') })))
  const proTrading = sources.find(item => item.file.endsWith(`${path.sep}trading${path.sep}ProTrading.jsx`)).text
  const tradingStore = sources.find(item => item.file.endsWith(`${path.sep}trading${path.sep}stores${path.sep}tradingStore.js`)).text
  const binance = sources.find(item => item.file.endsWith(`${path.sep}trading${path.sep}utils${path.sep}binanceWS.js`)).text
  const bridge = sources.find(item => item.file.endsWith(`${path.sep}trading${path.sep}useTradeBridge.js`)).text
  const dashboard = sources.find(item => item.file.endsWith(`${path.sep}pages${path.sep}Dashboard.jsx`)).text
  const history = sources.find(item => item.file.endsWith(`${path.sep}pages${path.sep}TradeHistory.jsx`)).text
  const manual = sources.find(item => item.file.endsWith(`${path.sep}pages${path.sep}AddTrade.jsx`)).text
  const auth = sources.find(item => item.file.endsWith(`${path.sep}context${path.sep}AuthContext.jsx`)).text
  const tradeContext = sources.find(item => item.file.endsWith(`${path.sep}context${path.sep}TradeContext.jsx`)).text
  const settings = sources.find(item => item.file.endsWith(`${path.sep}pages${path.sep}Settings.jsx`)).text
  const app = sources.find(item => item.file.endsWith(`${path.sep}App.jsx`)).text
  const lock = await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8')

  assert.match(tradingStore, /name: 'pro-trading-store'/)
  for (const key of manifest.paperStore.persistedSubset) assert.match(tradingStore, new RegExp(`${key}: state\\.${key}`))
  assert.equal(sources.filter(item => item.text.includes("from './useTradeBridge'")).length, 1)
  assert.equal((proTrading.match(/\buseTradeBridge\(\)/g) || []).length, 1)
  assert.match(bridge, /prevTradesCountRef\.current = currentCount[\s\S]*state\.trades\.slice\(prevCount, currentCount\)/)
  assert.match(bridge, /source: 'pro_trading'/)
  assert.match(bridge, /tradeId: `pro_\$\{closedTrade\.id\}`/)
  assert.match(binance, /https:\/\/api\.binance\.com\/api\/v3/)
  assert.match(binance, /wss:\/\/stream\.binance\.com:9443\/ws/)
  assert.doesNotMatch(binance, /apiKey|signature|private endpoint/i)
  assert.match(lock, /"node_modules\/lightweight-charts": \{\s*"version": "4\.1\.1"/)
  assert.match(proTrading, /takeScreenshot\(\)/)
  assert.match(proTrading, /setIsFullscreen/)
  assert.match(dashboard, /useTrades\(\)/)
  assert.match(history, /useTrades\(\)/)
  assert.match(manual, /const \{ addTrade, updateTrade, getTradeById \} = useTrades\(\)/)
  assert.match(auth, /onAuthStateChanged\(auth/)
  assert.match(tradeContext, /auth\.currentUser\?\.uid \|\| user\?\.uid/)
  assert.match(settings, /const \{ user, updateProfile, updateSettings, changePassword \} = useAuth\(\)/)
  for (const route of ['/', 'add-trade', 'history', 'settings', '/pro-trading']) assert.ok(app.includes(`path="${route}"`) || (route === '/' && app.includes('Route index')))
})

test('Property 2: Preservation — Paper Trading and Journal Behavior', { timeout: 120_000 }, async () => {
  // **Validates: Requirements 1.1–1.5, 9.4–9.7, 10.5, 10.8–10.9, 11.7–11.8, 11.12**
  const harness = await startBrowserHarness()
  let report
  try {
    const paper = await harness.client.evaluate('window.__preservationFixture.characterizePaperTrading()')
    const binance = await harness.client.evaluate('window.__preservationFixture.characterizeBinanceLifecycle()')
    const chart = await harness.client.evaluate('window.__preservationFixture.characterizeChart()')
    const bridge = await harness.client.evaluate('window.__preservationFixture.characterizeTradeBridge()')
    report = {
      property: 'Property 2: Preservation — Paper Trading and Journal Behavior',
      baseline: 'unfixed-product-before-terminal-layout-fix',
      result: 'PASS',
      paper,
      binance,
      chart,
      bridge,
    }
  } finally {
    await stopBrowserHarness(harness)
  }

  assert.equal(report.paper.generatedHistories, 16)
  assert.equal(report.paper.generatedTransitions, 640)
  assert.deepEqual(report.paper.persistedKeys, ['account', 'pendingOrders', 'positions', 'trades'])
  assert.equal(report.binance.reconnectDelayMs, 3000)
  assert.equal(report.binance.explicitCleanup, true)
  assert.equal(report.chart.engineVersion, '4.1.1')
  assert.equal(report.chart.refsCleared, true)
  assert.equal(report.bridge.baselineSkipped, true)
  assert.equal(report.bridge.countAdvancedBeforeAsyncSettlement, true)
  assert.equal(report.bridge.retryAttemptsForSameIdentity, 2)
  assert.deepEqual(report.bridge.source, ['pro_trading'])

  const artifactDirectory = path.join(repositoryRoot, 'test-results', 'preservation')
  await rm(artifactDirectory, { recursive: true, force: true })
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(path.join(artifactDirectory, 'observations.json'), `${JSON.stringify(report, null, 2)}\n`)
})
