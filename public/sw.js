const CACHE_VERSION = 'vmt-pwa-v2'
const APP_SHELL_CACHE = `${CACHE_VERSION}-app-shell`
const STATIC_CACHE = `${CACHE_VERSION}-static`
const APP_SHELL = [
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

function isPublicStaticAsset(url) {
  return url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json'
}

async function precacheAppShell() {
  const appShellCache = await caches.open(APP_SHELL_CACHE)
  await appShellCache.addAll(APP_SHELL)

  const indexResponse = await appShellCache.match('/index.html')
  const html = await indexResponse.text()
  const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => new URL(match[1], self.location.origin))
    .filter(url => url.origin === self.location.origin && url.pathname.startsWith('/assets/'))
    .map(url => `${url.pathname}${url.search}`)

  if (assetUrls.length) {
    const staticCache = await caches.open(STATIC_CACHE)
    await staticCache.addAll([...new Set(assetUrls)])
  }
}

self.addEventListener('install', event => {
  event.waitUntil(precacheAppShell().then(() => self.skipWaiting()))
})

async function activateWorker() {
  const keys = await caches.keys()
  const obsoleteKeys = keys.filter(
    key => key.startsWith('vmt-pwa-') && key !== APP_SHELL_CACHE && key !== STATIC_CACHE,
  )
  await Promise.all(obsoleteKeys.map(key => caches.delete(key)))
  await self.clients.claim()

  if (obsoleteKeys.length) {
    const windowClients = await self.clients.matchAll({ type: 'window' })
    await Promise.all(windowClients.map(client => client.navigate(client.url).catch(() => undefined)))
  }
}

self.addEventListener('activate', event => {
  event.waitUntil(activateWorker())
})

function isSensitiveRequest(request, url) {
  if (request.headers.has('authorization')) return true
  return url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/.netlify/functions/') ||
    url.pathname.startsWith('/webhook')
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(APP_SHELL_CACHE)
  try {
    const response = await fetch(request, { cache: 'no-store' })
    if (response.ok && response.type === 'basic') await cache.put('/index.html', response.clone())
    return response
  } catch {
    return (await cache.match('/index.html')) || Response.error()
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE)
  const cached = await cache.match(request)
  const network = fetch(request).then(response => {
    const cacheControl = response.headers.get('cache-control') || ''
    const explicitlyPrivate = /(?:^|,)\s*(?:no-store|private)\b/i.test(cacheControl)
    if (response.ok && response.type === 'basic' && !explicitlyPrivate) {
      cache.put(request, response.clone())
    }
    return response
  })

  if (cached) {
    network.catch(() => undefined)
    return cached
  }

  return network
}

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin || isSensitiveRequest(request, url)) return
  if (url.pathname.startsWith('/downloads/')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  if (isPublicStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request))
  }
})
