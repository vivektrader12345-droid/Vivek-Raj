import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = '/tests/pwaInstallPrompt.fixture.html'
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const APK_PATH = '/downloads/vivek-marco-trader.apk'

function expectedBehavior(result) {
  const [descriptorRequest, prefixRequest, tailRequest] = result.apkNetworkRequests
  return result.selectedPath === APK_PATH
    && result.apkSelectionCount === 1
    && result.pwaPromptInvocationCount === 0
    && result.instructionsOpened === false
    && result.apkNetworkRequests.length === 3
    && descriptorRequest?.path === `${APK_PATH}.json`
    && descriptorRequest?.range === null
    && prefixRequest?.path === APK_PATH
    && prefixRequest?.range === 'bytes=0-3'
    && tailRequest?.path === APK_PATH
    && /^bytes=\d+-\d+$/.test(tailRequest?.range || '')
}

async function getFreePort() {
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
    if (process.exitCode !== null) throw new Error(`Process exited early:\n${output.join('')}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${url}\n${output.join('')}`)
}

async function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { await access(candidate); return candidate } catch {}
  }
  throw new Error('No Chromium browser found. Set EDGE_PATH to Chrome or Edge.')
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

async function waitFor(client, expression, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(expression)) return
    } catch {}
    await delay(100)
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`)
}

const browserFixtureScript = String.raw`
(() => {
  let platform = 'Windows'
  let uaValue = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36'
  let uaMode = 'string'
  let uaDataMode = 'platform'
  let standalone = false
  const APK_PATH = '/downloads/vivek-marco-trader.apk'

  const applyRequestedNavigatorEvidence = (requested = {}) => {
    platform = Object.hasOwn(requested, 'platform') ? requested.platform : 'Windows'
    uaValue = Object.hasOwn(requested, 'ua')
      ? requested.ua
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36'
    uaMode = requested.uaMode || 'string'
    uaDataMode = requested.uaData || 'platform'
    standalone = requested.standalone === 'true'
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => uaMode === 'non-string' ? 17 : uaValue,
    })
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      get() {
        if (uaDataMode === 'absent') return undefined
        if (uaDataMode === 'missing-platform') return { mobile: false, brands: [] }
        if (uaDataMode === 'non-string-platform') return { platform: 17, mobile: false, brands: [] }
        if (uaDataMode === 'null-platform') return { platform: null, mobile: false, brands: [] }
        if (uaDataMode === 'primitive') return 17
        if (uaDataMode === 'throwing-hint') throw new Error('unsupported userAgentData')
        if (uaDataMode === 'throwing-platform') {
          return Object.defineProperty({ mobile: false, brands: [] }, 'platform', {
            get() { throw new Error('unsupported platform') },
          })
        }
        return {
          platform,
          mobile: typeof platform === 'string' && platform.trim().toLowerCase() === 'android',
          brands: [],
        }
      },
    })
  }

  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36',
  })
  Object.defineProperty(navigator, 'userAgentData', {
    configurable: true,
    get: () => ({ platform: 'Windows', mobile: false, brands: [] }),
  })
  window.__applyRequestedNavigatorEvidence = applyRequestedNavigatorEvidence

  const nativeMatchMedia = window.matchMedia.bind(window)
  window.matchMedia = media => media === '(display-mode: standalone)'
    ? { matches: standalone, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }
    : nativeMatchMedia(media)

  const resetAndroidRegression = () => {
    window.__androidRegression = {
      apkRequests: [],
      downloads: [],
      promptCalls: 0,
      promptChoiceReads: 0,
      beforeInstallDefaultPrevented: null,
      appInstalledEvents: 0,
      listeners: {
        beforeinstallprompt: { adds: 0, removes: 0 },
        appinstalled: { adds: 0, removes: 0 },
      },
      unhandled: [],
    }
  }
  window.__resetAndroidRegression = resetAndroidRegression
  resetAndroidRegression()
  addEventListener('unhandledrejection', event => {
    window.__androidRegression.unhandled.push(String(event.reason?.message || event.reason))
    event.preventDefault()
  })
  addEventListener('error', event => window.__androidRegression.unhandled.push(String(event.error?.message || event.message)))

  const nativeAddEventListener = window.addEventListener.bind(window)
  const nativeRemoveEventListener = window.removeEventListener.bind(window)
  nativeAddEventListener('beforeinstallprompt', event => {
    if (event.__pwaPreservationFixture) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)
  window.addEventListener = (type, listener, options) => {
    if (window.__androidRegression.listeners[type]) window.__androidRegression.listeners[type].adds += 1
    return nativeAddEventListener(type, listener, options)
  }
  window.removeEventListener = (type, listener, options) => {
    if (window.__androidRegression.listeners[type]) window.__androidRegression.listeners[type].removes += 1
    return nativeRemoveEventListener(type, listener, options)
  }

  const nativeAnchorClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    const target = new URL(this.href, location.href)
    if (target.origin === location.origin && target.pathname === APK_PATH) {
      window.__androidRegression.downloads.push(target.pathname)
      return
    }
    return nativeAnchorClick.call(this)
  }

  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const requested = new URL(typeof input === 'string' ? input : input.url, location.href)
    const range = new Headers(init?.headers).get('Range')
    if (requested.pathname === APK_PATH || requested.pathname === APK_PATH + '.json') {
      window.__androidRegression.apkRequests.push({
        path: requested.pathname,
        method: init?.method || 'GET',
        range,
      })
    }
    if (requested.pathname === APK_PATH && range) {
      const descriptorResponse = await nativeFetch(APK_PATH + '.json?fixture=range-contract', {
        cache: 'no-store',
        credentials: 'omit',
      })
      const descriptor = await descriptorResponse.json()
      const finalRange = 'bytes=' + (descriptor.byteSize - 1) + '-' + (descriptor.byteSize - 1)
      const bytes = range === 'bytes=0-3'
        ? new Uint8Array([0x50, 0x4b, 0x03, 0x04])
        : range === finalRange
          ? new Uint8Array([0])
          : null
      if (!bytes) return new Response(null, { status: 416 })
      const start = range === 'bytes=0-3' ? 0 : descriptor.byteSize - 1
      const end = range === 'bytes=0-3' ? 3 : descriptor.byteSize - 1
      const response = new Response(bytes, {
        status: 206,
        headers: {
          'Content-Type': descriptor.mediaType,
          'Content-Disposition': 'attachment; filename="vivek-marco-trader.apk"',
          'Content-Length': String(bytes.byteLength),
          'Content-Range': 'bytes ' + start + '-' + end + '/' + descriptor.byteSize,
          'Cache-Control': 'no-store',
        },
      })
      Object.defineProperty(response, 'url', { configurable: true, value: requested.href })
      return response
    }
    return nativeFetch(input, init)
  }
})()
`

async function withBrowser(run) {
  const previewPort = await getFreePort()
  const debuggingPort = await getFreePort()
  const output = []
  const preview = spawn(process.execPath, [
    path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  preview.stdout.on('data', chunk => output.push(chunk.toString()))
  preview.stderr.on('data', chunk => output.push(chunk.toString()))

  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'vmt-android-prompt-'))
  const browser = spawn(await findBrowser(), [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let client
  try {
    const origin = `http://127.0.0.1:${previewPort}`
    await waitForHttp(`${origin}${fixturePath}`, preview, output)
    await waitForHttp(`${origin}/tests/pwaInstallPrompt.fixture.jsx`, preview, output)
    await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, browser, [])
    const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, 'A debuggable Chromium page is required')
    client = await CdpClient.connect(page.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: browserFixtureScript })
    await run({ client, origin: `http://127.0.0.1:${previewPort}` })
  } finally {
    client?.close()
    preview.kill()
    browser.kill()
    await delay(300)
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function navigate(client, origin, parameters = {}) {
  const fixtureUrl = `${origin}${fixturePath}`
  const fixtureLoaded = await client.evaluate(`typeof window.__resetPwaInstallPromptFixture === 'function'`)
  if (!fixtureLoaded) {
    const navigation = await client.send('Page.navigate', { url: fixtureUrl })
    assert.equal(navigation.errorText, undefined, `Browser navigation failed for ${fixtureUrl}`)
    await waitFor(client, `location.href === ${JSON.stringify(fixtureUrl)}`)
    await waitFor(client, "window.__pwaInstallPromptFixtureReady === 'initial' && typeof window.__resetPwaInstallPromptFixture === 'function'", 30_000)
  }

  const token = `${Date.now()}-${Math.random()}`
  await client.evaluate(`window.__resetPwaInstallPromptFixture(${JSON.stringify({ token, navigatorEvidence: parameters })})`)
  await waitFor(client, `window.__pwaInstallPromptFixtureReady === ${JSON.stringify(token)}`)
  await client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  if (parameters.standalone !== 'true') {
    await waitFor(client, "document.querySelector('#root')?.childElementCount > 0")
    await waitFor(client, "Boolean(document.querySelector('[data-pwa-install]'))")
  }
}

async function dispatchInstallEvent(client, outcome) {
  return client.evaluate(`(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true })
    Object.defineProperty(event, '__pwaPreservationFixture', { value: true })
    event.prompt = async () => { window.__androidRegression.promptCalls += 1 }
    Object.defineProperty(event, 'userChoice', {
      configurable: true,
      get() {
        window.__androidRegression.promptChoiceReads += 1
        return Promise.resolve({ outcome: ${JSON.stringify(outcome)} })
      },
    })
    window.dispatchEvent(event)
    window.__androidRegression.beforeInstallDefaultPrevented = event.defaultPrevented
    return event.defaultPrevented
  })()`)
}

async function installEvent(client, outcome) {
  const defaultPrevented = await dispatchInstallEvent(client, outcome)
  assert.equal(defaultPrevented, true, 'beforeinstallprompt should be captured and prevented')
  await waitFor(client, "document.querySelector('[data-pwa-install]')?.getAttribute('aria-haspopup') === null")
}

async function dispatchAppInstalled(client) {
  await client.evaluate(`(() => {
    window.__androidRegression.appInstalledEvents += 1
    window.dispatchEvent(new Event('appinstalled'))
  })()`)
}

async function clickInstall(client) {
  await client.evaluate("document.querySelector('[data-pwa-install]').click()")
}

const keyboardKeys = {
  Enter: { code: 'Enter', virtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', virtualKeyCode: 27, text: '' },
  Tab: { code: 'Tab', virtualKeyCode: 9, text: '' },
}

async function focus(client, selector) {
  const focused = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    element?.focus({ preventScroll: true })
    return document.activeElement === element
  })()`)
  assert.equal(focused, true, `Expected browser focus on ${selector}`)
}

async function key(client, value, modifiers = 0) {
  const definition = keyboardKeys[value]
  assert.ok(definition, `Unsupported CDP keyboard key: ${value}`)
  const fields = {
    key: value,
    code: definition.code,
    modifiers,
    windowsVirtualKeyCode: definition.virtualKeyCode,
    nativeVirtualKeyCode: definition.virtualKeyCode,
    autoRepeat: false,
  }
  const text = modifiers === 0 ? definition.text : ''
  await client.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    ...fields,
    text,
    unmodifiedText: text,
  })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...fields })
}

async function snapshot(client) {
  return client.evaluate(`({
    apkRequests: window.__androidRegression.apkRequests,
    downloads: window.__androidRegression.downloads,
    promptCalls: window.__androidRegression.promptCalls,
    promptChoiceReads: window.__androidRegression.promptChoiceReads,
    beforeInstallDefaultPrevented: window.__androidRegression.beforeInstallDefaultPrevented,
    appInstalledEvents: window.__androidRegression.appInstalledEvents,
    listeners: window.__androidRegression.listeners,
    unhandled: window.__androidRegression.unhandled,
    controlVisible: Boolean(document.querySelector('[data-pwa-install]')),
    ariaHasPopup: document.querySelector('[data-pwa-install]')?.getAttribute('aria-haspopup') ?? null,
    dialog: Boolean(document.querySelector('[role="dialog"]')),
  })`)
}

const nonBugPlatformFixtures = [
  {
    name: 'authoritative Windows hint overrides an Android-looking user agent',
    parameters: { platform: 'Windows', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' },
  },
  { name: 'authoritative macOS hint', parameters: { platform: 'macOS', ua: 'Synthetic desktop UA' } },
  { name: 'authoritative Linux hint', parameters: { platform: 'Linux', ua: 'Synthetic desktop UA' } },
  { name: 'authoritative iOS hint', parameters: { platform: 'iOS', ua: 'Synthetic mobile UA' } },
  {
    name: 'present empty hint remains uncertain despite Android-looking user agent',
    parameters: { platform: '', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' },
  },
  {
    name: 'present missing hint platform remains uncertain',
    parameters: { uaData: 'missing-platform', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' },
  },
  {
    name: 'present non-string hint platform remains uncertain',
    parameters: { uaData: 'non-string-platform', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' },
  },
  {
    name: 'malformed client-hint evidence remains uncertain',
    parameters: { uaData: 'primitive', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' },
  },
  {
    name: 'null client-hint platform remains uncertain',
    parameters: { uaData: 'null-platform', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' },
  },
  {
    name: 'absent client hints use a non-Android user agent fallback',
    parameters: { uaData: 'absent', ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/124 Safari/537.36' },
  },
  {
    name: 'missing usable navigator evidence remains uncertain',
    parameters: { uaData: 'absent', ua: '' },
  },
]

const promptOutcomes = ['accepted', 'dismissed', 'unavailable']

test('PWA preservation: generated non-Android and uncertain inputs retain accepted, dismissed, and unavailable PWA outcomes', { timeout: 180_000 }, async () => {
  // **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
  const observations = []

  await withBrowser(async ({ client, origin }) => {
    for (const fixture of nonBugPlatformFixtures) {
      for (const outcome of promptOutcomes) {
        await navigate(client, origin, fixture.parameters)
        if (outcome !== 'unavailable') await installEvent(client, outcome)

        await clickInstall(client)
        if (outcome === 'accepted') {
          await waitFor(client, 'window.__androidRegression.promptCalls === 1 && window.__androidRegression.promptChoiceReads === 1')
          await delay(50)
        } else if (outcome === 'dismissed') {
          await waitFor(client, "Boolean(document.querySelector('[role=dialog]'))")
        } else {
          await waitFor(client, "Boolean(document.querySelector('[role=dialog]'))")
        }

        const state = await snapshot(client)
        observations.push({ fixture: fixture.name, outcome, state })

        assert.deepEqual(state.downloads, [], `${fixture.name} / ${outcome}: no APK selection`)
        assert.deepEqual(state.apkRequests, [], `${fixture.name} / ${outcome}: no APK probe`)
        assert.deepEqual(state.unhandled, [], `${fixture.name} / ${outcome}: no unhandled browser error`)
        assert.equal(state.promptCalls, outcome === 'unavailable' ? 0 : 1, `${fixture.name} / ${outcome}: prompt calls`)
        assert.equal(state.promptChoiceReads, outcome === 'unavailable' ? 0 : 1, `${fixture.name} / ${outcome}: choice reads`)
        assert.equal(state.dialog, outcome !== 'accepted', `${fixture.name} / ${outcome}: instructions visibility`)
      }
    }
  })

  assert.equal(observations.length, nonBugPlatformFixtures.length * promptOutcomes.length)
})

test('PWA preservation: control semantics, standalone hiding, installed state, and listener cleanup remain intact', { timeout: 90_000 }, async () => {
  // **Validates: Requirements 3.3, 3.4, 3.5**
  await withBrowser(async ({ client, origin }) => {
    await navigate(client, origin, { platform: 'Windows' })
    const control = await client.evaluate(`(() => {
      const button = document.querySelector('[data-pwa-install]')
      return {
        tagName: button?.tagName,
        text: button?.textContent?.trim(),
        type: button?.type,
        hasDataHook: button?.hasAttribute('data-pwa-install'),
        ariaHasPopup: button?.getAttribute('aria-haspopup'),
      }
    })()`)
    assert.deepEqual(control, {
      tagName: 'BUTTON',
      text: 'Download App',
      type: 'button',
      hasDataHook: true,
      ariaHasPopup: 'dialog',
    })

    const initial = await snapshot(client)
    for (const type of ['beforeinstallprompt', 'appinstalled']) {
      assert.ok(initial.listeners[type].adds >= 1, `${type} listener is registered`)
      assert.equal(initial.listeners[type].adds - initial.listeners[type].removes, 1, `${type} has one active listener`)
    }

    await installEvent(client, 'dismissed')
    assert.equal((await snapshot(client)).ariaHasPopup, null, 'captured install event removes dialog popup semantics')
    await clickInstall(client)
    await waitFor(client, "Boolean(document.querySelector('[role=dialog]'))")

    await dispatchAppInstalled(client)
    await waitFor(client, "!document.querySelector('[data-pwa-install]') && !document.querySelector('[role=dialog]')")
    await waitFor(client, `(() => {
      const listeners = window.__androidRegression.listeners
      return listeners.beforeinstallprompt.adds === listeners.beforeinstallprompt.removes
        && listeners.appinstalled.adds === listeners.appinstalled.removes
    })()`)

    const installed = await snapshot(client)
    assert.equal(installed.controlVisible, false)
    assert.equal(installed.dialog, false)
    assert.equal(installed.appInstalledEvents, 1)
    for (const type of ['beforeinstallprompt', 'appinstalled']) {
      assert.equal(installed.listeners[type].adds, installed.listeners[type].removes, `${type} listener is cleaned up`)
    }

    const postCleanupPrevented = await dispatchInstallEvent(client, 'accepted')
    assert.equal(postCleanupPrevented, false, 'cleaned-up beforeinstallprompt listener no longer captures events')
    assert.equal((await snapshot(client)).controlVisible, false, 'installed state remains hidden')

    await navigate(client, origin, { platform: 'Windows', standalone: 'true' })
    const standalone = await snapshot(client)
    assert.equal(standalone.controlVisible, false)
    assert.equal(standalone.dialog, false)
    assert.deepEqual(standalone.listeners, {
      beforeinstallprompt: { adds: 0, removes: 0 },
      appinstalled: { adds: 0, removes: 0 },
    })
  })
})

test('PWA preservation: dialog accessibility, focus containment, all close paths, and Enter activation remain intact', { timeout: 90_000 }, async () => {
  // **Validates: Requirements 3.4, 3.6**
  await withBrowser(async ({ client, origin }) => {
    await navigate(client, origin, { platform: 'Windows' })
    await focus(client, '[data-pwa-install]')
    await key(client, 'Enter')
    await waitFor(client, "Boolean(document.querySelector('[role=dialog]'))")

    const dialogState = await client.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const labelledBy = dialog?.getAttribute('aria-labelledby')
      return {
        role: dialog?.getAttribute('role'),
        modal: dialog?.getAttribute('aria-modal'),
        labelledBy,
        accessibleLabel: document.getElementById(labelledBy)?.textContent?.trim(),
        activeLabel: document.activeElement?.getAttribute('aria-label'),
      }
    })()`)
    assert.deepEqual(dialogState, {
      role: 'dialog',
      modal: 'true',
      labelledBy: 'pwa-install-title',
      accessibleLabel: 'Install Vivek Marco Trader',
      activeLabel: 'Close install instructions',
    })

    await key(client, 'Tab', 8)
    await waitFor(client, "document.activeElement?.textContent?.trim() === 'Theek Hai'")
    await key(client, 'Tab')
    await waitFor(client, "document.activeElement?.getAttribute('aria-label') === 'Close install instructions'")
    assert.equal(await client.evaluate("document.querySelector('[role=dialog]').contains(document.activeElement)"), true)

    await key(client, 'Escape')
    await waitFor(client, "!document.querySelector('[role=dialog]')")
    await waitFor(client, "document.activeElement?.hasAttribute('data-pwa-install')")

    await clickInstall(client)
    await waitFor(client, "document.activeElement?.getAttribute('aria-label') === 'Close install instructions'")
    await client.evaluate("document.querySelector('[aria-label=\"Close install instructions\"]')?.click()")
    await waitFor(client, "!document.querySelector('[role=dialog]')")
    await waitFor(client, "document.activeElement?.hasAttribute('data-pwa-install')")

    await clickInstall(client)
    await waitFor(client, "Boolean(document.querySelector('[role=dialog]'))")
    await client.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Theek Hai')?.click()")
    await waitFor(client, "!document.querySelector('[role=dialog]')")
    await waitFor(client, "document.activeElement?.hasAttribute('data-pwa-install')")

    const final = await snapshot(client)
    assert.deepEqual(final.downloads, [])
    assert.deepEqual(final.apkRequests, [])
    assert.deepEqual(final.unhandled, [])
  })
})

test('Android classification verifies and selects the canonical APK for authoritative hints and legacy fallback', { timeout: 90_000 }, async () => {
  // **Validates: Requirements 2.1, 2.2, 2.4**
  const fixtures = [
    {
      name: 'authoritative Android hint with prompt present',
      parameters: { platform: 'Android', ua: 'Synthetic desktop UA' },
      promptOutcome: 'accepted',
    },
    {
      name: 'trimmed mixed-case Android hint with prompt absent',
      parameters: { platform: '  aNdRoId  ', ua: 'Synthetic desktop UA' },
    },
    {
      name: 'case-variant legacy Android user agent with prompt present',
      parameters: { platform: 'Windows', uaData: 'absent', ua: 'Mozilla/5.0 (Linux; aNdRoId 14; Pixel 8)' },
      promptOutcome: 'accepted',
    },
    {
      name: 'legacy Android user agent with prompt absent',
      parameters: { platform: 'Windows', uaData: 'absent', ua: 'Mozilla/5.0 (Linux; Android 13; Device)' },
    },
  ]
  const counterexamples = []

  await withBrowser(async ({ client, origin }) => {
    for (const fixture of fixtures) {
      await navigate(client, origin, fixture.parameters)
      if (fixture.promptOutcome) await installEvent(client, fixture.promptOutcome)
      await clickInstall(client)
      try {
        await waitFor(client, 'window.__androidRegression.downloads.length === 1 || window.__androidRegression.unhandled.length > 0')
      } catch (error) {
        const diagnostics = await client.evaluate(`({
          effectiveUserAgent: typeof navigator.userAgent === 'string' ? navigator.userAgent : typeof navigator.userAgent,
          effectivePlatform: (() => {
            try { return navigator.userAgentData?.platform ?? null } catch (caught) { return 'unreadable' }
          })(),
          regression: window.__androidRegression,
          control: document.querySelector('[data-pwa-install]')?.outerHTML ?? null,
        })`)
        throw new Error(`${error.message}\nAndroid fixture: ${fixture.name}\n${JSON.stringify(diagnostics, null, 2)}`)
      }
      const state = await snapshot(client)
      counterexamples.push({
        name: fixture.name,
        result: {
          selectedPath: state.downloads[0] ?? null,
          apkSelectionCount: state.downloads.length,
          pwaPromptInvocationCount: state.promptCalls,
          pwaPromptChoiceReadCount: state.promptChoiceReads,
          instructionsOpened: state.dialog,
          apkNetworkRequests: state.apkRequests,
          unhandledErrors: state.unhandled,
        },
      })
    }
  })

  const allSatisfyVerifiedSelection = counterexamples.every(({ result }) => expectedBehavior(result)
    && result.pwaPromptChoiceReadCount === 0
    && result.unhandledErrors.length === 0)

  assert.equal(
    allSatisfyVerifiedSelection,
    true,
    `Android verified-selection counterexamples:\n${JSON.stringify(counterexamples, null, 2)}`,
  )
})
