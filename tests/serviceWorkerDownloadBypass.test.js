import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  ANDROID_APK_AVAILABILITY_TTL_MS,
  checkAndroidApkAvailability,
} from '../src/components/pwaInstallSelection.js'
import {
  APK_DOWNLOAD_UI_ACTIONS,
  androidApkAvailabilityRequiresRevalidation,
  androidApkDownloadReducer,
  createAndroidApkDownloadState,
} from '../src/components/useAndroidApkDownload.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const origin = 'https://app.invalid'
const apkPath = '/downloads/vivek-marco-trader.apk'
const descriptorPath = `${apkPath}.json`
const zipPrefix = Uint8Array.from([0x50, 0x4b, 0x03, 0x04])

function targetLabel(target) {
  if (typeof target === 'string') return target
  return target?.url ?? String(target)
}

function createWorkerHarness(source, options = {}) {
  const listeners = new Map()
  const metrics = {
    addAll: [],
    cacheDeletes: [],
    cacheMatches: [],
    cacheOpens: [],
    cachePuts: [],
    claims: 0,
    clientNavigations: [],
    fetches: [],
    respondWith: 0,
    skipWaiting: 0,
  }
  const shell = new Response('<!doctype html><script src="/assets/app.js"></script>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
  const cachedStatic = new Response('cached-static', { status: 200 })

  const cacheFor = cacheName => ({
    async addAll(urls) { metrics.addAll.push({ cacheName, urls: [...urls] }) },
    async match(target) {
      metrics.cacheMatches.push({ cacheName, target: targetLabel(target) })
      if (cacheName.endsWith('-static') && options.staticCacheHit) return cachedStatic.clone()
      if (targetLabel(target) === '/index.html') return shell.clone()
      return undefined
    },
    async put(target) { metrics.cachePuts.push({ cacheName, target: targetLabel(target) }) },
  })

  const clients = (options.clientUrls ?? [`${origin}/history`]).map(url => ({
    url,
    async navigate(nextUrl) { metrics.clientNavigations.push(nextUrl) },
  }))
  const self = {
    location: { origin },
    clients: {
      async claim() { metrics.claims += 1 },
      async matchAll() { return clients },
    },
    addEventListener(type, listener) { listeners.set(type, listener) },
    async skipWaiting() { metrics.skipWaiting += 1 },
  }

  vm.runInNewContext(source, {
    Headers,
    Response,
    URL,
    caches: {
      async delete(cacheName) { metrics.cacheDeletes.push(cacheName); return true },
      async keys() { return options.cacheKeys ?? [] },
      async open(cacheName) { metrics.cacheOpens.push(cacheName); return cacheFor(cacheName) },
    },
    fetch: async (request, fetchOptions) => {
      metrics.fetches.push({ request: targetLabel(request), options: fetchOptions })
      if (options.network) return options.network(request, fetchOptions)
      throw new TypeError('synthetic offline')
    },
    self,
  }, { filename: 'sw.js' })

  return { listeners, metrics }
}

async function dispatchFetch(harness, { pathname, mode = 'cors', method = 'GET' }) {
  let responsePromise
  harness.listeners.get('fetch')({
    request: {
      method,
      mode,
      url: `${origin}${pathname}`,
      headers: new Headers(),
    },
    respondWith(value) {
      harness.metrics.respondWith += 1
      responsePromise = Promise.resolve(value)
    },
  })
  return responsePromise ? responsePromise : undefined
}

async function dispatchLifecycle(listener) {
  let completion
  listener({ waitUntil(value) { completion = Promise.resolve(value) } })
  await completion
}

function responseFixture(url, status, headers, bytes) {
  const body = Uint8Array.from(bytes)
  return {
    status,
    redirected: false,
    url,
    headers: new Headers(headers),
    async arrayBuffer() { return body.slice().buffer },
  }
}

function netlifyHeaderValues(source, route) {
  return source.split('[[headers]]').slice(1).map(block => {
    const blockRoute = block.match(/^\s*for\s*=\s*"([^"]+)"/m)?.[1]
    const values = Object.fromEntries([...block.matchAll(/^\s{4}([\w-]+)\s*=\s*"((?:\\.|[^"\\])*)"/gm)]
      .map(match => [match[1].toLowerCase(), match[2].replace(/\\"/g, '"')]))
    return { route: blockRoute, values }
  }).find(block => block.route === route)?.values
}

test('source and built workers have byte parity and bypass every generated download request', async () => {
  // **Validates: Requirements 2.4, 2.5, 3.2, 3.3, 3.7**
  const [publicWorker, builtWorker] = await Promise.all([
    readFile(path.join(root, 'public', 'sw.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'sw.js'), 'utf8'),
  ])
  assert.equal(builtWorker, publicWorker, 'Vite must copy the reviewed worker without changing bypass behavior')

  const cases = [
    { pathname: apkPath },
    { pathname: `${apkPath}?v=${'a'.repeat(64)}` },
    { pathname: descriptorPath },
    { pathname: `${descriptorPath}?revalidate=task-3-7` },
    { pathname: '/downloads/Vivek-Marco-Trader.apk', mode: 'navigate' },
    { pathname: '/downloads/intentionally-missing.apk?cache=stale', mode: 'navigate' },
  ]

  for (const [workerName, source] of [['public', publicWorker], ['built', builtWorker]]) {
    for (const fixture of cases) {
      const harness = createWorkerHarness(source, { staticCacheHit: true })
      const response = await dispatchFetch(harness, fixture)
      assert.equal(response, undefined, `${workerName} ${fixture.pathname} must not receive a worker response`)
      assert.deepEqual(harness.metrics, {
        addAll: [],
        cacheDeletes: [],
        cacheMatches: [],
        cacheOpens: [],
        cachePuts: [],
        claims: 0,
        clientNavigations: [],
        fetches: [],
        respondWith: 0,
        skipWaiting: 0,
      }, `${workerName} ${fixture.pathname} must bypass fetch, caches, and cached HTML`)
    }
  }
})

test('worker install, activate, navigation, and static cache behavior remain intact', async () => {
  // **Validates: Requirements 3.2, 3.3**
  const source = await readFile(path.join(root, 'public', 'sw.js'), 'utf8')
  const lifecycle = createWorkerHarness(source, {
    cacheKeys: ['vmt-pwa-v1-app-shell', 'vmt-pwa-v2-app-shell', 'vmt-pwa-v2-static', 'unrelated-cache'],
  })
  await dispatchLifecycle(lifecycle.listeners.get('install'))
  assert.equal(lifecycle.metrics.skipWaiting, 1)
  assert.deepEqual(lifecycle.metrics.addAll[0], {
    cacheName: 'vmt-pwa-v2-app-shell',
    urls: ['/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'],
  })
  assert.deepEqual(lifecycle.metrics.addAll[1], {
    cacheName: 'vmt-pwa-v2-static',
    urls: ['/assets/app.js'],
  })
  assert.equal(lifecycle.metrics.addAll.flatMap(entry => entry.urls).some(url => url.startsWith('/downloads/')), false)

  await dispatchLifecycle(lifecycle.listeners.get('activate'))
  assert.deepEqual(lifecycle.metrics.cacheDeletes, ['vmt-pwa-v1-app-shell'])
  assert.equal(lifecycle.metrics.claims, 1)
  assert.deepEqual(lifecycle.metrics.clientNavigations, [`${origin}/history`])

  const offlineNavigation = createWorkerHarness(source)
  const navigationResponse = await dispatchFetch(offlineNavigation, { pathname: '/offline-check', mode: 'navigate' })
  assert.equal(offlineNavigation.metrics.respondWith, 1)
  assert.equal(offlineNavigation.metrics.fetches.length, 1)
  assert.equal(offlineNavigation.metrics.fetches[0].options.cache, 'no-store')
  assert.equal((await navigationResponse).headers.get('content-type'), 'text/html')
  assert.ok(offlineNavigation.metrics.cacheMatches.some(entry => entry.target === '/index.html'))

  const staticAsset = createWorkerHarness(source, {
    staticCacheHit: true,
    network: async () => ({
      ok: true,
      type: 'basic',
      headers: new Headers({ 'cache-control': 'public, max-age=60' }),
      clone() { return this },
    }),
  })
  const staticResponse = await dispatchFetch(staticAsset, { pathname: '/icons/icon-192.png' })
  assert.equal(await (await staticResponse).text(), 'cached-static')
  await Promise.resolve()
  assert.equal(staticAsset.metrics.respondWith, 1)
  assert.equal(staticAsset.metrics.fetches.length, 1)
  assert.equal(staticAsset.metrics.cacheMatches.length, 1)
  assert.equal(staticAsset.metrics.cachePuts.length, 1)
})

test('registration preserves update semantics and reloads once after controlled updates', async () => {
  // **Validates: Requirements 3.3**
  const source = (await readFile(path.join(root, 'src', 'registerServiceWorker.js'), 'utf8'))
    .replace('export function registerServiceWorker()', 'function registerServiceWorker()')
    .replace('import.meta.env.PROD', 'true')
    .concat('\nglobalThis.__registerServiceWorker = registerServiceWorker\n')
  const windowListeners = new Map()
  const workerListeners = new Map()
  const registrations = []
  let reloads = 0
  let updates = 0
  const context = {
    console: { error() {} },
    navigator: {
      serviceWorker: {
        controller: {},
        addEventListener(type, listener) { workerListeners.set(type, listener) },
        async register(url, options) {
          registrations.push({ url, options })
          return { async update() { updates += 1 } }
        },
      },
    },
    window: {
      location: { reload() { reloads += 1 } },
      addEventListener(type, listener) { windowListeners.set(type, listener) },
    },
  }
  vm.runInNewContext(source, context, { filename: 'registerServiceWorker.js' })
  context.__registerServiceWorker()
  assert.equal(registrations.length, 0, 'registration remains deferred until window load')
  windowListeners.get('load')()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].url, '/sw.js')
  assert.equal(registrations[0].options.scope, '/')
  assert.equal(registrations[0].options.updateViaCache, 'none')
  assert.equal(updates, 1)

  workerListeners.get('controllerchange')()
  workerListeners.get('controllerchange')()
  assert.equal(reloads, 1, 'an existing controlled page reloads at most once for the new worker')
})

test('browser preflight, host headers, TTL, and visibility staleness form one no-store cache contract', async () => {
  // **Validates: Requirements 2.5, 3.1, 3.7**
  const [descriptorSource, netlifySource] = await Promise.all([
    readFile(path.join(root, 'public', 'downloads', 'vivek-marco-trader.apk.json'), 'utf8'),
    readFile(path.join(root, 'netlify.toml'), 'utf8'),
  ])
  const descriptor = JSON.parse(descriptorSource)
  const calls = []
  const fetchFixture = async (url, options) => {
    calls.push({ url, options })
    const range = options.headers?.Range
    if (!range) {
      return responseFixture(url, 200, { 'content-type': 'application/json' }, Buffer.from(descriptorSource))
    }
    const sharedHeaders = {
      'content-disposition': `attachment; filename="${descriptor.filename}"`,
      'content-type': descriptor.mediaType,
    }
    if (range === 'bytes=0-3') {
      return responseFixture(url, 206, {
        ...sharedHeaders,
        'content-length': '4',
        'content-range': `bytes 0-3/${descriptor.byteSize}`,
      }, zipPrefix)
    }
    const finalOffset = descriptor.byteSize - 1
    return responseFixture(url, 206, {
      ...sharedHeaders,
      'content-length': '1',
      'content-range': `bytes ${finalOffset}-${finalOffset}/${descriptor.byteSize}`,
    }, [0])
  }

  const checkedAt = 10_000
  const result = await checkAndroidApkAvailability({
    fetch: fetchFixture,
    location: { origin },
    nonce: 'task-3-7',
    now: () => checkedAt,
  })
  assert.equal(result.status, 'available')
  assert.equal(result.expiresAt, checkedAt + ANDROID_APK_AVAILABILITY_TTL_MS)
  assert.equal(new URL(calls[0].url).pathname, descriptorPath)
  assert.equal(new URL(calls[0].url).searchParams.get('revalidate'), 'task-3-7')
  for (const call of calls) {
    assert.equal(call.options.cache, 'no-store')
    assert.equal(call.options.credentials, 'omit')
    assert.equal(call.options.redirect, 'error')
  }
  for (const call of calls.slice(1)) {
    const url = new URL(call.url)
    assert.equal(url.pathname, apkPath)
    assert.equal(url.searchParams.get('v'), descriptor.sha256)
  }

  for (const route of [apkPath, descriptorPath]) {
    const headers = netlifyHeaderValues(netlifySource, route)
    assert.ok(headers, `${route} must have exact host headers`)
    assert.match(headers['cache-control'] || '', /(?:^|,)\s*no-store\b/i)
    assert.equal(headers['x-content-type-options'], 'nosniff')
  }

  const available = androidApkDownloadReducer(createAndroidApkDownloadState(), {
    type: APK_DOWNLOAD_UI_ACTIONS.CHECK_SETTLED,
    result,
  })
  assert.equal(androidApkAvailabilityRequiresRevalidation(available, result.expiresAt - 1), false)
  assert.equal(androidApkAvailabilityRequiresRevalidation(available, result.expiresAt), true)
  const visibilityStale = androidApkDownloadReducer(available, { type: APK_DOWNLOAD_UI_ACTIONS.MARK_STALE })
  assert.equal(androidApkAvailabilityRequiresRevalidation(visibilityStale, checkedAt), true)

  let seed = 0x337cace
  for (let index = 0; index < 64; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const age = seed % (ANDROID_APK_AVAILABILITY_TTL_MS * 2)
    const now = checkedAt + age
    assert.equal(
      androidApkAvailabilityRequiresRevalidation(available, now),
      now >= result.expiresAt,
      `generated cache age ${age}`,
    )
    assert.equal(androidApkAvailabilityRequiresRevalidation({ ...available, stale: true }, now), true)
  }
})
