import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const terminalEntryPath = path.join(repositoryRoot, 'src', 'trading', 'ProTrading.jsx')
const terminalStylesPath = path.join(repositoryRoot, 'src', 'trading', 'ProTradingTerminal.css')
const terminalRailsPath = path.join(repositoryRoot, 'src', 'trading', 'components', 'TerminalRails.jsx')
const geometryFixturePath = '/tests/geometry/terminalGeometry.fixture.html'
const geometryViteConfig = path.join(repositoryRoot, 'tests', 'geometry', 'vite.config.js')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const profiles = [
  { name: 'wide desktop', width: 1920, height: 1080, rows: [84, 936, 36, 24], columns: [40, 1520, 320, 40], utilityPosition: 'relative' },
  { name: 'desktop', width: 1366, height: 768, rows: [84, 624, 36, 24], columns: [40, 998, 288, 40], utilityPosition: 'relative' },
  { name: 'compact desktop', width: 1024, height: 768, rows: [80, 630, 36, 22], columns: [36, 952, 36], utilityPosition: 'absolute' },
  { name: 'tablet portrait', width: 768, height: 1024, rows: [48, 44, 892, 40], columns: [768], utilityPosition: 'absolute' },
  { name: 'mobile', width: 390, height: 844, rows: [52, 696, 40, 56], columns: [390], utilityPosition: 'absolute' },
]

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
    this.listeners = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {})
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

  on(method, listener) {
    const listeners = this.listeners.get(method) || []
    listeners.push(listener)
    this.listeners.set(method, listeners)
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

async function startBrowserHarness() {
  const vitePort = await freePort()
  const debuggingPort = await freePort()
  const output = []
  const vite = spawn(process.execPath, [
    path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', geometryViteConfig,
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

  const profileDirectory = path.join(os.tmpdir(), `pro-terminal-grid-${process.pid}-${Date.now()}`)
  await mkdir(profileDirectory, { recursive: true })
  const browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  try {
    await waitForHttp(`http://127.0.0.1:${vitePort}${geometryFixturePath}`, vite, output)
    await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, browser, [])
    const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, 'No debuggable browser page was available')
    const client = await CdpClient.connect(page.webSocketDebuggerUrl)
    const diagnostics = []
    const pendingRequests = new Map()
    const describeRemoteObject = argument => argument.value ?? argument.description ?? argument.type
    client.on('Runtime.consoleAPICalled', event => {
      diagnostics.push(`console.${event.type}: ${event.args.map(describeRemoteObject).join(' ')}`)
    })
    client.on('Runtime.exceptionThrown', event => {
      const details = event.exceptionDetails
      diagnostics.push(`runtime exception: ${details.exception?.description || details.text}`)
    })
    client.on('Log.entryAdded', event => {
      diagnostics.push(`browser ${event.entry.level}: ${event.entry.text}${event.entry.url ? ` (${event.entry.url}:${event.entry.lineNumber})` : ''}`)
    })
    client.on('Network.requestWillBeSent', event => {
      pendingRequests.set(event.requestId, event.request.url)
    })
    client.on('Network.loadingFinished', event => pendingRequests.delete(event.requestId))
    client.on('Network.loadingFailed', event => {
      const url = pendingRequests.get(event.requestId) || event.requestId
      pendingRequests.delete(event.requestId)
      diagnostics.push(`network failure: ${url} — ${event.errorText}${event.blockedReason ? ` (${event.blockedReason})` : ''}`)
    })
    client.on('Network.responseReceived', event => {
      if (event.response.status >= 400) diagnostics.push(`network ${event.response.status}: ${event.response.url}`)
    })
    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Log.enable'),
      client.send('Network.enable'),
    ])
    await client.send('Page.navigate', { url: `http://127.0.0.1:${vitePort}${geometryFixturePath}` })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await client.evaluate('Boolean(window.__terminalGeometryFixture?.ready)').catch(() => false)) {
        return { browser, client, profileDirectory, vite }
      }
      await delay(100)
    }
    const runtimeState = await client.evaluate(`(() => ({
      url: location.href,
      documentReadyState: document.readyState,
      fixtureDefined: typeof window.__terminalGeometryFixture !== 'undefined',
      fixtureReady: Boolean(window.__terminalGeometryFixture?.ready),
      rootChildren: document.querySelector('#root')?.childElementCount ?? null,
      bodyText: document.body?.innerText?.slice(0, 500) || '',
      resources: performance.getEntriesByType('resource').map(entry => ({ name: entry.name, duration: Math.round(entry.duration) })).slice(-20),
    }))()`).catch(error => ({ evaluationError: error.message }))
    const pendingNetwork = [...pendingRequests.values()].slice(-20)
    throw new Error([
      'Timed out waiting for terminal geometry fixture.',
      `Runtime state: ${JSON.stringify(runtimeState, null, 2)}`,
      `Browser diagnostics:\n${diagnostics.join('\n') || '(none)'}`,
      `Pending network requests:\n${pendingNetwork.join('\n') || '(none)'}`,
      `Vite output:\n${output.join('')}`,
    ].join('\n'))
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
  await delay(400)
  await rm(harness.profileDirectory, { recursive: true, force: true }).catch(() => {})
}

const roundedTracks = value => value.split(/\s+/).filter(Boolean).map(track => Math.round(Number.parseFloat(track) * 100) / 100)
const tracksMatch = (actual, expected) => actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]) <= 0.5)

test('terminal source and stylesheet define semantic zero-min-size grid boundaries', async () => {
  const [entry, rails, css] = await Promise.all([
    readFile(terminalEntryPath, 'utf8'),
    readFile(terminalRailsPath, 'utf8'),
    readFile(terminalStylesPath, 'utf8'),
  ])
  const composedSource = `${entry}\n${rails}`

  for (const area of ['header', 'workspace', 'dock', 'status', 'leftRail', 'chartRegion', 'utilityPanel', 'rightRail']) {
    assert.match(composedSource, new RegExp(`data-terminal-area=["']${area}["']`), `missing semantic ${area} boundary`)
  }
  assert.match(css, /height:\s*100vh;\s*height:\s*100dvh;/, '100dvh sizing must retain the 100vh fallback')
  assert.match(css, /grid-template-rows:[\s\S]*?minmax\(0,\s*1fr\)/, 'the shell workspace row must be zero-min-size')
  assert.match(css, /grid-template-columns:[\s\S]*?minmax\(0,\s*1fr\)/, 'the chart column must be zero-min-size')
  assert.match(css, /\.pro-terminal__chart-region,[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0;/, 'grid children must explicitly allow zero minimum sizes')
})

test('computed shell tracks preserve chart allocation and switch utility content to overlays', { timeout: 120_000 }, async () => {
  const harness = await startBrowserHarness()
  try {
    for (const profile of profiles) {
      await harness.client.send('Emulation.setDeviceMetricsOverride', {
        width: profile.width,
        height: profile.height,
        screenWidth: profile.width,
        screenHeight: profile.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await harness.client.evaluate("window.__terminalGeometryFixture.applyScenario('rails-expanded')")
      const snapshot = await harness.client.evaluate(`(() => {
        const root = document.querySelector('[data-pro-terminal]')
        const workspace = document.querySelector('[data-terminal-area="workspace"]')
        const utility = document.querySelector('[data-terminal-area="utilityPanel"]')
        const chart = document.querySelector('[data-terminal-area="chartRegion"]')
        const areas = [...document.querySelectorAll('[data-terminal-area]')]
        const rootStyle = getComputedStyle(root)
        const workspaceStyle = getComputedStyle(workspace)
        const utilityStyle = getComputedStyle(utility)
        const rootRect = root.getBoundingClientRect()
        const chartRect = chart.getBoundingClientRect()
        const utilityRect = utility.getBoundingClientRect()
        return {
          rootDisplay: rootStyle.display,
          rootHeight: rootRect.height,
          rows: rootStyle.gridTemplateRows,
          columns: workspaceStyle.gridTemplateColumns,
          utilityPosition: utilityStyle.position,
          utilityWidth: utilityRect.width,
          chartWidth: chartRect.width,
          chartHeight: chartRect.height,
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          bodyClientWidth: document.body.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
          areaMinimums: areas.map(area => ({
            area: area.dataset.terminalArea,
            minWidth: getComputedStyle(area).minWidth,
            minHeight: getComputedStyle(area).minHeight,
          })),
        }
      })()`)

      const rows = roundedTracks(snapshot.rows)
      const columns = roundedTracks(snapshot.columns)
      assert.equal(snapshot.rootDisplay, 'grid', `${profile.name}: terminal root must be a grid`)
      assert.ok(Math.abs(snapshot.rootHeight - profile.height) <= 0.5, `${profile.name}: root must equal the dynamic viewport height`)
      assert.ok(tracksMatch(rows, profile.rows), `${profile.name}: expected rows ${profile.rows.join(' ')}; received ${rows.join(' ')}`)
      assert.ok(tracksMatch(columns, profile.columns), `${profile.name}: expected columns ${profile.columns.join(' ')}; received ${columns.join(' ')}`)
      assert.equal(snapshot.utilityPosition, profile.utilityPosition, `${profile.name}: unexpected utility mode`)
      if (profile.width < 1200) assert.ok(snapshot.utilityWidth <= 320.5, `${profile.name}: utility drawer exceeded 320px`)
      assert.equal(snapshot.documentScrollWidth, snapshot.documentClientWidth, `${profile.name}: document overflowed horizontally`)
      assert.equal(snapshot.bodyScrollWidth, snapshot.bodyClientWidth, `${profile.name}: body overflowed horizontally`)
      for (const area of snapshot.areaMinimums) {
        assert.equal(area.minWidth, '0px', `${profile.name}: ${area.area} min-width must be zero`)
        assert.equal(area.minHeight, '0px', `${profile.name}: ${area.area} min-height must be zero`)
      }
      if (profile.width === 1366) {
        assert.ok(snapshot.chartWidth >= profile.width * 0.70, `1366 desktop chart width ${snapshot.chartWidth}px is below 70vw`)
        assert.ok(snapshot.chartHeight >= profile.height * 0.60, `1366 desktop chart height ${snapshot.chartHeight}px is below 60vh`)
      }
    }
  } finally {
    await stopBrowserHarness(harness)
  }
})

const rectanglesIntersect = (left, right) => left && right &&
  left.left < right.right - 0.5 && left.right > right.left + 0.5 &&
  left.top < right.bottom - 0.5 && left.bottom > right.top + 0.5

async function pressKey(client, key, code, windowsVirtualKeyCode) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
}

test('rail source keeps independent state and responsive drawers in the shell boundary', async () => {
  const [entry, rails, css] = await Promise.all([
    readFile(terminalEntryPath, 'utf8'),
    readFile(terminalRailsPath, 'utf8'),
    readFile(terminalStylesPath, 'utf8'),
  ])

  assert.match(entry, /<TerminalRails\s+onOpenOrder=\{openOrder\}\s*\/>/, 'the shell must compose the rail boundary once')
  assert.match(rails, /\[leftExpanded,\s*setLeftExpanded\]/, 'the drawing rail needs independent collapse state')
  assert.match(rails, /\[rightExpanded,\s*setRightExpanded\]/, 'the action rail needs independent collapse state')
  assert.match(rails, /aria-controls="pro-terminal-responsive-rail-drawer"/, 'responsive triggers must identify their drawer')
  assert.match(css, /--pro-terminal-left-rail-track:\s*28px/, 'the collapsed left edge must retain 28px')
  assert.match(css, /--pro-terminal-right-rail-track:\s*28px/, 'the collapsed right edge must retain 28px')
  assert.match(css, /grid-template-areas:\s*\n\s*"responsiveRailActions"\s*\n\s*"responsiveRailDrawer"\s*\n\s*"chartRegion"/, 'responsive drawers must occupy an in-flow row before the chart')
})

test('compact rails and responsive drawers preserve geometry, keyboard use, touch targets, and chart safe zones', { timeout: 120_000 }, async () => {
  const harness = await startBrowserHarness()
  const { client } = harness
  const paint = () => client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const railSnapshot = () => client.evaluate(`(() => {
    const rect = element => {
      if (!element) return null
      const value = element.getBoundingClientRect()
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height }
    }
    const visible = element => element && getComputedStyle(element).display !== 'none' && rect(element).width > 0 && rect(element).height > 0
    const left = document.querySelector('.pro-terminal__left-rail')
    const right = document.querySelector('.pro-terminal__right-rail')
    const chart = document.querySelector('[data-terminal-area="chartRegion"]')
    const drawer = document.querySelector('.pro-terminal-responsive-rail-drawer')
    const hud = document.querySelector('.quick-quote')
    const canvases = [...document.querySelectorAll('[data-terminal-area="chartRegion"] canvas')].filter(visible)
    const priceScale = canvases.find(canvas => {
      const value = rect(canvas)
      const chartRect = rect(chart)
      return value.width < chartRect.width * 0.25 && value.height > chartRect.height * 0.45 && value.right >= chartRect.right - 2
    })
    const timeScale = canvases.find(canvas => {
      const value = rect(canvas)
      const chartRect = rect(chart)
      return value.height < chartRect.height * 0.25 && value.width > chartRect.width * 0.45 && value.bottom >= chartRect.bottom - 2
    })
    const responsiveButtons = [...document.querySelectorAll('.pro-terminal-responsive-rail-actions button')].filter(visible)
    const drawerButtons = [...document.querySelectorAll('.pro-terminal-responsive-rail-drawer button')].filter(visible)
    return {
      left: { rect: rect(left), visible: visible(left), collapsed: left?.dataset.collapsed, expanded: left?.querySelector('.pro-terminal-rail__edge-control')?.getAttribute('aria-expanded') },
      right: { rect: rect(right), visible: visible(right), collapsed: right?.dataset.collapsed, expanded: right?.querySelector('.pro-terminal-rail__edge-control')?.getAttribute('aria-expanded') },
      chart: rect(chart), drawer: rect(drawer), hud: rect(hud), priceScale: rect(priceScale), timeScale: rect(timeScale),
      drawerLabel: drawer?.getAttribute('aria-label') || null,
      responsiveButtons: responsiveButtons.map(button => ({ rect: rect(button), label: button.textContent.trim(), expanded: button.getAttribute('aria-expanded') })),
      drawerButtons: drawerButtons.map(button => ({ rect: rect(button), label: button.getAttribute('aria-label') || button.textContent.trim() })),
      focusedLabel: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim() || '',
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }
  })()`)

  try {
    for (const profile of [
      { width: 1366, height: 768, expanded: 40 },
      { width: 1024, height: 768, expanded: 36 },
    ]) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: profile.width, height: profile.height, screenWidth: profile.width, screenHeight: profile.height,
        deviceScaleFactor: 1, mobile: false,
      })
      await client.evaluate("window.__terminalGeometryFixture.applyScenario('rails-expanded')")
      let state = await railSnapshot()
      assert.equal(Math.round(state.left.rect.width), profile.expanded, `${profile.width}: drawing rail width`)
      assert.equal(Math.round(state.right.rect.width), profile.expanded, `${profile.width}: action rail width`)
      assert.ok(state.left.rect.width <= 44 && state.right.rect.width <= 44, `${profile.width}: expanded rails must never exceed 44px`)
      assert.equal(rectanglesIntersect(state.left.rect, state.chart), false, `${profile.width}: drawing rail obscured chart`)
      assert.equal(rectanglesIntersect(state.right.rect, state.chart), false, `${profile.width}: action rail obscured chart`)

      await client.evaluate("document.querySelector('button[aria-label=\"Collapse drawing rail\"]').focus()")
      await pressKey(client, 'Enter', 'Enter', 13)
      await paint()
      state = await railSnapshot()
      assert.equal(Math.round(state.left.rect.width), 28, `${profile.width}: collapsed drawing edge must be 28px`)
      assert.equal(Math.round(state.right.rect.width), profile.expanded, `${profile.width}: collapsing drawing rail must not change action rail`)
      assert.equal(state.left.expanded, 'false')

      await client.evaluate("document.querySelector('button[aria-label=\"Collapse action rail\"]').focus()")
      await pressKey(client, ' ', 'Space', 32)
      await paint()
      state = await railSnapshot()
      assert.equal(Math.round(state.left.rect.width), 28, `${profile.width}: drawing rail must remain independently collapsed`)
      assert.equal(Math.round(state.right.rect.width), 28, `${profile.width}: collapsed action edge must be 28px`)
      assert.equal(state.right.expanded, 'false')
      assert.equal(state.documentWidth, state.viewportWidth, `${profile.width}: rail collapse must not introduce page overflow`)
    }

    for (const profile of [
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: profile.width, height: profile.height, screenWidth: profile.width, screenHeight: profile.height,
        deviceScaleFactor: 1, mobile: true,
      })
      await client.evaluate("window.__terminalGeometryFixture.applyScenario('default')")
      let state = await railSnapshot()
      assert.equal(state.left.visible, false, `${profile.width}: fixed drawing rail must be replaced`)
      assert.equal(state.right.visible, false, `${profile.width}: fixed action rail must be replaced`)
      assert.deepEqual(state.responsiveButtons.map(button => button.label), ['Tools', 'Actions'], `${profile.width}: labeled drawer actions`)
      for (const button of state.responsiveButtons) {
        assert.ok(button.rect.width >= 44 && button.rect.height >= 44, `${profile.width}: ${button.label} trigger must be at least 44x44`)
      }

      await client.evaluate("document.querySelector('.pro-terminal-responsive-rail-actions button:first-child').focus()")
      await pressKey(client, 'Enter', 'Enter', 13)
      await paint()
      state = await railSnapshot()
      assert.equal(state.drawerLabel, 'Drawing tools drawer', `${profile.width}: keyboard must open the labeled tools drawer`)
      assert.equal(state.responsiveButtons[0].expanded, 'true')
      assert.equal(rectanglesIntersect(state.drawer, state.chart), false, `${profile.width}: tools drawer must reflow rather than cover chart`)
      assert.equal(rectanglesIntersect(state.drawer, state.hud), false, `${profile.width}: tools drawer must not cover HUD`)
      assert.equal(rectanglesIntersect(state.drawer, state.priceScale), false, `${profile.width}: tools drawer must not cover price scale`)
      assert.equal(rectanglesIntersect(state.drawer, state.timeScale), false, `${profile.width}: tools drawer must not cover time scale`)
      for (const button of state.drawerButtons) {
        assert.ok(button.rect.width >= 44 && button.rect.height >= 44, `${profile.width}: ${button.label} drawer target must be at least 44x44`)
      }
      await pressKey(client, 'Escape', 'Escape', 27)
      await paint()
      state = await railSnapshot()
      assert.equal(state.drawer, null, `${profile.width}: Escape must close the responsive drawer`)
      assert.match(state.focusedLabel, /Tools/, `${profile.width}: closing must restore focus to Tools`)

      await client.evaluate("document.querySelector('.pro-terminal-responsive-rail-actions button:last-child').click()")
      await paint()
      state = await railSnapshot()
      assert.equal(state.drawerLabel, 'Trading actions drawer', `${profile.width}: touch/click must open the labeled actions drawer`)
      assert.equal(rectanglesIntersect(state.drawer, state.chart), false, `${profile.width}: actions drawer must reflow rather than cover chart`)
      assert.equal(rectanglesIntersect(state.drawer, state.hud), false, `${profile.width}: actions drawer must not cover HUD`)
      assert.equal(rectanglesIntersect(state.drawer, state.priceScale), false, `${profile.width}: actions drawer must not cover price scale`)
      assert.equal(rectanglesIntersect(state.drawer, state.timeScale), false, `${profile.width}: actions drawer must not cover time scale`)
      assert.equal(state.documentWidth, state.viewportWidth, `${profile.width}: responsive drawers must not introduce page overflow`)
      await client.evaluate("document.querySelector('.pro-terminal-responsive-rail-drawer button[aria-label^=\"Close\"]').click()")
      await paint()
    }
  } finally {
    await stopBrowserHarness(harness)
  }
})
