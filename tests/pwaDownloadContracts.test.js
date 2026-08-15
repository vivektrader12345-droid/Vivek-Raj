import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APK_PATH = '/downloads/vivek-marco-trader.apk'
const APK_FILENAME = 'vivek-marco-trader.apk'

function decodeTomlString(value) {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function parseTomlBlocks(source, marker) {
  return source.split(marker).slice(1).map(block => {
    const values = Object.create(null)
    for (const match of block.matchAll(/^\s*([A-Za-z][\w-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|(\d+))\s*$/gm)) {
      values[match[1]] = match[2] === undefined ? Number(match[3]) : decodeTomlString(match[2])
    }
    return values
  })
}

function redirectProtects(pathname, rule) {
  if (!(Number(rule.status) >= 400 && Number(rule.status) < 600)) return false
  if (rule.from === pathname || rule.from === '/downloads/*') return true
  return rule.from?.endsWith('*') && pathname.startsWith(rule.from.slice(0, -1))
}

function redirectsFileRules(source) {
  return source.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [from, to, rawStatus] = line.split(/\s+/)
      return { from, to, status: Number(rawStatus) }
    })
}

function headerBlockFor(source, pathname) {
  return source.split('[[headers]]').slice(1).map(block => {
    const route = block.match(/^\s*for\s*=\s*"([^"]+)"/m)?.[1]
    const values = Object.fromEntries([...block.matchAll(/^\s{4}([\w-]+)\s*=\s*"((?:\\.|[^"\\])*)"/gm)]
      .map(match => [match[1].toLowerCase(), decodeTomlString(match[2])]))
    return { route, values }
  }).find(block => block.route === pathname)
}

async function dispatchOfflineNavigation(swSource, pathname) {
  const listeners = new Map()
  let networkCalls = 0
  let cacheMatches = 0
  let responsePromise
  const cachedHtml = new Response('<!doctype html><title>cached app shell</title>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
  const cache = {
    addAll: async () => undefined,
    put: async () => undefined,
    match: async () => { cacheMatches += 1; return cachedHtml.clone() },
  }
  const self = {
    location: { origin: 'https://local.test' },
    clients: { claim: async () => undefined },
    addEventListener(type, listener) { listeners.set(type, listener) },
  }
  vm.runInNewContext(swSource, {
    self,
    URL,
    Response,
    Headers,
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => { networkCalls += 1; throw new TypeError('synthetic offline') },
  }, { filename: 'sw.js' })

  let respondWithCalls = 0
  listeners.get('fetch')({
    request: {
      method: 'GET',
      mode: 'navigate',
      url: `https://local.test${pathname}`,
      headers: new Headers(),
    },
    respondWith(value) {
      respondWithCalls += 1
      responsePromise = Promise.resolve(value)
    },
  })
  const response = responsePromise ? await responsePromise : undefined
  return {
    respondWithCalls,
    networkCalls,
    cacheMatches,
    responseContentType: response?.headers.get('content-type') || null,
  }
}

test('public and built releases contain the exact same APK bytes', async () => {
  const [publicApk, builtApk] = await Promise.all([
    readFile(path.join(root, 'public', 'downloads', APK_FILENAME)),
    readFile(path.join(root, 'dist', 'downloads', APK_FILENAME)),
  ])

  assert.ok(publicApk.length > 4, 'APK must contain more than the ZIP signature')
  assert.deepEqual([...publicApk.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  assert.equal(builtApk.length, publicApk.length)
  assert.equal(createHash('sha256').update(builtApk).digest('hex'), createHash('sha256').update(publicApk).digest('hex'))
})

test('host rules define exact no-store APK attachment headers and protect downloads before SPA fallback', async () => {
  const [netlifyToml, redirectsSource] = await Promise.all([
    readFile(path.join(root, 'netlify.toml'), 'utf8'),
    readFile(path.join(root, 'public', '_redirects'), 'utf8'),
  ])

  const apkHeaders = headerBlockFor(netlifyToml, APK_PATH)?.values
  assert.ok(apkHeaders, 'netlify.toml must define an exact APK header block')
  assert.match(apkHeaders['content-type'] || '', /^(?:application\/vnd\.android\.package-archive|application\/octet-stream)$/i)
  assert.equal(apkHeaders['content-disposition'], 'attachment; filename="vivek-marco-trader.apk"')
  assert.match(apkHeaders['cache-control'] || '', /(?:^|,)\s*no-store\b/i)

  const netlifyRules = parseTomlBlocks(netlifyToml, '[[redirects]]')
  const netlifyCatchAll = netlifyRules.findIndex(rule => rule.from === '/*' && Number(rule.status) === 200)
  assert.ok(netlifyCatchAll >= 0, 'SPA catch-all must remain present')
  for (const pathname of [APK_PATH, '/downloads/intentionally-absent.apk']) {
    assert.ok(netlifyRules.slice(0, netlifyCatchAll).some(rule => redirectProtects(pathname, rule)), `${pathname} must be protected before the Netlify SPA fallback`)
  }

  const publicRules = redirectsFileRules(redirectsSource)
  const publicCatchAll = publicRules.findIndex(rule => rule.from === '/*' && rule.status === 200)
  assert.ok(publicCatchAll >= 0, 'public/_redirects SPA catch-all must remain present')
  for (const pathname of [APK_PATH, '/downloads/intentionally-absent.apk']) {
    assert.ok(publicRules.slice(0, publicCatchAll).some(rule => redirectProtects(pathname, rule)), `${pathname} must be protected before the public SPA fallback`)
  }
})

test('public and built service workers never intercept offline APK navigation', async () => {
  for (const swPath of [path.join(root, 'public', 'sw.js'), path.join(root, 'dist', 'sw.js')]) {
    const source = await readFile(swPath, 'utf8')
    const result = await dispatchOfflineNavigation(source, APK_PATH)
    assert.deepEqual(result, {
      respondWithCalls: 0,
      networkCalls: 0,
      cacheMatches: 0,
      responseContentType: null,
    }, `${path.relative(root, swPath)} must leave offline ${APK_PATH} to the network without cached index.html`)
  }
})
