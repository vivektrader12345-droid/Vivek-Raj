import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  APK_DESCRIPTOR_PATH,
  validateApkDescriptor,
} from '../src/components/apkDescriptorContract.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APK_PATH = '/downloads/vivek-marco-trader.apk'
const DESCRIPTOR_PATH = APK_DESCRIPTOR_PATH
const APK_FILENAME = 'vivek-marco-trader.apk'

function decodeTomlString(value) {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function parseTomlBlocks(source, marker) {
  return source.split(marker).slice(1).map(block => {
    const values = Object.create(null)
    for (const match of block.matchAll(/^\s*([A-Za-z][\w-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|(\d+)|(true|false))\s*$/gm)) {
      values[match[1]] = match[2] !== undefined
        ? decodeTomlString(match[2])
        : match[3] !== undefined
          ? Number(match[3])
          : match[4] === 'true'
    }
    return values
  })
}

function redirectsFileRules(source) {
  return source.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [from, to, statusToken] = line.split(/\s+/)
      return {
        force: statusToken.endsWith('!'),
        from,
        status: Number(statusToken.replace(/!$/, '')),
        to,
      }
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

test('public and built releases contain exact APK bytes and matching generated descriptors', async () => {
  const [publicApk, builtApk, publicDescriptorSource, builtDescriptorSource] = await Promise.all([
    readFile(path.join(root, 'public', 'downloads', APK_FILENAME)),
    readFile(path.join(root, 'dist', 'downloads', APK_FILENAME)),
    readFile(path.join(root, 'public', 'downloads', `${APK_FILENAME}.json`), 'utf8'),
    readFile(path.join(root, 'dist', 'downloads', `${APK_FILENAME}.json`), 'utf8'),
  ])

  assert.ok(publicApk.length > 4, 'APK must contain more than the ZIP signature')
  assert.deepEqual([...publicApk.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  assert.equal(builtApk.length, publicApk.length)

  const digest = createHash('sha256').update(publicApk).digest('hex')
  assert.equal(createHash('sha256').update(builtApk).digest('hex'), digest)
  assert.equal(builtDescriptorSource, publicDescriptorSource)

  const descriptor = validateApkDescriptor(JSON.parse(publicDescriptorSource))
  assert.equal(descriptor.path, APK_PATH)
  assert.equal(descriptor.filename, APK_FILENAME)
  assert.equal(descriptor.byteSize, publicApk.length)
  assert.equal(descriptor.sha256, digest)
})

test('host rules derive exact release headers while non-forced download misses precede SPA fallback', async () => {
  const [netlifyToml, redirectsSource, descriptorSource] = await Promise.all([
    readFile(path.join(root, 'netlify.toml'), 'utf8'),
    readFile(path.join(root, 'public', '_redirects'), 'utf8'),
    readFile(path.join(root, 'public', 'downloads', `${APK_FILENAME}.json`), 'utf8'),
  ])
  const descriptor = validateApkDescriptor(JSON.parse(descriptorSource))
  const apkPath = descriptor.path
  const descriptorPath = APK_DESCRIPTOR_PATH

  const apkHeaders = headerBlockFor(netlifyToml, apkPath)?.values
  assert.ok(apkHeaders, 'netlify.toml must define an exact APK header block')
  assert.equal(apkHeaders['content-type'], descriptor.mediaType)
  assert.equal(apkHeaders['content-disposition'], `attachment; filename="${descriptor.filename}"`)
  assert.match(apkHeaders['cache-control'] || '', /(?:^|,)\s*no-store\b/i)
  assert.equal(apkHeaders['x-content-type-options'], 'nosniff')

  const descriptorHeaders = headerBlockFor(netlifyToml, descriptorPath)?.values
  assert.ok(descriptorHeaders, 'netlify.toml must define an exact descriptor header block')
  assert.match(descriptorHeaders['content-type'] || '', /^application\/json(?:\s*;|$)/i)
  assert.match(descriptorHeaders['cache-control'] || '', /(?:^|,)\s*no-store\b/i)
  assert.equal(descriptorHeaders['x-content-type-options'], 'nosniff')

  const netlifyRules = parseTomlBlocks(netlifyToml, '[[redirects]]')
  const netlifyCatchAll = netlifyRules.findIndex(rule => rule.from === '/*' && rule.to === '/index.html' && rule.status === 200)
  assert.ok(netlifyCatchAll >= 0, 'SPA catch-all must remain present')
  assert.equal(netlifyRules.some(rule => rule.from === apkPath || rule.from === descriptorPath), false, 'canonical static files must not have exact redirect rules')
  const netlifyDownloadRuleIndex = netlifyRules.findIndex(rule => rule.from === '/downloads/*')
  assert.ok(netlifyDownloadRuleIndex >= 0 && netlifyDownloadRuleIndex < netlifyCatchAll, 'download miss rule must precede SPA fallback')
  assert.deepEqual({ ...netlifyRules[netlifyDownloadRuleIndex] }, {
    force: false,
    from: '/downloads/*',
    status: 404,
    to: '/404.html',
  })

  const publicRules = redirectsFileRules(redirectsSource)
  const publicCatchAll = publicRules.findIndex(rule => rule.from === '/*' && rule.to === '/index.html' && rule.status === 200)
  assert.ok(publicCatchAll >= 0, 'public/_redirects SPA catch-all must remain present')
  assert.equal(publicRules.some(rule => rule.from === apkPath || rule.from === descriptorPath), false, 'public canonical static files must not have exact redirect rules')
  const publicDownloadRuleIndex = publicRules.findIndex(rule => rule.from === '/downloads/*')
  assert.ok(publicDownloadRuleIndex >= 0 && publicDownloadRuleIndex < publicCatchAll, 'public download miss rule must precede SPA fallback')
  assert.deepEqual(publicRules[publicDownloadRuleIndex], {
    force: false,
    from: '/downloads/*',
    status: 404,
    to: '/404.html',
  })

  assert.deepEqual(
    publicRules.map(({ force, from, status, to }) => ({ force, from, status, to })),
    netlifyRules.map(({ force = false, from, status, to }) => ({ force, from, status, to })),
    'netlify.toml and public/_redirects redirect behavior must remain equivalent',
  )
})

test('public and built service workers never intercept offline release navigation', async () => {
  for (const swPath of [path.join(root, 'public', 'sw.js'), path.join(root, 'dist', 'sw.js')]) {
    const source = await readFile(swPath, 'utf8')
    for (const pathname of [APK_PATH, DESCRIPTOR_PATH]) {
      const result = await dispatchOfflineNavigation(source, pathname)
      assert.deepEqual(result, {
        respondWithCalls: 0,
        networkCalls: 0,
        cacheMatches: 0,
        responseContentType: null,
      }, `${path.relative(root, swPath)} must leave offline ${pathname} to the network without cached index.html`)
    }
  }
})
