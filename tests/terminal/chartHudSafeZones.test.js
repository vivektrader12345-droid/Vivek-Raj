/**
 * Task 3.7 — Chart HUD and paper-overlay safe-zone tests.
 *
 * Validates:
 *  - Static: CSS declares HUD tokens, overlay-lane class, and overlay z-index
 *  - Static: ProChart uses the overlay-lane wrapper and increased price-scale margin
 *  - Runtime: rectangle-intersection checks at 1024×768, 1366×768, 1920×1080, 390×844
 *  - Runtime: paper positions/order overlays do not obscure OHLC row, quote box, or
 *    price/time scales; maximum-overlay scenario covers all four required viewports.
 *
 * Requirements: 1.1–1.2, 11.2–11.3, 11.6–11.7, 11.12–11.13
 */
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
const terminalStylesPath = path.join(repositoryRoot, 'src', 'trading', 'ProTradingTerminal.css')
const proChartPath = path.join(repositoryRoot, 'src', 'trading', 'components', 'ProChart.jsx')
const geometryFixturePath = '/tests/geometry/terminalGeometry.fixture.html'
const geometryViteConfig = path.join(repositoryRoot, 'tests', 'geometry', 'vite.config.js')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Four required acceptance viewports from requirements 11.13 */
const ACCEPTANCE_VIEWPORTS = [
  { name: '1024×768 compact desktop', width: 1024, height: 768 },
  { name: '1366×768 desktop',         width: 1366, height: 768 },
  { name: '1920×1080 wide desktop',   width: 1920, height: 1080 },
  { name: '390×844 mobile',           width: 390,  height: 844  },
]

// ---------------------------------------------------------------------------
// Static source checks (no browser needed)
// ---------------------------------------------------------------------------

test('CSS defines HUD safe-zone tokens and approved overlay-lane structure', async () => {
  const css = await readFile(terminalStylesPath, 'utf8')

  // HUD tokens
  assert.match(css, /--chart-hud-inset:\s*8px/, 'must define --chart-hud-inset: 8px')
  assert.match(css, /--chart-hud-legend-height:\s*32px/, 'must define --chart-hud-legend-height: 32px')
  assert.match(css, /--chart-hud-quote-offset:\s*48px/, 'must define --chart-hud-quote-offset: 48px')
  assert.match(css, /--chart-price-scale-width:\s*7[0-9]px/, 'must define --chart-price-scale-width (70px+)')
  assert.match(css, /--chart-overlay-lane-offset/, 'must define --chart-overlay-lane-offset')
  assert.match(css, /--chart-overlay-lane-width/, 'must define --chart-overlay-lane-width')

  // Overlay lane class
  assert.match(css, /\.pro-chart-overlay-lane/, 'must define .pro-chart-overlay-lane')
  assert.match(css, /\.pro-chart-overlay-lane[\s\S]*?z-index:\s*var\(--pro-layer-order-overlays\)/, 'overlay lane must use the approved order-overlays layer token (z-index 24)')
  assert.match(css, /\.pro-chart-overlay-lane[\s\S]*?pointer-events:\s*none/, 'overlay lane must be pointer-events:none to preserve chart interaction')

  // Compact label
  assert.match(css, /\.pro-chart-overlay-label/, 'must define .pro-chart-overlay-label')
  assert.match(css, /\.pro-chart-overlay-label[\s\S]*?opacity:\s*0\.92/, 'overlay labels must use 0.92 opacity (non-obscuring)')
  assert.match(css, /\.pro-chart-overlay-label[\s\S]*?max-width:\s*260px/, 'overlay labels must be capped to 260px width')
  assert.match(css, /\.pro-chart-overlay-label[\s\S]*?font-variant-numeric:\s*tabular-nums/, 'overlay labels must use tabular-nums for price alignment')

  // quick-quote still uses the tile-hud layer and clears the legend row
  // (top:48px appears in the main .quick-quote rule declared earlier in the stylesheet)
  assert.match(css, /\.quick-quote[\s\S]{0,200}top:\s*48px/, 'quote box must anchor at 48px (below 8px inset + 32px legend row)')
  assert.match(css, /\.quick-quote[\s\S]{0,200}z-index:\s*var\(--pro-layer-tile-hud\)/, 'quote box z-index must use the tile-hud layer token')

  // The overlay lane width adjustments at different viewports
  assert.match(css, /min-width: 1600px[\s\S]*?--chart-overlay-lane-width:\s*320px/, '1920 viewport must use a 320px overlay lane')
  assert.match(css, /min-width: 900px[\s\S]*?max-width: 1199\.98px[\s\S]*?--chart-overlay-lane-width:\s*25[0-9]px/, '1024 viewport must define a compact overlay lane width')
})

test('ProChart applies increased price-scale top margin and wraps overlay lane', async () => {
  const source = await readFile(proChartPath, 'utf8')

  // Increased price-scale top margin for HUD headroom (0.12 vs old 0.08)
  assert.match(source, /scaleMargins:\s*\{[\s\S]*?top:\s*\.12/, 'price-scale top margin must be increased to 0.12 for HUD headroom')

  // Overlay lane wrapper
  assert.match(source, /pro-chart-overlay-lane/, 'ProChart must render the .pro-chart-overlay-lane wrapper')
  assert.match(source, /data-chart-overlay-lane/, 'the overlay lane element must carry the data-chart-overlay-lane attribute')

  // OHLC legend still uses the HUD role attribute
  assert.match(source, /data-chart-hud="symbol-ohlc"/, 'OHLC legend must carry data-chart-hud="symbol-ohlc" for safe-zone identification')
})

// ---------------------------------------------------------------------------
// Browser harness (shared with other geometry tests)
// ---------------------------------------------------------------------------

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

async function waitForHttp(url, proc, output, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Process exited before ${url} became ready.\n${output.join('')}`)
    try { const r = await fetch(url); if (r.ok) return } catch {}
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
      const msg = JSON.parse(event.data)
      if (!msg.id) {
        for (const listener of (this.listeners.get(msg.method) || [])) listener(msg.params || {})
        return
      }
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`))
      else pending.resolve(msg.result)
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

  close() { this.socket.close() }
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
    try { await access(candidate); browserPath = candidate; break } catch {}
  }
  assert.ok(browserPath, 'Microsoft Edge was not found. Set EDGE_PATH to a Chromium-compatible browser executable.')

  const profileDirectory = path.join(os.tmpdir(), `pro-terminal-hud-${process.pid}-${Date.now()}`)
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
    const page = targets.find(t => t.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, 'No debuggable browser page was available')
    const client = await CdpClient.connect(page.webSocketDebuggerUrl)
    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
    ])
    await client.send('Page.navigate', { url: `http://127.0.0.1:${vitePort}${geometryFixturePath}` })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await client.evaluate('Boolean(window.__terminalGeometryFixture?.ready)').catch(() => false)) {
        return { browser, client, profileDirectory, vite }
      }
      await delay(100)
    }
    throw new Error('Timed out waiting for terminal geometry fixture.')
  } catch (error) {
    vite.kill(); browser.kill()
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

const overlapsRect = (a, b) => a && b &&
  a.left < b.right - 0.5 && a.right > b.left + 0.5 &&
  a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5

// ---------------------------------------------------------------------------
// HUD safe-zone snapshot helper
// ---------------------------------------------------------------------------
const HUD_SNAPSHOT_EXPRESSION = `(() => {
  const rect = el => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left*100)/100, top: Math.round(r.top*100)/100,
             right: Math.round(r.right*100)/100, bottom: Math.round(r.bottom*100)/100,
             width: Math.round(r.width*100)/100, height: Math.round(r.height*100)/100 }
  }
  const rendered = el => {
    if (!el) return false
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 &&
           r.width > 0 && r.height > 0
  }
  const chart     = document.querySelector('[data-terminal-area="chartRegion"]')
  const ohlcEl    = document.querySelector('[data-chart-hud="symbol-ohlc"]')
  const quoteEl   = document.querySelector('.quick-quote')
  const laneEl    = document.querySelector('[data-chart-overlay-lane]')
  const canvases  = [...(chart?.querySelectorAll('canvas') || [])].filter(rendered)
  const chartRect = rect(chart) || { left:0, top:0, right:0, bottom:0, width:0, height:0 }
  const priceScale = canvases.find(c => {
    const r = rect(c)
    return r && r.width < chartRect.width * 0.25 && r.height > chartRect.height * 0.45 && r.right >= chartRect.right - 2
  })
  const timeScale = canvases.find(c => {
    const r = rect(c)
    return r && r.height < chartRect.height * 0.25 && r.width > chartRect.width * 0.45 && r.bottom >= chartRect.bottom - 2
  })
  // collect paper order/position overlay labels rendered inside the chart
  const overlayLabels = [
    ...(chart?.querySelectorAll('.pro-chart-overlay-label') || []),
    ...(chart?.querySelectorAll('[data-chart-overlay-lane] .pointer-events-auto > div') || []),
    // legacy OrderOverlay labels from .pointer-events-auto > div in chart
    ...(chart?.querySelectorAll('.pointer-events-auto > div:not([class*="absolute inset"])') || []),
  ].filter(el => rendered(el) && /\\b(BUY|SELL|TP|SL|LIMIT|STOP|Entry|paper)\\b/i.test(el.textContent))
  return {
    chart: chartRect,
    ohlc: rect(ohlcEl),
    quote: rendered(quoteEl) ? rect(quoteEl) : null,
    lane: rect(laneEl),
    priceScale: rect(priceScale),
    timeScale: rect(timeScale),
    overlayLabels: overlayLabels.map((el, i) => ({
      role: 'overlay:' + (el.textContent || '').trim().slice(0, 40) + ':' + i,
      rect: rect(el),
    })),
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }
})()`

// ---------------------------------------------------------------------------
// Runtime tests
// ---------------------------------------------------------------------------

test('HUD safe zones and paper-overlay lane are non-obscuring at all four acceptance viewports', { timeout: 180_000 }, async () => {
  const harness = await startBrowserHarness()
  const { client } = harness
  const paint = (n = 4) => client.evaluate(`new Promise(r => { let f=${n}; const tick = () => { if (--f<=0) r(); else requestAnimationFrame(tick) }; requestAnimationFrame(tick) })`)

  try {
    for (const vp of ACCEPTANCE_VIEWPORTS) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height,
        screenWidth: vp.width, screenHeight: vp.height,
        deviceScaleFactor: 1, mobile: vp.width < 600,
      })

      // --- default state with quote box visible ---
      await client.evaluate("window.__terminalGeometryFixture.applyScenario('default')")
      await paint()
      let snap = await client.evaluate(HUD_SNAPSHOT_EXPRESSION)

      // no page-level horizontal overflow
      assert.equal(snap.documentScrollWidth, snap.documentClientWidth,
        `${vp.name}: default state must not cause horizontal page overflow`)

      // OHLC row is visible
      assert.ok(snap.ohlc && snap.ohlc.width > 0 && snap.ohlc.height > 0,
        `${vp.name}: OHLC/symbol legend row must be rendered`)

      // quote box (when present) does not cover the OHLC row
      if (snap.quote) {
        assert.equal(overlapsRect(snap.quote, snap.ohlc), false,
          `${vp.name}: quote box must not overlap the OHLC/symbol legend row; ` +
          `quote=${JSON.stringify(snap.quote)} ohlc=${JSON.stringify(snap.ohlc)}`)
      }

      // overlay lane (when present) does not cover the price scale
      if (snap.lane && snap.priceScale) {
        assert.equal(overlapsRect(snap.lane, snap.priceScale), false,
          `${vp.name}: overlay lane must not cover the price scale; ` +
          `lane=${JSON.stringify(snap.lane)} priceScale=${JSON.stringify(snap.priceScale)}`)
      }

      // --- order-overlays-present scenario (max positions + pending order) ---
      await client.evaluate("window.__terminalGeometryFixture.applyScenario('order-overlays-present')")
      await paint(6)
      snap = await client.evaluate(HUD_SNAPSHOT_EXPRESSION)

      // no page-level horizontal overflow
      assert.equal(snap.documentScrollWidth, snap.documentClientWidth,
        `${vp.name}: order-overlays-present must not cause horizontal page overflow`)

      // OHLC row still visible
      assert.ok(snap.ohlc && snap.ohlc.width > 0 && snap.ohlc.height > 0,
        `${vp.name}: OHLC/symbol legend row must remain visible with overlays present`)

      // quote box (when present) does not cover OHLC row even with overlays
      if (snap.quote) {
        assert.equal(overlapsRect(snap.quote, snap.ohlc), false,
          `${vp.name}: quote box must not overlap OHLC row when overlays are present; ` +
          `quote=${JSON.stringify(snap.quote)} ohlc=${JSON.stringify(snap.ohlc)}`)
      }

      // overlay labels must not cover the OHLC/symbol legend row
      for (const label of snap.overlayLabels) {
        assert.equal(overlapsRect(label.rect, snap.ohlc), false,
          `${vp.name}: "${label.role}" must not overlap the OHLC legend row; ` +
          `label=${JSON.stringify(label.rect)} ohlc=${JSON.stringify(snap.ohlc)}`)
      }

      // overlay labels must not cover the price scale
      if (snap.priceScale) {
        for (const label of snap.overlayLabels) {
          assert.equal(overlapsRect(label.rect, snap.priceScale), false,
            `${vp.name}: "${label.role}" must not overlap the price scale; ` +
            `label=${JSON.stringify(label.rect)} priceScale=${JSON.stringify(snap.priceScale)}`)
        }
      }

      // overlay labels must not cover the time scale
      if (snap.timeScale) {
        for (const label of snap.overlayLabels) {
          assert.equal(overlapsRect(label.rect, snap.timeScale), false,
            `${vp.name}: "${label.role}" must not overlap the time scale; ` +
            `label=${JSON.stringify(label.rect)} timeScale=${JSON.stringify(snap.timeScale)}`)
        }
      }
    }
  } finally {
    await stopBrowserHarness(harness)
  }
})

test('paper-order quote box and OHLC row remain non-overlapping in quote state transitions at 1366×768', { timeout: 120_000 }, async () => {
  const harness = await startBrowserHarness()
  const { client } = harness
  const paint = (n = 4) => client.evaluate(`new Promise(r => { let f=${n}; const tick = () => { if (--f<=0) r(); else requestAnimationFrame(tick) }; requestAnimationFrame(tick) })`)

  try {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1366, height: 768, screenWidth: 1366, screenHeight: 768,
      deviceScaleFactor: 1, mobile: false,
    })

    for (const status of ['current', 'stale', 'unavailable']) {
      await client.evaluate(`window.__terminalGeometryFixture.setQuoteState('${status}')`)
      await paint()
      const snap = await client.evaluate(HUD_SNAPSHOT_EXPRESSION)

      assert.equal(snap.documentScrollWidth, snap.documentClientWidth,
        `1366×768 ${status} quote: must not cause horizontal page overflow`)

      assert.ok(snap.ohlc && snap.ohlc.width > 0,
        `1366×768 ${status} quote: OHLC legend must remain visible`)

      if (snap.quote) {
        assert.equal(overlapsRect(snap.quote, snap.ohlc), false,
          `1366×768 ${status} quote: quote box overlaps OHLC legend; ` +
          `quote=${JSON.stringify(snap.quote)} ohlc=${JSON.stringify(snap.ohlc)}`)
      }
    }

    // maximum-label state: long symbol + all indicators active + max overlays
    await client.evaluate("window.__terminalGeometryFixture.applyScenario('maximum-label-state')")
    await paint(6)
    const snap = await client.evaluate(HUD_SNAPSHOT_EXPRESSION)

    assert.equal(snap.documentScrollWidth, snap.documentClientWidth,
      '1366×768 maximum-label: must not cause horizontal page overflow')

    if (snap.ohlc) {
      // OHLC must not extend past the viewport right edge
      assert.ok(snap.ohlc.right <= snap.documentClientWidth + 0.5,
        `1366×768 maximum-label: OHLC legend must not escape the viewport right edge; ` +
        `ohlc.right=${snap.ohlc.right} viewport=${snap.documentClientWidth}`)
    }

    // chart canvas allocation must still meet 70%×60% minimums at 1366×768
    assert.ok(snap.chart.width >= 1366 * 0.70,
      `1366×768 maximum-label: chart width ${snap.chart.width}px is below 70vw`)
    assert.ok(snap.chart.height >= 768 * 0.60,
      `1366×768 maximum-label: chart height ${snap.chart.height}px is below 60vh`)

  } finally {
    await stopBrowserHarness(harness)
  }
})
