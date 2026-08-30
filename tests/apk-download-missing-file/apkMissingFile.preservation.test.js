import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { ANDROID_APK_FILENAME, ANDROID_APK_PATH, selectAndroidApk } from '../../src/components/pwaInstallSelection.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const fixturePath = '/tests/apk-download-missing-file/preservation.fixture.html'
const preservationSeed = 0x41504b32
const descriptorPath = '/downloads/vivek-marco-trader.apk.json'
const releaseDescriptor = JSON.parse(await readFile(path.join(repositoryRoot, 'public', 'downloads', 'vivek-marco-trader.apk.json'), 'utf8'))
const releaseUrl = `https://app.invalid${releaseDescriptor.path}?v=${releaseDescriptor.sha256}`
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function generatedValues(seed, count) {
  let state = seed >>> 0
  return Array.from({ length: count }, () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state
  })
}

function createDocumentObservation() {
  const result = { created: [], appended: 0, clicks: 0, removals: 0, href: null, download: null }
  const anchor = {
    href: '',
    download: '',
    click() {
      result.clicks += 1
      result.href = this.href
      result.download = this.download
    },
    remove() { result.removals += 1 },
  }
  return {
    result,
    documentLike: {
      body: { appendChild() { result.appended += 1 } },
      createElement(tagName) {
        result.created.push(tagName)
        return anchor
      },
    },
  }
}

function verifiedResponse(body, { status, url, headers }) {
  const payload = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body))
  return {
    status,
    url,
    redirected: false,
    headers: new Headers(headers),
    body: new Response(payload).body,
    async arrayBuffer() {
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
    },
  }
}

function createVerifiedNetworkObservation() {
  const calls = []
  return {
    calls,
    async fetch(input, options = {}) {
      const url = new URL(input)
      if (url.pathname === descriptorPath) {
        calls.push({ stage: 'descriptor', url: url.href, options })
        return verifiedResponse(JSON.stringify(releaseDescriptor), {
          status: 200,
          url: url.href,
          headers: { 'content-type': 'application/json' },
        })
      }

      const isPrefix = options.headers?.Range === 'bytes=0-3'
      const finalOffset = releaseDescriptor.byteSize - 1
      calls.push({ stage: isPrefix ? 'prefix' : 'tail', url: url.href, options })
      return verifiedResponse(isPrefix
        ? new Uint8Array([0x50, 0x4b, 0x03, 0x04])
        : new Uint8Array([0x00]), {
        status: 206,
        url: url.href,
        headers: {
          'content-type': releaseDescriptor.mediaType,
          'content-disposition': `attachment; filename="${releaseDescriptor.filename}"`,
          'content-range': isPrefix
            ? `bytes 0-3/${releaseDescriptor.byteSize}`
            : `bytes ${finalOffset}-${finalOffset}/${releaseDescriptor.byteSize}`,
          'content-length': isPrefix ? '4' : '1',
        },
      })
    },
  }
}

function parseTomlRedirects(source) {
  return source.split('[[redirects]]').slice(1).map(block => ({
    from: block.match(/^\s*from\s*=\s*"([^"]+)"/m)?.[1],
    to: block.match(/^\s*to\s*=\s*"([^"]+)"/m)?.[1],
    status: Number(block.match(/^\s*status\s*=\s*(\d+)/m)?.[1]),
  }))
}

function parseRedirectFile(source) {
  return source.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [from, to, status] = line.split(/\s+/)
      return { from, to, status: Number(status) }
    })
}

function ruleMatches(pathname, pattern) {
  if (pattern === pathname || pattern === '/*') return true
  return pattern?.endsWith('*') && pathname.startsWith(pattern.slice(0, -1))
}

function effectiveRoute(pathname, rules) {
  const rule = rules.find(candidate => ruleMatches(pathname, candidate.from))
  return rule ? { pathname, ...rule } : { pathname, from: null, to: pathname, status: 404 }
}

function safeReleaseInventory(paths) {
  const allowed = new Set([
    'public/downloads/vivek-marco-trader.apk',
    'public/downloads/vivek-marco-trader.apk.json',
  ])
  return paths.length === allowed.size && paths.every(candidate => allowed.has(candidate))
}

async function dispatchServiceWorker(source, requestFixture) {
  const listeners = new Map()
  const observations = { respondWith: 0, fetches: 0, cacheOpens: 0, cacheMatches: 0, cachePuts: 0 }
  let responsePromise
  const cachedHtml = new Response('<!doctype html><title>offline shell</title>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
  const cachedStatic = new Response('synthetic static bytes', { status: 200 })
  const cache = {
    addAll: async () => undefined,
    match: async target => {
      observations.cacheMatches += 1
      return String(target).includes('index.html') ? cachedHtml.clone() : cachedStatic.clone()
    },
    put: async () => { observations.cachePuts += 1 },
  }
  const self = {
    location: { origin: 'https://app.invalid' },
    clients: { claim: async () => undefined },
    addEventListener(type, listener) { listeners.set(type, listener) },
  }
  vm.runInNewContext(source, {
    self,
    URL,
    Headers,
    Response,
    caches: {
      open: async () => { observations.cacheOpens += 1; return cache },
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => {
      observations.fetches += 1
      throw new TypeError('synthetic offline')
    },
  }, { filename: 'public/sw.js' })

  listeners.get('fetch')({
    request: {
      method: requestFixture.method || 'GET',
      mode: requestFixture.mode || 'cors',
      url: requestFixture.url,
      headers: new Headers(requestFixture.authorization ? { authorization: 'synthetic-token' } : {}),
    },
    respondWith(value) {
      observations.respondWith += 1
      responsePromise = Promise.resolve(value)
    },
  })
  const response = responsePromise ? await responsePromise : undefined
  return {
    ...observations,
    responseStatus: response?.status ?? null,
    responseType: response?.headers.get('content-type') || null,
  }
}

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
    if (process.exitCode !== null) throw new Error(`Process exited before ${url} was ready.\n${output.join('')}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${url}.\n${output.join('')}`)
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
  throw new Error('No Chromium-compatible browser found; set EDGE_PATH to run the preservation fixture.')
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

async function waitForPage(client, expression, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(expression)) return
    } catch {}
    await delay(80)
  }
  const diagnostic = await client.evaluate('JSON.stringify({ url: location.href, body: document.body?.innerText, html: document.body?.innerHTML?.slice(0, 2000) })').catch(error => error.message)
  throw new Error(`Timed out waiting for ${expression}. Page: ${diagnostic}`)
}

async function startBrowserHarness() {
  const vitePort = await freePort()
  const debuggingPort = await freePort()
  const output = []
  const vite = spawn(process.execPath, [
    path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', path.join(testDirectory, 'vite.preservation.config.js'),
    '--host', '127.0.0.1',
    '--port', String(vitePort),
    '--strictPort',
  ], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  vite.stdout.on('data', chunk => output.push(chunk.toString()))
  vite.stderr.on('data', chunk => output.push(chunk.toString()))

  const profile = await mkdtemp(path.join(os.tmpdir(), 'vmt-apk-preservation-'))
  const browser = spawn(await findBrowser(), [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let client
  try {
    await waitForHttp(`http://127.0.0.1:${vitePort}${fixturePath}`, vite, output)
    await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, browser, [])
    const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    const page = targets.find(target => target.type === 'page' && target.url === 'about:blank')
    assert.ok(page?.webSocketDebuggerUrl, 'The explicitly launched about:blank browser page is required')
    client = await CdpClient.connect(page.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    return { client, vite, browser, profile, origin: `http://127.0.0.1:${vitePort}` }
  } catch (error) {
    client?.close()
    vite.kill()
    browser.kill()
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function stopBrowserHarness(harness) {
  harness.client?.close()
  harness.vite?.kill()
  harness.browser?.kill()
  await delay(300)
  await rm(harness.profile, { recursive: true, force: true }).catch(() => undefined)
}

async function navigateFixture(harness, mode, width) {
  await harness.client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 800,
    deviceScaleFactor: 1,
    mobile: width < 700,
  })
  const url = `${harness.origin}${fixturePath}?mode=${mode}&seed=${preservationSeed}&width=${width}`
  await harness.client.send('Page.navigate', { url })
  await waitForPage(harness.client, `location.href === ${JSON.stringify(url)} && Boolean(window.__apkPreservation?.ready)`, 30_000)
}

async function focus(client, selector) {
  assert.equal(await client.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node?.focus(); return document.activeElement === node })()`), true)
}

async function key(client, value) {
  const definitions = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Space: { code: 'Space', keyCode: 32, text: ' ' },
    Escape: { code: 'Escape', keyCode: 27, text: '' },
  }
  const definition = definitions[value]
  await client.send('Input.dispatchKeyEvent', {
    type: definition.text ? 'keyDown' : 'rawKeyDown',
    key: value === 'Space' ? ' ' : value,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
    text: definition.text,
    unmodifiedText: definition.text,
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: value === 'Space' ? ' ' : value,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
  })
}

async function activate(client, selector, modality) {
  await focus(client, selector)
  if (modality === 'pointer') {
    await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  } else if (modality === 'touch') {
    await client.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })); node.click() })()`)
  } else {
    await key(client, modality)
  }
}

async function snapshot(client) {
  return client.evaluate('window.__apkPreservation.snapshot()')
}

test('preservation oracle classifies canonical verified selection, SPA routing, and safe release inventories', async () => {
  const { documentLike, result } = createDocumentObservation()
  const network = createVerifiedNetworkObservation()
  const selection = await selectAndroidApk({
    document: documentLike,
    fetch: network.fetch,
    location: { origin: 'https://app.invalid' },
    nonce: 'preservation-oracle',
  })
  const selectedUrl = new URL(result.href)
  assert.equal(selection.status, 'requested')
  assert.equal(selection.claimedDownloadStarted, false)
  assert.equal(selection.claimedTransferCompleted, false)
  assert.deepEqual(network.calls.map(call => call.stage), ['descriptor', 'prefix', 'tail'])
  assert.deepEqual(result.created, ['a'])
  assert.equal(selectedUrl.pathname, ANDROID_APK_PATH)
  assert.equal(selectedUrl.search, `?v=${releaseDescriptor.sha256}`)
  assert.equal(result.download, ANDROID_APK_FILENAME)
  assert.equal(result.clicks, 1)
  assert.equal(result.removals, 1)

  assert.equal(safeReleaseInventory([
    'public/downloads/vivek-marco-trader.apk',
    'public/downloads/vivek-marco-trader.apk.json',
  ]), true)
  assert.equal(safeReleaseInventory(['public/downloads/debug.apk']), false)
  assert.equal(ruleMatches('/login', '/*'), true)
  assert.equal(ruleMatches('/downloads/missing.apk', '/downloads/*'), true)
})

test('Property 2: Preservation — Existing Application, PWA, Accessibility, and Release Security', { timeout: 180_000 }, async () => {
  // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**
  const [
    appSource,
    publicMenuSource,
    layoutSource,
    serviceWorkerSource,
    registrationSource,
    netlifySource,
    redirectsSource,
    manifestSource,
    indexSource,
    mainSource,
    gitignoreSource,
    syncAndroidSource,
    releaseSigningSource,
    authSource,
    subscriptionSource,
    tradeSource,
    analyticsSource,
    proTradingSource,
    webhookSource,
  ] = await Promise.all([
    readFile(path.join(repositoryRoot, 'src', 'App.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'components', 'PublicDownloadMenu.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'components', 'Layout.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'public', 'sw.js'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'registerServiceWorker.js'), 'utf8'),
    readFile(path.join(repositoryRoot, 'netlify.toml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'public', '_redirects'), 'utf8'),
    readFile(path.join(repositoryRoot, 'public', 'manifest.json'), 'utf8'),
    readFile(path.join(repositoryRoot, 'index.html'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'main.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, '.gitignore'), 'utf8'),
    readFile(path.join(repositoryRoot, 'scripts', 'sync-android.mjs'), 'utf8'),
    readFile(path.join(repositoryRoot, 'android', 'app', 'release-signing.gradle'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'context', 'AuthContext.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'context', 'SubscriptionContext.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'context', 'TradeContext.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'pages', 'Analytics.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'trading', 'ProTrading.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'services', 'webhookApiConfig.js'), 'utf8'),
  ])

  const manifest = JSON.parse(manifestSource)
  const publicDownloadInventory = (await readdir(path.join(repositoryRoot, 'public', 'downloads'))).sort()
  const expectedPublicInventory = [ANDROID_APK_FILENAME, `${ANDROID_APK_FILENAME}.json`].sort()
  assert.deepEqual(publicDownloadInventory, expectedPublicInventory)
  await Promise.all(manifest.icons.map(icon => access(path.join(repositoryRoot, 'public', icon.src.slice(1)))))

  const netlifyRules = parseTomlRedirects(netlifySource)
  const publicRules = parseRedirectFile(redirectsSource)
  const nonDownloadPaths = ['/', '/login', '/signup', '/subscription', '/history', '/analytics', '/pro-trading', '/settings']
  const routeObservations = []
  for (const pathname of nonDownloadPaths) {
    const netlify = effectiveRoute(pathname, netlifyRules)
    const redirects = effectiveRoute(pathname, publicRules)
    assert.deepEqual({ to: netlify.to, status: netlify.status }, { to: '/index.html', status: 200 }, pathname)
    assert.deepEqual({ to: redirects.to, status: redirects.status }, { to: '/index.html', status: 200 }, pathname)
    routeObservations.push({ pathname, netlify, redirects })
  }

  const selectorObservations = []
  for (const [index, value] of generatedValues(preservationSeed, 24).entries()) {
    const entryPoint = index % 2 ? 'authenticated' : 'public'
    const modality = ['pointer', 'touch', 'Enter', 'Space'][value % 4]
    const viewport = value % 3 === 0 ? 'mobile' : 'desktop'
    const { documentLike, result } = createDocumentObservation()
    const network = createVerifiedNetworkObservation()
    const selection = await selectAndroidApk({
      document: documentLike,
      fetch: network.fetch,
      location: { origin: 'https://app.invalid' },
      nonce: `preservation-${index}`,
    })
    const selectedUrl = new URL(result.href)
    assert.equal(selection.status, 'requested')
    assert.equal(selection.claimedDownloadStarted, false)
    assert.equal(selection.claimedTransferCompleted, false)
    assert.deepEqual(network.calls.map(call => call.stage), ['descriptor', 'prefix', 'tail'])
    assert.equal(selectedUrl.pathname, ANDROID_APK_PATH)
    assert.equal(selectedUrl.search, `?v=${releaseDescriptor.sha256}`)
    assert.equal(result.download, ANDROID_APK_FILENAME)
    assert.equal(result.clicks, 1)
    assert.equal(result.removals, 1)
    selectorObservations.push({ entryPoint, modality, viewport, selectionStatus: selection.status, ...result })
  }

  const serviceWorkerFixtures = [
    ...[ANDROID_APK_PATH, descriptorPath].flatMap(pathname => [
      { name: `${pathname} plain`, url: `https://app.invalid${pathname}` },
      { name: `${pathname} versioned`, url: `https://app.invalid${pathname}?v=synthetic-digest` },
    ]),
    { name: 'ordinary offline navigation', url: 'https://app.invalid/history', mode: 'navigate', intercepted: true },
    { name: 'ordinary cached icon', url: 'https://app.invalid/icons/icon-192.png', intercepted: true },
    { name: 'sensitive API', url: 'https://app.invalid/api/trades' },
    { name: 'authorized request', url: 'https://app.invalid/assets/private.js', authorization: true },
    { name: 'cross-origin static', url: 'https://cdn.invalid/assets/app.js' },
    { name: 'non-GET request', url: 'https://app.invalid/manifest.json', method: 'POST' },
  ]
  const serviceWorkerObservations = []
  for (const fixture of serviceWorkerFixtures) {
    const observed = await dispatchServiceWorker(serviceWorkerSource, fixture)
    if (fixture.intercepted) {
      assert.equal(observed.respondWith, 1, fixture.name)
      assert.equal(observed.responseStatus, 200, fixture.name)
    } else {
      assert.deepEqual(observed, {
        respondWith: 0,
        fetches: 0,
        cacheOpens: 0,
        cacheMatches: 0,
        cachePuts: 0,
        responseStatus: null,
        responseType: null,
      }, fixture.name)
    }
    serviceWorkerObservations.push({ ...fixture, observed })
  }

  assert.deepEqual({ id: manifest.id, startUrl: manifest.start_url, scope: manifest.scope, display: manifest.display }, {
    id: '/', startUrl: '/', scope: '/', display: 'standalone',
  })
  assert.match(indexSource, /rel="manifest" href="\/manifest\.json"/)
  assert.match(mainSource, /registerServiceWorker\(\)/)
  assert.match(registrationSource, /updateViaCache:\s*'none'/)
  assert.match(registrationSource, /controllerchange/)
  assert.match(registrationSource, /registration\.update\(\)/)
  assert.match(serviceWorkerSource, /CACHE_VERSION = 'vmt-pwa-v2'/)
  assert.match(serviceWorkerSource, /networkFirstNavigation/)
  assert.match(serviceWorkerSource, /staleWhileRevalidate/)
  assert.ok(serviceWorkerSource.indexOf("url.pathname.startsWith('/downloads/')") < serviceWorkerSource.indexOf("request.mode === 'navigate'"))

  assert.match(publicMenuSource, /aria-expanded=\{open\}/)
  assert.match(publicMenuSource, /aria-controls="public-download-menu"/)
  assert.match(publicMenuSource, /pointerdown/)
  assert.match(publicMenuSource, /event\.key !== 'Escape'/)
  assert.match(layoutSource, /aria-controls="app-sidebar"/)
  assert.match(layoutSource, /title=\{collapsed \? 'Download App' : undefined\}/)
  assert.equal((appSource.match(/<PublicDownloadMenu\s*\/>/g) || []).length, 1)
  assert.equal((appSource.match(/<Layout\s*\/>/g) || []).length, 1)
  assert.doesNotMatch(appSource, /PWAInstallPrompt/)

  for (const route of ['/login', '/signup', '/pro-trading', 'subscription', 'history', 'analytics', 'algo-trading', 'settings']) {
    assert.ok(appSource.includes(`path="${route}"`), `App route ${route} remains declared`)
  }
  assert.match(authSource, /onAuthStateChanged/)
  assert.match(subscriptionSource, /hasPlan/)
  assert.match(tradeSource, /addTrade/)
  assert.match(analyticsSource, /useTrades/)
  assert.match(proTradingSource, /useTradingStore/)
  assert.match(webhookSource, /https:\/\/vivek-raj\.onrender\.com/)

  assert.match(syncAndroidSource, /rm\(path\.join\(publicAssetsRoot, 'downloads'\), \{ recursive: true, force: true \}\)/)
  assert.match(releaseSigningSource, /VMT_ANDROID_KEYSTORE_PATH/)
  assert.match(releaseSigningSource, /verifyReleaseSigning/)
  assert.match(releaseSigningSource, /approved-release/)
  assert.match(releaseSigningSource, /must be an existing absolute external file/)
  for (const exclusion of ['/android/local.properties', '/android/**/*.jks', '/android/**/*.keystore', '/android/**/build/']) {
    assert.ok(gitignoreSource.includes(exclusion), `release exclusion ${exclusion}`)
  }
  assert.equal(safeReleaseInventory(publicDownloadInventory.map(name => `public/downloads/${name}`)), true)
  for (const generatedInventory of [
    ['public/downloads/vivek-marco-trader.apk', 'public/downloads/vivek-marco-trader.apk.json'],
    ['public/downloads/vivek-marco-trader.apk', 'public/downloads/debug.apk'],
    ['public/downloads/vivek-marco-trader.apk', 'android/app/release.keystore'],
    ['public/downloads/vivek-marco-trader.apk.json', 'android/app/build/outputs/apk/debug/app-debug.apk'],
    ['public/downloads/vivek-marco-trader.apk', 'public/downloads/app.js.map'],
  ]) {
    assert.equal(safeReleaseInventory(generatedInventory), generatedInventory.length === 2 && generatedInventory.every(value => expectedPublicInventory.some(name => value === `public/downloads/${name}`)))
  }

  const browser = await startBrowserHarness()
  const browserObservations = []
  try {
    const publicScenarios = [
      { modality: 'pointer', width: 1280 },
      { modality: 'touch', width: 390 },
      { modality: 'Enter', width: 1280 },
      { modality: 'Space', width: 390 },
    ]
    for (const scenario of publicScenarios) {
      await navigateFixture(browser, 'public', scenario.width)
      let observed = await snapshot(browser.client)
      assert.deepEqual(observed.trigger, { label: 'Open menu', expanded: 'false', controls: 'public-download-menu', hasPopup: 'menu' })
      assert.equal(observed.installControlCount, 0)

      await activate(browser.client, '[data-public-menu-trigger]', scenario.modality)
      await waitForPage(browser.client, "document.querySelector('[role=menuitem]')?.textContent.includes('Download App')")
      observed = await snapshot(browser.client)
      assert.equal(observed.trigger.expanded, 'true')
      assert.equal(observed.installControlCount, 1)
      assert.equal(observed.control.text, 'Download App')

      await activate(browser.client, '[role=menuitem]', scenario.modality)
      await waitForPage(browser.client, "window.__apkPreservation.snapshot().downloads.length === 1 && document.querySelector('[role=menuitem]')?.textContent.includes('Manual download')")
      observed = await snapshot(browser.client)
      assert.deepEqual(observed.downloads, [{ path: ANDROID_APK_PATH, search: `?v=${releaseDescriptor.sha256}`, download: ANDROID_APK_FILENAME }])
      assert.equal(observed.menuVisible, true)
      assert.equal(observed.control.text, 'Manual download')
      assert.ok(observed.preflightRequests.length >= 6)
      assert.deepEqual(observed.errors, [])
      browserObservations.push({ entryPoint: 'public', ...scenario, observed })
    }

    await navigateFixture(browser, 'public', 1280)
    await activate(browser.client, '[data-public-menu-trigger]', 'Enter')
    await waitForPage(browser.client, "Boolean(document.querySelector('[role=menu]'))")
    await focus(browser.client, '[data-public-menu-trigger]')
    await key(browser.client, 'Escape')
    await waitForPage(browser.client, "!document.querySelector('[role=menu]')")
    let dismissal = await snapshot(browser.client)
    assert.equal(dismissal.activeIsTrigger, true)
    browserObservations.push({ entryPoint: 'public', behavior: 'escape-focus-return', observed: dismissal })

    await activate(browser.client, '[data-public-menu-trigger]', 'pointer')
    await waitForPage(browser.client, "Boolean(document.querySelector('[role=menu]'))")
    await browser.client.evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))")
    await waitForPage(browser.client, "!document.querySelector('[role=menu]')")
    dismissal = await snapshot(browser.client)
    browserObservations.push({ entryPoint: 'public', behavior: 'outside-dismissal', observed: dismissal })

    await navigateFixture(browser, 'authenticated', 390)
    let authenticated = await snapshot(browser.client)
    assert.equal(authenticated.installControlCount, 1)
    assert.equal(authenticated.routeContentVisible, true)
    await activate(browser.client, '[aria-controls="app-sidebar"]', 'touch')
    await waitForPage(browser.client, "document.querySelector('[aria-controls=app-sidebar]').getAttribute('aria-expanded') === 'true'")
    await waitForPage(browser.client, "document.querySelector('[data-pwa-install]')?.textContent.includes('Download App')")
    await activate(browser.client, '[data-pwa-install]', 'touch')
    await waitForPage(browser.client, "window.__apkPreservation.snapshot().downloads.length === 1")
    authenticated = await snapshot(browser.client)
    assert.equal(authenticated.mobileTriggerExpanded, 'false')
    assert.deepEqual(authenticated.downloads, [{ path: ANDROID_APK_PATH, search: `?v=${releaseDescriptor.sha256}`, download: ANDROID_APK_FILENAME }])
    assert.ok(authenticated.preflightRequests.length >= 6)
    assert.deepEqual(authenticated.errors, [])
    browserObservations.push({ entryPoint: 'authenticated', behavior: 'mobile-sidebar-download', observed: authenticated })

    await navigateFixture(browser, 'authenticated', 1280)
    await browser.client.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Collapse').click()")
    await waitForPage(browser.client, "document.querySelector('[data-pwa-install]').getAttribute('title') === 'Download App'")
    authenticated = await snapshot(browser.client)
    assert.equal(authenticated.control.title, 'Download App')
    assert.equal(authenticated.installControlCount, 1)
    assert.deepEqual(authenticated.errors, [])
    browserObservations.push({ entryPoint: 'authenticated', behavior: 'collapsed-label', observed: authenticated })
  } finally {
    await stopBrowserHarness(browser)
  }

  const report = {
    property: 'Property 2: Preservation — Existing Application, PWA, Accessibility, and Release Security',
    validates: ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8'],
    expectedResultOnUnfixedCode: 'PASS',
    result: 'PASS',
    seed: preservationSeed,
    observations: {
      canonicalPublicInventory: publicDownloadInventory,
      selectorScenarios: selectorObservations.length,
      routeObservations,
      serviceWorkerObservations,
      browserObservations,
      manifest: { id: manifest.id, startUrl: manifest.start_url, scope: manifest.scope, display: manifest.display, iconCount: manifest.icons.length },
      routeContext: { publicEntryPoints: 1, authenticatedEntryPoints: 1, dormantPromptMounted: false },
      releaseSecurity: { externalCertificateGate: true, nativeDownloadsRemovedBySync: true, exactPublicAllowlist: true },
      unrelatedProductBoundaries: ['authentication', 'subscriptions', 'trading', 'analytics', 'backend communication', 'routing'],
    },
  }
  const artifactDirectory = path.join(testDirectory, 'artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(path.join(artifactDirectory, 'preservation-baseline.json'), `${JSON.stringify(report, null, 2)}\n`)
})
