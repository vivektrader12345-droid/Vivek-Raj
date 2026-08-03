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

function runtimeErrors(events) {
  return events
    .filter(event => event.method === 'Runtime.exceptionThrown')
    .map(event => event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'Unknown runtime exception')
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

async function waitForSelector(client, selector, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await client.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${selector}`)
}

async function waitForHeader(client, timeout = 20_000) {
  await waitForSelector(client, '[data-terminal-header]', timeout)
}

async function navigateFixture(client, origin, width, stress = false) {
  client.events.length = 0
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await client.send('Page.navigate', {
    url: `${origin}/tests/terminal/terminalHeader.fixture.html${stress ? '?stress=1' : ''}`,
  })
  await waitForHeader(client)
  await delay(100)
  assert.deepEqual(runtimeErrors(client.events), [], `runtime errors at ${width}px: ${runtimeErrors(client.events).join('\n')}`)
}

async function readHeaderGeometry(client) {
  return client.evaluate(`(() => {
    const rectObject = element => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const visible = element => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const header = document.querySelector('[data-terminal-header]')
    const primary = document.querySelector('[data-header-row="primary"]')
    const secondary = document.querySelector('[data-header-row="secondary"]')
    const required = ['home', 'market', 'live-status', 'account', 'save', 'layout', 'fullscreen', 'paper-trade', 'priority-timeframes', 'style', 'indicators', 'more']
      .map(name => ({ name, element: document.querySelector('[data-control="' + name + '"]') }))
    const headerRect = header.getBoundingClientRect()
    return {
      header: rectObject(header),
      primary: rectObject(primary),
      secondary: rectObject(secondary),
      primaryScrollWidth: primary.scrollWidth,
      primaryClientWidth: primary.clientWidth,
      secondaryScrollWidth: secondary.scrollWidth,
      secondaryClientWidth: secondary.clientWidth,
      disabledRowControls: header.querySelectorAll('[data-header-row] > button:disabled, [data-header-row] > * > button:disabled').length,
      required: required.map(({ name, element }) => ({
        name,
        visible: Boolean(element && visible(element)),
        contained: Boolean(element && (() => {
          const rect = element.getBoundingClientRect()
          return rect.left >= headerRect.left && rect.right <= headerRect.right && rect.top >= headerRect.top && rect.bottom <= headerRect.bottom
        })()),
      })),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      marketText: document.querySelector('[data-control="market"]')?.innerText,
      marketLabel: document.querySelector('[data-control="market"]')?.getAttribute('aria-label'),
      accountText: document.querySelector('[data-control="account"]')?.innerText,
      accountLabel: document.querySelector('[data-control="account"]')?.getAttribute('aria-label'),
      visibleControlClipping: [...header.querySelectorAll('button, [role="status"]')]
        .filter(visible)
        .filter(element => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight)
        .map(element => element.getAttribute('data-control') || element.getAttribute('aria-label') || element.innerText),
    }
  })()`)
}

test('compact terminal header component geometry and overflow priority', { timeout: 120_000 }, async t => {
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

  const browserPath = await findBrowser()
  assert.ok(browserPath, 'Microsoft Edge was not found. Set EDGE_PATH to a Chromium-compatible browser executable.')
  const profileDirectory = path.join(os.tmpdir(), `vmt-terminal-header-${process.pid}-${Date.now()}`)
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
    await client.send('Runtime.enable')

    await t.test('desktop breakpoints use exact rows and keep every priority control contained', async () => {
      for (const width of [1024, 1366, 1920]) {
        await navigateFixture(client, origin, width)
        const geometry = await readHeaderGeometry(client)
        const expectedSecondaryHeight = width === 1024 ? 36 : 40
        assert.equal(geometry.primary.height, 44, `primary row height changed at ${width}px`)
        assert.equal(geometry.secondary.height, expectedSecondaryHeight, `secondary row height changed at ${width}px`)
        assert.equal(geometry.header.height, 44 + expectedSecondaryHeight, `header track height changed at ${width}px`)
        assert.ok(geometry.header.height <= 88, `desktop header exceeds 88px at ${width}px`)
        assert.equal(geometry.primaryScrollWidth, geometry.primaryClientWidth, `primary row overflows at ${width}px`)
        assert.equal(geometry.secondaryScrollWidth, geometry.secondaryClientWidth, `secondary row overflows at ${width}px`)
        assert.equal(geometry.documentWidth, geometry.viewportWidth, `document overflows at ${width}px`)
        assert.deepEqual(geometry.required.filter(control => !control.visible || !control.contained), [], `priority controls are not reachable at ${width}px`)
        assert.deepEqual(geometry.visibleControlClipping, [], `visible header controls clip at ${width}px`)
      }
    })

    await t.test('long labels use deterministic compact text instead of clipping', async () => {
      for (const width of [1024, 1920]) {
        await navigateFixture(client, origin, width, true)
        const geometry = await readHeaderGeometry(client)
        assert.match(geometry.marketLabel, /INTERNATIONAL GOLD SETTLEMENT MARKET/, 'full market name must remain programmatically available')
        assert.match(geometry.accountLabel, /123,456,789,012,345\.67/, 'full account summary must remain programmatically available')
        assert.match(geometry.marketText, /GOLD/, 'long market label must use its compact deterministic label')
        assert.match(geometry.accountText, /\$123\.5T/, 'long account label must use compact number notation')
        assert.deepEqual(geometry.visibleControlClipping, [], `long labels clip at ${width}px`)
        assert.ok(geometry.header.height <= 88, `long labels increase header height at ${width}px`)
      }
    })

    await t.test('unsupported controls are disabled inside More and never consume row space', async () => {
      await navigateFixture(client, origin, 1024)
      await client.evaluate(`document.querySelector('[data-control="more"]').click()`)
      await waitForSelector(client, '#terminal-more-menu')
      const menuState = await client.evaluate(`(() => {
        const menu = document.getElementById('terminal-more-menu')
        const unsupported = [...menu.querySelectorAll('[data-support="unsupported"]')]
        const supported = [...menu.querySelectorAll('[data-support="supported"]')]
        const unsupportedInRows = [...document.querySelectorAll('[data-header-row] [data-support="unsupported"]')]
          .filter(control => !control.closest('.terminal-menu'))
        const disabledInRows = [...document.querySelectorAll('[data-header-row] button:disabled')]
          .filter(control => !control.closest('.terminal-menu'))
        const rect = menu.getBoundingClientRect()
        const style = getComputedStyle(menu)
        return {
          unsupportedCount: unsupported.length,
          unsupportedEnabled: unsupported.filter(control => !control.disabled).length,
          supportedCount: supported.length,
          rowUnsupportedCount: unsupportedInRows.length,
          rowDisabledCount: disabledInRows.length,
          right: rect.right,
          viewportWidth: document.documentElement.clientWidth,
          background: style.backgroundColor,
          borderStyle: style.borderStyle,
        }
      })()`)
      assert.ok(menuState.unsupportedCount >= 8, 'expected unavailable timeframes and tools in More')
      assert.equal(menuState.unsupportedEnabled, 0, 'unsupported controls must remain disabled')
      assert.ok(menuState.supportedCount >= 10, 'supported secondary controls must remain reachable in More')
      assert.equal(menuState.rowUnsupportedCount, 0, 'unsupported controls must not consume primary row space')
      assert.equal(menuState.rowDisabledCount, 0, 'disabled controls must not crowd either header row')
      assert.ok(menuState.right <= menuState.viewportWidth, 'More menu escapes the desktop viewport')
      assert.notEqual(menuState.background, 'rgba(0, 0, 0, 0)', 'More menu must use a styled application surface')
      assert.notEqual(menuState.borderStyle, 'none', 'More menu must have a styled boundary')
    })
  } finally {
    client?.close()
    vite.kill()
    browser.kill()
    await delay(400)
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {})
  }
})
