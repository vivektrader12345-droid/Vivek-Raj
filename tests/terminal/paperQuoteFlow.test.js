import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  createPaperQuote,
  openPaperOrderDraft,
  QUOTE_STALE_AFTER_MS,
  QuoteStatus,
  SINGLE_CHART_TILE_ID,
} from '../../src/trading/paperOrderDraft.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const geometryViteConfig = path.join(repositoryRoot, 'tests', 'geometry', 'vite.config.js')
const fixturePath = '/tests/geometry/terminalGeometry.fixture.html'
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function expectedQuote(price) {
  const spread = Math.max(price * 0.0001, 0.01)
  return { bid: price - spread / 2, ask: price + spread / 2, spread }
}

test('paper quote model distinguishes current, stale, and unavailable data', () => {
  const now = 1_000_000
  const price = 65_000
  const expected = expectedQuote(price)

  const current = createPaperQuote({ price, connected: true, lastTickTime: now - 250, now })
  assert.deepEqual(current, { status: QuoteStatus.CURRENT, ...expected })
  assert.equal(Object.isFrozen(current), true)

  const boundaryStale = createPaperQuote({
    price,
    connected: true,
    lastTickTime: now - QUOTE_STALE_AFTER_MS,
    now,
  })
  assert.deepEqual(boundaryStale, { status: QuoteStatus.STALE, ...expected })
  assert.equal(createPaperQuote({ price, connected: false, lastTickTime: now, now }).status, QuoteStatus.STALE)
  assert.deepEqual(createPaperQuote({ price: 0, connected: false, lastTickTime: 0, now }), {
    status: QuoteStatus.UNAVAILABLE,
    bid: null,
    ask: null,
    spread: null,
  })
})

test('openPaperOrderDraft validates active tile, market, side, and optional price before opening review', () => {
  const opened = []
  const valid = openPaperOrderDraft({
    tileId: SINGLE_CHART_TILE_ID,
    activeTileId: SINGLE_CHART_TILE_ID,
    symbol: 'BTCUSDT',
    activeSymbol: 'BTC/USDT',
    symbolDisplay: 'BTC/USDT',
    side: 'sell',
    price: 64_996.75,
    quoteStatus: QuoteStatus.CURRENT,
  }, draft => opened.push(draft))

  assert.equal(valid.success, true)
  assert.equal(opened.length, 1)
  assert.deepEqual(opened[0], {
    tileId: SINGLE_CHART_TILE_ID,
    symbol: 'BTCUSDT',
    symbolDisplay: 'BTC/USDT',
    side: 'sell',
    price: 64_996.75,
    quoteStatus: QuoteStatus.CURRENT,
  })
  assert.equal(Object.isFrozen(opened[0]), true)

  for (const request of [
    { tileId: 'inactive', activeTileId: SINGLE_CHART_TILE_ID, symbol: 'BTCUSDT', activeSymbol: 'BTCUSDT', side: 'buy' },
    { tileId: SINGLE_CHART_TILE_ID, activeTileId: SINGLE_CHART_TILE_ID, symbol: 'ETHUSDT', activeSymbol: 'BTCUSDT', side: 'buy' },
    { tileId: SINGLE_CHART_TILE_ID, activeTileId: SINGLE_CHART_TILE_ID, symbol: 'BTCUSDT', activeSymbol: 'BTCUSDT', side: 'hold' },
    { tileId: SINGLE_CHART_TILE_ID, activeTileId: SINGLE_CHART_TILE_ID, symbol: 'BTCUSDT', activeSymbol: 'BTCUSDT', side: 'buy', price: Number.NaN },
  ]) {
    assert.equal(openPaperOrderDraft(request, draft => opened.push(draft)).success, false)
  }
  assert.equal(opened.length, 1, 'invalid requests must not open review state')
})

test('quote and shortcut entry points cannot import or call placeOrder directly', async () => {
  const files = await Promise.all([
    readFile(path.join(repositoryRoot, 'src', 'trading', 'ProTrading.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'trading', 'components', 'PaperQuoteBox.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'trading', 'paperOrderDraft.js'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'trading', 'utils', 'binanceWS.js'), 'utf8'),
  ])
  const [terminal, quoteBox, draftCommand, binance] = files
  assert.doesNotMatch(`${terminal}\n${quoteBox}\n${draftCommand}`, /\.placeOrder\s*\(|getState\(\)\.placeOrder/)
  assert.match(terminal, /openOrder\('buy'\)/)
  assert.match(terminal, /openOrder\('sell'\)/)
  assert.match(terminal, /onOpenPaperOrderDraft=\{openPaperOrderDraft\}/)
  assert.doesNotMatch(binance, /\/api\/v3\/order|\/sapi\/|X-MBX-APIKEY|signature=/i)
})

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
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (!message.id) return
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

  close() { this.socket.close() }
}

async function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }
  return null
}

async function startHarness() {
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

  const browserPath = await findBrowser()
  assert.ok(browserPath, 'Microsoft Edge was not found. Set EDGE_PATH to a Chromium-compatible browser executable.')
  const profileDirectory = path.join(os.tmpdir(), `paper-quote-${process.pid}-${Date.now()}`)
  await mkdir(profileDirectory, { recursive: true })
  const browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  try {
    const origin = `http://127.0.0.1:${vitePort}`
    await waitForHttp(`${origin}${fixturePath}`, vite, output)
    await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, browser, [])
    const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, 'No debuggable browser page was available')
    const client = await CdpClient.connect(page.webSocketDebuggerUrl)
    await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Input.setIgnoreInputEvents', { ignore: false })])
    await client.send('Page.navigate', { url: `${origin}${fixturePath}` })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await client.evaluate('Boolean(window.__terminalGeometryFixture?.ready)').catch(() => false)) {
        return { browser, client, profileDirectory, vite }
      }
      await delay(100)
    }
    throw new Error(`Timed out waiting for paper quote fixture.\n${output.join('')}`)
  } catch (error) {
    vite.kill()
    browser.kill()
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function stopHarness(harness) {
  harness.client?.close()
  harness.vite?.kill()
  harness.browser?.kill()
  await delay(400)
  await rm(harness.profileDirectory, { recursive: true, force: true }).catch(() => {})
}

const snapshotExpression = `(() => {
  const rect = element => {
    if (!element) return null
    const value = element.getBoundingClientRect()
    return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height }
  }
  const intersects = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  const quote = document.querySelector('[data-paper-quote]')
  const legend = document.querySelector('[data-chart-hud="symbol-ohlc"]')
  const chart = document.querySelector('[data-terminal-area="chartRegion"]')
  const chartRect = rect(chart)
  const canvases = [...document.querySelectorAll('[data-terminal-area="chartRegion"] canvas')]
    .map(canvas => ({ canvas, value: rect(canvas) }))
    .filter(item => item.value.width > 0 && item.value.height > 0)
  const priceScale = canvases.find(item => item.value.width < chartRect.width * .25 && item.value.height > chartRect.height * .45 && item.value.right >= chartRect.right - 2)?.value || null
  const buttons = [...document.querySelectorAll('[data-paper-quote-action]')]
  const draft = document.querySelector('[data-paper-order-draft]')
  return {
    quoteStatus: quote?.dataset.quoteStatus || null,
    quoteText: quote?.innerText || '',
    quoteRect: rect(quote),
    legendRect: rect(legend),
    priceScaleRect: priceScale,
    overlapsLegend: intersects(rect(quote), rect(legend)),
    overlapsPriceScale: intersects(rect(quote), priceScale),
    buttons: buttons.map(button => ({
      side: button.dataset.paperQuoteAction,
      label: button.getAttribute('aria-label'),
      rect: rect(button),
    })),
    dialogTitle: document.querySelector('.pro-terminal-modal-sheet__header h2')?.textContent || null,
    draftSide: draft?.dataset.draftSide || null,
    draftPrice: draft?.dataset.draftPrice || null,
    draftQuoteStatus: draft?.dataset.draftQuoteStatus || null,
    orderPrice: document.querySelector('[data-paper-order-price]')?.value || null,
    submitDisabled: document.querySelector('[data-paper-order-submit]')?.disabled ?? null,
    placeOrderCalls: window.__terminalGeometryFixture.placeOrderCalls(),
    marketRequests: window.__terminalGeometryFixture.marketRequests(),
  }
})()`

async function paint(client) {
  await client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

async function waitForPageState(client, expression, description, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await client.evaluate(`Boolean(${expression})`).catch(() => false)) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function closeDialogAndWait(client) {
  const closeRequested = await client.evaluate(`(() => {
    const closeButton = document.querySelector('button[aria-label="Close dialog"]')
    if (!closeButton) return false
    closeButton.click()
    return true
  })()`)
  assert.equal(closeRequested, true, 'paper-order dialog must expose its close action')
  await waitForPageState(client, "!document.querySelector('[role=\"dialog\"]')", 'paper-order dialog removal')
  await client.evaluate('new Promise(resolve => setTimeout(resolve, 0))')
  await paint(client)
}

async function pressKey(client, key, code) {
  const virtualKeyCode = code === 'Enter' ? 13 : key.toUpperCase().charCodeAt(0)
  await client.evaluate(`(() => {
    const target = document.activeElement
    window.__lastCdpKeyEvents = []
    for (const type of ['keydown', 'keyup', 'click']) {
      target.addEventListener(type, event => window.__lastCdpKeyEvents.push({
        type,
        isTrusted: event.isTrusted,
        key: event.key || null,
        code: event.code || null,
        keyCode: event.keyCode || 0,
        detail: event.detail || 0,
      }), { once: true })
    }
  })()`)
  const keyEvent = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }
  const text = key === 'Enter' ? '\r' : key
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyEvent, text, unmodifiedText: text })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent })
  await paint(client)

  const events = await client.evaluate('window.__lastCdpKeyEvents')
  const keyDown = events.find(event => event.type === 'keydown')
  const click = events.find(event => event.type === 'click')
  assert.equal(keyDown?.isTrusted, true, 'CDP must deliver a trusted keyboard event')
  assert.equal(keyDown?.keyCode, virtualKeyCode, 'CDP keyboard event must carry the native virtual key code')
  assert.equal(click?.isTrusted, true, 'the focused native button must produce a trusted activation click')
  assert.equal(click?.detail, 0, 'native button activation must be keyboard-originated')
}

async function pressControlShortcut(client, key, code) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key, code })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key, code })
  await paint(client)
}

test('quote component and terminal integration stay draft-only across mouse, keyboard, and touch', { timeout: 120_000 }, async () => {
  const harness = await startHarness()
  const { client } = harness
  try {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1366, height: 768, screenWidth: 1366, screenHeight: 768, deviceScaleFactor: 1, mobile: false,
    })
    await client.evaluate("window.__terminalGeometryFixture.setQuoteState('current')")
    const baselineRequests = (await client.evaluate(snapshotExpression)).marketRequests

    let state = await client.evaluate(snapshotExpression)
    assert.equal(state.quoteStatus, 'current')
    assert.match(state.quoteText, /Paper SELL/)
    assert.match(state.quoteText, /Paper BUY/)
    assert.match(state.quoteText, /BID/)
    assert.match(state.quoteText, /ASK/)
    assert.match(state.quoteText, /SPREAD/)
    assert.match(state.quoteText, /current/i)
    assert.equal(state.overlapsLegend, false, 'quote must not cover symbol/OHLC information')
    assert.equal(state.overlapsPriceScale, false, 'quote must not cover current-price scale information')
    assert.deepEqual(state.buttons.map(button => button.side), ['sell', 'buy'])
    assert.ok(state.buttons.every(button => button.rect.height >= 44), 'quote actions must remain touch sized')

    await client.evaluate("document.querySelector('[data-paper-quote-action=\"sell\"]').click()")
    await paint(client)
    await client.evaluate(`(() => {
      const limit = [...document.querySelectorAll('[data-paper-order-draft] button')]
        .find(button => button.textContent.trim() === 'Limit')
      limit?.click()
    })()`)
    await paint(client)
    state = await client.evaluate(snapshotExpression)
    assert.equal(state.dialogTitle, 'Paper trading')
    assert.equal(state.draftSide, 'sell')
    assert.equal(state.draftPrice, '64996.75')
    assert.equal(state.draftQuoteStatus, 'current')
    assert.equal(state.orderPrice, '64996.75')
    assert.equal(state.placeOrderCalls.length, 0, 'quote click must not place an order')
    assert.equal(state.marketRequests.length, baselineRequests.length, 'opening review must not send a Binance request')

    await closeDialogAndWait(client)
    const buyFocused = await client.evaluate(`(() => {
      const buy = document.querySelector('[data-paper-quote-action="buy"]')
      buy?.focus()
      return document.activeElement === buy
    })()`)
    assert.equal(buyFocused, true, 'Paper BUY must own focus before keyboard activation')
    await pressKey(client, 'Enter', 'Enter')
    await waitForPageState(
      client,
      "document.querySelector('[data-paper-order-draft]')?.dataset.draftSide === 'buy'",
      'Paper BUY draft render after Enter',
    )
    state = await client.evaluate(snapshotExpression)
    assert.equal(state.draftSide, 'buy')
    assert.equal(state.placeOrderCalls.length, 0, 'keyboard activation of a quote button must only open review')

    await client.evaluate("document.querySelector('button[aria-label=\"Close dialog\"]').click()")
    await pressControlShortcut(client, 's', 'KeyS')
    state = await client.evaluate(snapshotExpression)
    assert.equal(state.draftSide, 'sell')
    assert.equal(state.placeOrderCalls.length, 0, 'Ctrl+S must only open a paper draft')

    await client.evaluate("document.querySelector('button[aria-label=\"Close dialog\"]').click()")
    await pressControlShortcut(client, 'b', 'KeyB')
    state = await client.evaluate(snapshotExpression)
    assert.equal(state.draftSide, 'buy')
    assert.equal(state.draftPrice, '65003.25')
    assert.equal(state.placeOrderCalls.length, 0, 'Ctrl+B must only open a paper draft')

    await client.evaluate(`(() => {
      window.__paperConfirmCount = 0
      window.confirm = () => { window.__paperConfirmCount += 1; return true }
      document.querySelector('[data-paper-order-submit]').click()
    })()`)
    await paint(client)
    state = await client.evaluate(snapshotExpression)
    assert.equal(await client.evaluate('window.__paperConfirmCount'), 1, 'explicit submit must retain confirmation')
    assert.equal(state.placeOrderCalls.length, 1, 'only explicit confirmed submit may call placeOrder')
    assert.equal(state.placeOrderCalls[0].side, 'buy')

    await client.evaluate("window.__terminalGeometryFixture.setQuoteState('stale')")
    state = await client.evaluate(snapshotExpression)
    assert.equal(state.quoteStatus, 'stale')
    assert.match(state.quoteText, /stale/i)
    assert.match(state.quoteText, /64,996\.75/)
    await client.evaluate("document.querySelector('[data-paper-quote-action=\"sell\"]').click()")
    await paint(client)
    state = await client.evaluate(snapshotExpression)
    assert.equal(state.draftSide, 'sell')
    assert.equal(state.draftPrice, null, 'stale data must not prefill a current draft price')
    assert.equal(state.draftQuoteStatus, 'stale')
    assert.equal(state.placeOrderCalls.length, 0)

    await client.evaluate("window.__terminalGeometryFixture.setQuoteState('unavailable')")
    state = await client.evaluate(snapshotExpression)
    assert.equal(state.quoteStatus, 'unavailable')
    assert.match(state.quoteText, /unavailable/i)
    await client.evaluate("document.querySelector('[data-paper-quote-action=\"buy\"]').click()")
    await paint(client)
    state = await client.evaluate(snapshotExpression)
    assert.equal(state.draftSide, 'buy')
    assert.equal(state.draftPrice, null)
    assert.equal(state.submitDisabled, true, 'an unavailable quote cannot be submitted')
    assert.equal(state.placeOrderCalls.length, 0)

    await client.evaluate("window.__terminalGeometryFixture.setQuoteState('current')")
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: true,
    })
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await client.evaluate(`(() => {
      const panelsToggle = [...document.querySelectorAll('.terminal-statusbar button')]
        .find(button => button.textContent.trim() === 'Panels')
      panelsToggle?.click()
    })()`)
    await paint(client)
    state = await client.evaluate(snapshotExpression)
    assert.equal(state.overlapsLegend, false, 'mobile quote must remain below the OHLC safe band')
    assert.equal(state.overlapsPriceScale, false, 'mobile quote must remain outside the price scale')
    const touchPoint = await client.evaluate(`(() => {
      const button = document.querySelector('[data-paper-quote-action="buy"]')
      const rect = button.getBoundingClientRect()
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      return { ...point, hitsBuyButton: button.contains(document.elementFromPoint(point.x, point.y)) }
    })()`)
    assert.equal(touchPoint.hitsBuyButton, true, 'Paper BUY must be the visible hit target before touch activation')
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchPoint.x, y: touchPoint.y, radiusX: 2, radiusY: 2, force: 1, id: 1 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await paint(client)
    state = await client.evaluate(snapshotExpression)
    assert.equal(state.draftSide, 'buy', 'touch activation must open the Paper BUY draft')
    assert.equal(state.placeOrderCalls.length, 0, 'touch activation must not place an order')

    assert.equal(state.marketRequests.length, baselineRequests.length, 'draft interactions must not create additional Binance traffic')
    for (const request of state.marketRequests) {
      assert.doesNotMatch(request.url, /\/api\/v3\/order|\/sapi\/|signature=|api[-_]?key/i)
      assert.ok(
        request.url.startsWith('https://api.binance.com/api/v3/klines') ||
          request.url.startsWith('wss://stream.binance.com:9443/ws/') && request.url.includes('@kline_'),
        `unexpected Binance request: ${request.url}`,
      )
    }
  } finally {
    await stopHarness(harness)
  }
})
