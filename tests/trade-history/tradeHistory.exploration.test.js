import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { generatedSeed, getScenario, isBugCondition, minimizedPrimaryInput, scenarioNames } from './tradeHistoryCases.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const fixturePath = '/tests/trade-history/tradeHistory.fixture.html'
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
        if (this.events.length > 500) this.events.shift()
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
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed')
    }
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
    bodyText: document.body?.innerText?.slice(0, 2000),
    bodyHtml: document.body?.innerHTML?.slice(0, 4000),
    fixture: window.__tradeHistoryFixture,
  })`).catch(error => JSON.stringify({ diagnosticError: error.message }))
  throw new Error(`Timed out waiting for ${expression}\nPage: ${diagnostic}\nEvents: ${JSON.stringify(summarizeEvents(client.events), null, 2)}`)
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

  const profileDirectory = path.join(os.tmpdir(), `trade-history-exploration-${process.pid}-${Date.now()}`)
  await mkdir(profileDirectory, { recursive: true })
  const browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  try {
    await waitForHttp(`http://127.0.0.1:${vitePort}${fixturePath}`, vite, output)
    await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, browser, [])
    const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    if (!page?.webSocketDebuggerUrl) throw new Error('No debuggable browser page was available')
    const client = await CdpClient.connect(page.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Log.enable')
    return { client, vite, browser, profileDirectory, output, vitePort }
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

function remoteArgument(argument) {
  if (Object.hasOwn(argument, 'value')) return argument.value
  return argument.description || argument.unserializableValue || argument.type
}

function summarizeEvents(events) {
  return events.flatMap(event => {
    if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params.exceptionDetails
      return [{
        kind: 'runtime-exception',
        text: details.exception?.description || details.text,
        url: details.url,
        lineNumber: details.lineNumber,
        columnNumber: details.columnNumber,
      }]
    }
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
      return [{
        kind: 'console-error',
        text: event.params.args.map(remoteArgument).join(' '),
        stackTrace: event.params.stackTrace?.callFrames?.slice(0, 5),
      }]
    }
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
      return [{ kind: 'log-error', text: event.params.entry.text, url: event.params.entry.url }]
    }
    return []
  })
}

function jsonReplacer(_key, value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (value === undefined) return '[undefined]'
  return value
}

function evaluateExpectedBehavior(dashboard, route, errors, scenario) {
  const expectedBehavior = dashboard.path === fixturePath &&
    dashboard.recentTradesVisible &&
    dashboard.recentRowCount === 7 &&
    dashboard.viewAllVisible &&
    route.path === '/history' &&
    route.applicationShellVisible &&
    route.tradeHistoryVisible &&
    route.allInputTradeIdentitiesRepresented &&
    route.invalidFieldsUseStableFallbacks &&
    errors.length === 0 &&
    route.errorBoundaryActivated === false
  return {
    expectedBehavior,
    predicates: {
      authenticatedTargetHistory: scenario.userIsAuthenticated && scenario.navigationTarget === '/history',
      dashboardPreviewVisible: dashboard.recentTradesVisible && dashboard.recentRowCount === 7 && dashboard.viewAllVisible,
      pathIsHistory: route.path === '/history',
      applicationShellVisible: route.applicationShellVisible,
      tradeHistoryVisible: route.tradeHistoryVisible,
      allInputTradeIdentitiesRepresented: route.allInputTradeIdentitiesRepresented,
      invalidFieldsUseStableFallbacks: route.invalidFieldsUseStableFallbacks,
      noRuntimeOrConsoleErrors: errors.length === 0,
      noDataShapeBoundaryActivation: route.errorBoundaryActivated === false,
    },
  }
}

test('Property 1: Expected Behavior — Trade History safely renders the full heterogeneous collection', { timeout: 120_000 }, async () => {
  // **Validates: Requirements 2.1, 2.2, 2.3**
  // This is the original Task 1 scenario matrix, now rerun as post-fix verification.
  const artifactDirectory = path.join(testDirectory, 'artifacts')
  const reportPath = path.join(artifactDirectory, 'exploration-report.json')
  const preFixReportPath = path.join(artifactDirectory, 'exploration-report.pre-fix.json')
  await mkdir(artifactDirectory, { recursive: true })
  try {
    await access(reportPath)
    await access(preFixReportPath)
  } catch {
    try { await copyFile(reportPath, preFixReportPath) } catch {}
  }

  const harness = await startBrowserHarness()
  const observations = []
  try {
    for (const scenarioName of scenarioNames) {
      const scenario = getScenario(scenarioName)
      harness.client.events.length = 0
      const url = `http://127.0.0.1:${harness.vitePort}${fixturePath}?case=${encodeURIComponent(scenarioName)}`
      await harness.client.send('Page.navigate', { url })
      await waitForPage(harness.client, `Boolean(window.__tradeHistoryFixture?.ready && window.__tradeHistoryFixture.scenarioName === ${JSON.stringify(scenarioName)})`)

      const fixtureCondition = await harness.client.evaluate('window.__tradeHistoryFixture.isBugCondition')
      assert.equal(fixtureCondition, isBugCondition(scenario), `Browser and Node bug-condition predicates diverged for ${scenarioName}`)
      const dashboard = await harness.client.evaluate('window.__tradeHistoryFixture.dashboardSnapshot()')
      await harness.client.evaluate('window.__tradeHistoryFixture.clickViewAll()')
      await waitForPage(harness.client, `location.pathname === '/history' && ([...document.querySelectorAll('h1')].some(node => node.textContent.includes('Trade History')) || [...document.querySelectorAll('h2')].some(node => node.textContent.includes('Something went wrong')))`)
      await delay(150)
      const route = await harness.client.evaluate('window.__tradeHistoryFixture.routeSnapshot()')
      const errors = summarizeEvents(harness.client.events)
      const evaluation = evaluateExpectedBehavior(dashboard, route, errors, scenario)
      observations.push({
        scenario: scenarioName,
        generatedSeed,
        isBugCondition: isBugCondition(scenario),
        isolatedStorageProbe: scenarioName.startsWith('storage-'),
        inputTradeIds: scenario.trades.map(trade => trade.id),
        inputTrades: scenario.trades,
        storage: scenario.storage,
        dashboard,
        route,
        runtimeAndConsoleErrors: errors,
        ...evaluation,
      })
    }
  } finally {
    await stopBrowserHarness(harness)
  }

  const counterexamples = observations.filter(observation => !observation.expectedBehavior)
  const primary = observations.find(observation => observation.scenario === 'primary')
  const csvOrigin = observations.find(observation => observation.scenario === 'csv-origin')
  const primaryCounterexampleResolved = Boolean(primary?.expectedBehavior)
  const csvOriginCounterexampleResolved = Boolean(csvOrigin?.expectedBehavior)
  const report = {
    property: 'Property 1: Expected Behavior — Trade History Safely Renders the Full Heterogeneous Collection',
    expectedResultAfterFix: 'PASS',
    pbtStatus: counterexamples.length === 0 ? 'passed' : 'failed',
    generatedSeed,
    scenariosEvaluated: observations.length,
    passingScenarios: observations.length - counterexamples.length,
    failingScenarios: counterexamples.length,
    primaryCounterexampleResolved,
    csvOriginCounterexampleResolved,
    minimizedFormerlyFailingInput: minimizedPrimaryInput(),
    preservedPreFixEvidence: path.relative(repositoryRoot, preFixReportPath),
    independentStorageCounterexamples: observations
      .filter(observation => observation.isolatedStorageProbe && !observation.expectedBehavior)
      .map(observation => ({
        scenario: observation.scenario,
        storage: observation.storage,
        boundaryMessage: observation.route.boundaryMessage,
        runtimeAndConsoleErrors: observation.runtimeAndConsoleErrors,
      })),
    observations,
  }
  await writeFile(reportPath, `${JSON.stringify(report, jsonReplacer, 2)}\n`)

  assert.equal(
    counterexamples.length,
    0,
    [
      `Property 1 found ${counterexamples.length} counterexamples across ${observations.length} deterministic scenarios.`,
      `PBT status: ${report.pbtStatus}`,
      `Generated seed: ${generatedSeed}`,
      `Report: ${path.relative(repositoryRoot, reportPath)}`,
      'Minimized formerly failing input:',
      JSON.stringify(report.minimizedFormerlyFailingInput, jsonReplacer, 2),
      'Primary runtime/boundary observation:',
      JSON.stringify({ dashboard: primary?.dashboard, route: primary?.route, errors: primary?.runtimeAndConsoleErrors }, null, 2),
    ].join('\n'),
  )
})
