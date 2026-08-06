import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

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
    if (process.exitCode !== null) throw new Error(`Preview exited early:\n${output.join('')}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await delay(150)
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

async function waitFor(client, expression, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(expression)) return
    } catch {}
    await delay(150)
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`)
}

function pngSize(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

test('production manifest and icons satisfy PWA metadata requirements', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'dist', 'manifest.json'), 'utf8'))
  assert.equal(manifest.name, 'Vivek Marco Trader')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.theme_color, '#0a0a1f')

  for (const size of [192, 512]) {
    const icon = await readFile(path.join(root, 'dist', 'icons', `icon-${size}.png`))
    assert.deepEqual(pngSize(icon), { width: size, height: size })
    assert.ok(manifest.icons.some(entry => entry.sizes === `${size}x${size}` && entry.type === 'image/png'))
  }

  const html = await readFile(path.join(root, 'dist', 'index.html'), 'utf8')
  assert.match(html, /rel="manifest" href="\/manifest\.json"/)
  assert.match(html, /name="theme-color" content="#0a0a1f"/)
  await access(path.join(root, 'dist', 'sw.js'))
})

test('Chromium reports an active service worker and no installability errors', { timeout: 90_000 }, async () => {
  const previewPort = await getFreePort()
  const debuggingPort = await getFreePort()
  const output = []
  const preview = spawn(process.execPath, [
    path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  preview.stdout.on('data', chunk => output.push(chunk.toString()))
  preview.stderr.on('data', chunk => output.push(chunk.toString()))

  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'vmt-pwa-'))
  const browser = spawn(await findBrowser(), [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let client
  try {
    await waitForHttp(`http://127.0.0.1:${previewPort}`, preview, output)
    await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, browser, [])
    const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, 'A debuggable Chromium page is required')

    client = await CdpClient.connect(page.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "window.__pwaInstallPromptObserved = false; addEventListener('beforeinstallprompt', () => { window.__pwaInstallPromptObserved = true })",
    })
    await client.send('Page.navigate', { url: `http://127.0.0.1:${previewPort}/` })
    await waitFor(client, "document.readyState === 'complete'")
    await waitFor(client, "Boolean(document.querySelector('[data-pwa-install]'))")
    const installControl = await client.evaluate(`(async () => {
      const button = document.querySelector('[data-pwa-install]')
      const rect = button?.getBoundingClientRect()
      const ancestors = []
      for (let element = button; element; element = element.parentElement) ancestors.push(element)
      const ancestorStyles = ancestors.map(element => getComputedStyle(element))
      const intersectionRatio = button ? await new Promise(resolve => {
        const observer = new IntersectionObserver(entries => {
          resolve(entries[0]?.intersectionRatio || 0)
          observer.disconnect()
        }, { threshold: [1] })
        observer.observe(button)
      }) : 0
      const points = rect ? [0.15, 0.5, 0.85].flatMap(xRatio =>
        [0.25, 0.5, 0.75].map(yRatio => [
          rect.left + rect.width * xRatio,
          rect.top + rect.height * yRatio,
        ]),
      ) : []
      const allPointsReachButton = points.length === 9 && points.every(([x, y]) => {
        const target = document.elementFromPoint(x, y)
        return target && (target === button || button.contains(target))
      })
      const ancestorsVisible = ancestorStyles.every(style =>
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.contentVisibility !== 'hidden' &&
        style.pointerEvents !== 'none' &&
        Number(style.opacity) > 0 &&
        !/opacity\\(0(?:\\D|$)/i.test(style.filter)
      )
      const checks = {
        browserVisibility: Boolean(button?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })),
        hasSize: Boolean(rect && rect.width > 0 && rect.height > 0),
        insideViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
        fullyIntersecting: intersectionRatio >= 0.999,
        ancestorsVisible,
        allPointsReachButton,
      }
      return {
        text: button?.textContent?.trim(),
        visible: Object.values(checks).every(Boolean),
        checks,
      }
    })()`)
    assert.equal(installControl.text, 'Download App')
    assert.equal(installControl.visible, true, JSON.stringify(installControl.checks))
    await waitFor(client, "Boolean(navigator.serviceWorker) && (async () => Boolean((await navigator.serviceWorker.ready).active))()")
    await waitFor(client, 'Boolean(navigator.serviceWorker.controller)')

    const manifest = await client.send('Page.getAppManifest')
    assert.equal(manifest.errors?.length || 0, 0, JSON.stringify(manifest.errors))
    assert.ok(manifest.data?.includes('Vivek Marco Trader'))

    const { installabilityErrors = [] } = await client.send('Page.getInstallabilityErrors')
    assert.deepEqual(installabilityErrors, [], JSON.stringify(installabilityErrors))
    await waitFor(client, 'window.__pwaInstallPromptObserved === true', 15_000)

    await client.send('Network.enable')
    await client.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    })
    await client.send('Page.navigate', { url: `http://127.0.0.1:${previewPort}/offline-check` })
    await delay(500)
    await waitFor(client, "document.readyState === 'complete'")
    const offlineState = await client.evaluate(`({
      title: document.title,
      hasAppRoot: Boolean(document.querySelector('#root')?.firstElementChild),
      controlled: Boolean(navigator.serviceWorker.controller),
    })`)
    assert.equal(offlineState.title, 'Vivek Marco Trader')
    assert.equal(offlineState.hasAppRoot, true)
    assert.equal(offlineState.controlled, true)
  } finally {
    client?.close()
    preview.kill()
    browser.kill()
    await delay(400)
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
})
