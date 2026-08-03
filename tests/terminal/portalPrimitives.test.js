import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { computePortalPosition, PORTAL_VIEWPORT_PADDING } from '../../src/trading/utils/portalPositioning.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const fixturePath = '/tests/terminal/portalPrimitives.fixture.html'
const viteConfig = path.join(repositoryRoot, 'tests', 'geometry', 'vite.config.js')
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

async function startHarness() {
  const vitePort = await freePort()
  const debuggingPort = await freePort()
  const output = []
  const vite = spawn(process.execPath, [
    path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', viteConfig,
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
  let browserPath
  for (const candidate of candidates) {
    try {
      await access(candidate)
      browserPath = candidate
      break
    } catch {}
  }
  assert.ok(browserPath, 'Microsoft Edge was not found. Set EDGE_PATH to a Chromium-compatible browser executable.')

  const profileDirectory = path.join(os.tmpdir(), `pro-terminal-portal-${process.pid}-${Date.now()}`)
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
    await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')])
    await client.send('Page.navigate', { url: `${origin}${fixturePath}` })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await client.evaluate('Boolean(window.__portalFixture?.ready && document.getElementById("pro-terminal-portal-root"))').catch(() => false)) {
        return { browser, client, profileDirectory, vite, output }
      }
      await delay(100)
    }
    throw new Error(`Timed out waiting for portal fixture.\n${output.join('')}`)
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
  await delay(350)
  await rm(harness.profileDirectory, { recursive: true, force: true }).catch(() => {})
}

const anchorAt = (x, y, width = 24, height = 24) => ({ left: x, top: y, right: x + width, bottom: y + height, width, height })

// Property-style generated coverage for Requirements 8.5, 11.2, 11.10, and 11.11.
test('portal geometry flips and clamps generated edge/size combinations to an 8px viewport inset', () => {
  const viewports = [
    { width: 320, height: 480 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
  ]
  const sides = ['top', 'right', 'bottom', 'left']
  const sizes = [{ width: 120, height: 80 }, { width: 280, height: 320 }, { width: 4000, height: 3000 }]
  let generatedCases = 0

  for (const viewport of viewports) {
    const anchors = [
      anchorAt(0, 0),
      anchorAt(viewport.width - 24, 0),
      anchorAt(0, viewport.height - 24),
      anchorAt(viewport.width - 24, viewport.height - 24),
      anchorAt(viewport.width / 2 - 12, viewport.height / 2 - 12),
    ]
    for (const anchorRect of anchors) {
      for (const preferredSide of sides) {
        for (const surfaceSize of sizes) {
          generatedCases += 1
          const result = computePortalPosition({ anchorRect, surfaceSize, viewport, preferredSide })
          const effectiveWidth = Math.min(surfaceSize.width, result.maxWidth)
          const effectiveHeight = Math.min(surfaceSize.height, result.maxHeight)
          assert.ok(result.left >= PORTAL_VIEWPORT_PADDING, `case ${generatedCases}: left edge escaped`)
          assert.ok(result.top >= PORTAL_VIEWPORT_PADDING, `case ${generatedCases}: top edge escaped`)
          assert.ok(result.left + effectiveWidth <= viewport.width - PORTAL_VIEWPORT_PADDING + 0.001, `case ${generatedCases}: right edge escaped`)
          assert.ok(result.top + effectiveHeight <= viewport.height - PORTAL_VIEWPORT_PADDING + 0.001, `case ${generatedCases}: bottom edge escaped`)
          assert.ok(sides.includes(result.side), `case ${generatedCases}: invalid resolved side`)
        }
      }
    }
  }

  assert.equal(generatedCases, 360)
  const lowerEdge = computePortalPosition({
    anchorRect: anchorAt(100, 740),
    surfaceSize: { width: 180, height: 200 },
    viewport: { width: 1024, height: 768 },
    preferredSide: 'bottom',
  })
  assert.equal(lowerEdge.side, 'top', 'the preferred bottom side must flip when the opposite side has more room')
})

test('portal primitives are viewport-safe and preserve contextual focus/action semantics', { timeout: 120_000 }, async () => {
  const harness = await startHarness()
  const { client } = harness
  const paint = () => client.evaluate('window.__portalFixture.waitForPaint(5)')
  const snapshot = () => client.evaluate('window.__portalFixture.snapshot()')
  const press = key => client.evaluate(`(document.activeElement || document).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`)

  try {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 800, height: 600, screenWidth: 800, screenHeight: 600, deviceScaleFactor: 1, mobile: false,
    })

    const edgeCases = [
      { x: 0, y: 0, side: 'top' },
      { x: 772, y: 0, side: 'right' },
      { x: 0, y: 572, side: 'left' },
      { x: 772, y: 572, side: 'bottom' },
    ]
    for (const edge of edgeCases) {
      await client.evaluate(`window.__portalFixture.openPopover(${JSON.stringify(edge)})`)
      await paint()
      const state = await snapshot()
      assert.equal(state.portalRootCount, 1, 'exactly one portal root must exist')
      assert.equal(state.portalParentIsBody, true, 'the portal root must be mounted directly under body')
      assert.equal(state.portalTheme, 'dark', 'the terminal theme must propagate to the portal root')
      assert.equal(state.popoverPosition, 'fixed', 'portal surfaces must use viewport-fixed positioning')
      assert.equal(state.popoverParentId, 'pro-terminal-portal-root', 'overflow-hidden ancestors must not contain portal surfaces')
      assert.ok(state.popoverRect.left >= 7.5 && state.popoverRect.top >= 7.5, `popover escaped at ${JSON.stringify(edge)}`)
      assert.ok(state.popoverRect.right <= 792.5 && state.popoverRect.bottom <= 592.5, `popover escaped at ${JSON.stringify(edge)}`)
      await press('Escape')
      await paint()
    }

    await client.evaluate('window.__portalFixture.openPopover({ x: 780, y: 580, contentWidth: 1600, contentHeight: 1200, zoomed: true, side: "bottom" })')
    await paint()
    let state = await snapshot()
    assert.ok(state.popoverRect.width <= 784.5 && state.popoverRect.height <= 584.5, 'oversized/zoomed content must be constrained to the viewport inset')
    assert.ok(state.popoverRect.left >= 7.5 && state.popoverRect.top >= 7.5, 'oversized content must clamp on both axes')

    await press('Escape')
    await paint()
    await client.evaluate('window.__portalFixture.openPopover({ x: 780, y: 580, side: "bottom" })')
    await paint()
    state = await snapshot()
    const previousLeft = state.popoverRect.left
    await client.evaluate('window.__portalFixture.moveAnchor({ x: 80, y: 80 })')
    await paint()
    state = await snapshot()
    assert.notEqual(Math.round(state.popoverRect.left), Math.round(previousLeft), 'scroll-driven repositioning must follow a moved anchor')
    await press('Escape')
    await paint()
    state = await snapshot()
    assert.equal(state.popoverOpen, false)
    assert.equal(state.focusedId, 'popover-trigger', 'Escape dismissal must restore focus to the popover trigger')

    await client.evaluate('window.__portalFixture.openPopover({ x: 120, y: 90 })')
    await paint()
    await client.evaluate('document.getElementById("nested-modal-trigger").focus(); document.getElementById("nested-modal-trigger").click()')
    await paint()
    state = await snapshot()
    assert.equal(state.dialogOpen, true)
    assert.equal(state.popoverOpen, true)
    await press('Escape')
    await paint()
    state = await snapshot()
    assert.equal(state.dialogOpen, false, 'Escape must dismiss the topmost modal')
    assert.equal(state.popoverOpen, true, 'Escape must not dismiss the parent popover at the same time')
    assert.equal(state.focusedId, 'nested-modal-trigger', 'nested modal dismissal must restore its own trigger')
    await press('Escape')
    await paint()

    await client.evaluate('window.__portalFixture.openContext({ x: 790, y: 590 })')
    await paint()
    state = await snapshot()
    assert.equal(state.focusedText, 'First action', 'menus must focus their first roving-focus item')
    await press('ArrowDown')
    state = await snapshot()
    assert.equal(state.focusedText, 'Second action', 'ArrowDown must move menu focus')
    await press('Escape')
    await paint()
    state = await snapshot()
    assert.equal(state.focusedId, 'context-trigger', 'context menu dismissal must restore its trigger')

    await client.evaluate('window.__portalFixture.openModal()')
    await paint()
    await client.evaluate('document.getElementById("modal-last").focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))')
    state = await snapshot()
    assert.equal(state.dialogContainsFocus, true, 'Tab from the last dialog control must remain trapped in the modal')
    await press('Escape')
    await paint()
    state = await snapshot()
    assert.equal(state.focusedId, 'modal-trigger', 'modal Escape dismissal must restore focus')

    await client.evaluate('window.__portalFixture.openPopover({ x: 500, y: 200 })')
    await paint()
    await client.evaluate(`(() => {
      const target = document.getElementById('underlying-action')
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse' }))
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse' }))
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })()`)
    await paint()
    state = await snapshot()
    assert.equal(state.popoverOpen, false, 'pointer-down outside must dismiss the active surface')
    assert.equal(state.actionCount, 0, 'the dismissal gesture must not replay a click into the underlying action')
    await client.evaluate('document.getElementById("underlying-action").click()')
    await paint()
    state = await snapshot()
    assert.equal(state.actionCount, 1, 'a later deliberate action must not remain blocked')

    await client.evaluate(`(() => {
      const input = document.querySelector('[role="combobox"]')
      input.focus()
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setValue.call(input, 'eth')
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
    })()`)
    await paint()
    await client.evaluate(`(() => {
      const input = document.querySelector('[role="combobox"]')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })()`)
    await paint()
    state = await snapshot()
    assert.equal(state.selectedSymbol, 'ETHUSDT', 'the symbol combobox must select a filtered listbox option by keyboard')
    assert.equal(state.comboboxExpanded, 'false', 'selection must close the styled listbox')
    assert.equal(state.portalRootCount, 1, 'all primitives must continue sharing one portal root')
  } finally {
    await stopHarness(harness)
  }
})
