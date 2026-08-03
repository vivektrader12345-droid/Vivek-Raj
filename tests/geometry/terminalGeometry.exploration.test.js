import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  evaluateExpectedBehavior,
  generateSupportedWidths,
  intersects,
  viewportContains,
} from './geometryOracle.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const fixturePath = '/tests/geometry/terminalGeometry.fixture.html'
const deterministicViewports = [
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
]
const stressedStates = [
  'default',
  'menu-open-near-edge',
  'rails-expanded',
  'rails-collapsed',
  'dock-expanded',
  'dock-collapsed',
  'paper-order-open',
  'order-overlays-present',
  'stale-error-state',
  'maximum-label-state',
]

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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed')
    }
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

async function waitForPage(client, expression, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(expression)) return
    } catch {}
    await delay(100)
  }
  const pageState = await client.evaluate(`JSON.stringify({
    url: location.href,
    title: document.title,
    bodyText: document.body?.innerText?.slice(0, 1000),
    bodyHtml: document.body?.innerHTML?.slice(0, 2000),
    fixtureDefined: Boolean(window.__terminalGeometryFixture),
    fixtureReady: window.__terminalGeometryFixture?.ready,
  })`).catch(error => JSON.stringify({ diagnosticError: error.message }))
  const runtimeErrors = client.events
    .filter(event => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded')
    .slice(-10)
  throw new Error(`Timed out waiting for browser expression: ${expression}\nPage: ${pageState}\nRuntime events: ${JSON.stringify(runtimeErrors, null, 2)}`)
}

async function startBrowserHarness() {
  const vitePort = await freePort()
  const debuggingPort = await freePort()
  const viteOutput = []
  const viteEntry = path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  const geometryViteConfig = path.join(testDirectory, 'vite.config.js')
  const vite = spawn(process.execPath, [
    viteEntry,
    '--config', geometryViteConfig,
    '--host', '127.0.0.1',
    '--port', String(vitePort),
    '--strictPort',
  ], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  vite.stdout.on('data', chunk => viteOutput.push(chunk.toString()))
  vite.stderr.on('data', chunk => viteOutput.push(chunk.toString()))

  const edgeCandidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  let edgePath = null
  for (const candidate of edgeCandidates) {
    try {
      await access(candidate)
      edgePath = candidate
      break
    } catch {}
  }
  if (!edgePath) throw new Error('Microsoft Edge was not found. Set EDGE_PATH to a Chromium-compatible browser executable.')

  const profileDirectory = path.join(os.tmpdir(), `pro-terminal-geometry-${process.pid}-${Date.now()}`)
  await mkdir(profileDirectory, { recursive: true })
  const browser = spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  try {
    await waitForHttp(`http://127.0.0.1:${vitePort}${fixturePath}`, vite, viteOutput)
    await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, browser, [])
    const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    if (!page?.webSocketDebuggerUrl) throw new Error('No debuggable browser page was available')
    const client = await CdpClient.connect(page.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Page.navigate', { url: `http://127.0.0.1:${vitePort}${fixturePath}` })
    await waitForPage(client, 'Boolean(window.__terminalGeometryFixture?.ready)')
    return { client, vite, browser, profileDirectory, viteOutput }
  } catch (error) {
    vite.kill()
    browser.kill()
    await delay(250)
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function stopBrowserHarness(harness) {
  harness.client?.close()
  harness.vite?.kill()
  harness.browser?.kill()
  await delay(500)
  await rm(harness.profileDirectory, { recursive: true, force: true }).catch(() => {})
}

async function setViewport(client, viewport) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  })
}

async function captureScreenshot(client, targetPath) {
  const { data } = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
  })
  await writeFile(targetPath, Buffer.from(data, 'base64'))
}

function compactCounterexample(snapshot, evaluation) {
  return {
    viewport: snapshot.viewport,
    state: snapshot.state,
    document: snapshot.document,
    expectedInvariant: 'expectedBehavior(X) must hold and isBugCondition(X) must be false.',
    offendingGeometry: evaluation.violations,
    shellGeometry: {
      desktopHeader: snapshot.desktopHeader,
      leftRail: snapshot.leftRail,
      rightRail: snapshot.rightRail,
      dock: snapshot.dock,
      chart: snapshot.chart,
      openMenus: snapshot.openMenus,
    },
  }
}

test('geometry oracle helper examples and generated width domain', () => {
  assert.equal(intersects(
    { left: 0, top: 0, right: 10, bottom: 10 },
    { left: 9, top: 9, right: 20, bottom: 20 },
  ), true)
  assert.equal(intersects(
    { left: 0, top: 0, right: 10, bottom: 10 },
    { left: 10, top: 0, right: 20, bottom: 10 },
  ), false)
  assert.equal(viewportContains(
    { left: 8, top: 8, right: 312, bottom: 592 },
    { width: 320, height: 600 },
    8,
  ), true)

  const widths = generateSupportedWidths()
  assert.ok(widths.length >= 32)
  assert.equal(widths[0], 320)
  assert.equal(widths.at(-1), 2560)
  assert.ok(widths.every(width => Number.isInteger(width) && width >= 320 && width <= 2560))
})

test('Property 1: Bug Condition — Terminal Geometry Is Safe', { timeout: 120_000 }, async () => {
  // **Validates: Requirements 4.9, 8.7, 11.2–11.5, 11.9–11.13**
  const configuredArtifacts = process.env.GEOMETRY_ARTIFACT_DIR
  const artifactRoot = configuredArtifacts
    ? path.resolve(repositoryRoot, configuredArtifacts)
    : path.join(repositoryRoot, 'test-results', 'terminal-geometry')
  const screenshotDirectory = path.join(artifactRoot, 'screenshots')
  await rm(artifactRoot, { recursive: true, force: true })
  await mkdir(screenshotDirectory, { recursive: true })

  const harness = await startBrowserHarness()
  const snapshots = []
  try {
    for (const viewport of deterministicViewports) {
      await setViewport(harness.client, viewport)
      for (const state of stressedStates) {
        await harness.client.evaluate(`window.__terminalGeometryFixture.applyScenario(${JSON.stringify(state)})`)
        const snapshot = await harness.client.evaluate(`window.__terminalGeometryFixture.snapshot(${JSON.stringify(state)})`)
        snapshots.push(snapshot)
        await captureScreenshot(
          harness.client,
          path.join(screenshotDirectory, `${viewport.width}x${viewport.height}-${state}.png`),
        )
      }
    }

    for (const width of generateSupportedWidths()) {
      const height = width < 600 ? 844 : width < 900 ? 1024 : width <= 1366 ? 768 : 1080
      await setViewport(harness.client, { width, height })
      await harness.client.evaluate("window.__terminalGeometryFixture.applyScenario('generated-width-default')")
      snapshots.push(await harness.client.evaluate("window.__terminalGeometryFixture.snapshot('generated-width-default')"))
    }
  } finally {
    await stopBrowserHarness(harness)
  }

  const failures = snapshots
    .map(snapshot => ({ snapshot, evaluation: evaluateExpectedBehavior(snapshot) }))
    .filter(result => !result.evaluation.expectedBehavior)
  const counterexamples = failures.map(({ snapshot, evaluation }) => compactCounterexample(snapshot, evaluation))
  const report = {
    property: 'Property 1: Bug Condition — Terminal Geometry Is Safe',
    validates: ['4.9', '8.7', '11.2', '11.3', '11.4', '11.5', '11.9', '11.10', '11.11', '11.12', '11.13'],
    expectedResultOnUnfixedShell: 'FAIL',
    deterministicViewports,
    generatedWidths: generateSupportedWidths(),
    stressedStates,
    snapshotsEvaluated: snapshots.length,
    failingSnapshots: counterexamples.length,
    counterexamples,
  }
  await writeFile(path.join(artifactRoot, 'counterexamples.json'), `${JSON.stringify(report, null, 2)}\n`)

  assert.equal(
    failures.length,
    0,
    [
      `Property 1 found ${failures.length} unsafe terminal snapshots out of ${snapshots.length}.`,
      `Artifacts: ${path.relative(repositoryRoot, artifactRoot)}`,
      'First concrete counterexample:',
      JSON.stringify(counterexamples[0], null, 2),
    ].join('\n'),
  )
})
