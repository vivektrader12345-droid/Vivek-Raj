import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  ApkReleaseVerificationError,
  verifyApkReleaseOrigin,
} from '../scripts/verify-apk-release-origin.mjs'

const APK_PATH = '/downloads/vivek-marco-trader.apk'
const DESCRIPTOR_PATH = `${APK_PATH}.json`
const APK_MEDIA_TYPE = 'application/vnd.android.package-archive'
const APK_DISPOSITION = 'attachment; filename="vivek-marco-trader.apk"'
const APK_BYTES = Buffer.alloc(1024 * 1024, 0x41)
APK_BYTES.set([0x50, 0x4b, 0x03, 0x04], 0)
APK_BYTES[APK_BYTES.length - 1] = 0x5a

function createDescriptor(bytes = APK_BYTES) {
  return {
    schemaVersion: 2,
    path: APK_PATH,
    filename: 'vivek-marco-trader.apk',
    mediaType: APK_MEDIA_TYPE,
    applicationId: 'com.vivekmarco.trader',
    versionCode: 3,
    versionName: '1.0.2',
    sourceRevision: 'a'.repeat(40),
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signer: {
      classification: 'approved-release',
      certificateSha256: Array.from({ length: 32 }, () => 'AB').join(':'),
    },
  }
}

function send(response, status, headers, bytes = Buffer.alloc(0)) {
  response.writeHead(status, {
    'Content-Length': String(bytes.length),
    ...headers,
  })
  response.end(bytes)
}

async function createVerifierServer({ descriptor = createDescriptor(), fault } = {}) {
  const requests = []
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor))
  const iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const manifestBytes = Buffer.from(JSON.stringify({
    name: 'Verifier fixture',
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
  }))
  const spaBytes = Buffer.from('<!doctype html><html><body><div id="root"></div></body></html>')
  const workerBytes = Buffer.from(`
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname.startsWith('/downloads/')) return
  event.respondWith(fetch(event.request))
})
`)

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.local')
    requests.push({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      method: request.method,
      pathname: url.pathname,
      search: url.search,
    })

    if (url.pathname === DESCRIPTOR_PATH) {
      if (fault === 'authorization') {
        send(response, 403, { 'Content-Type': 'text/plain' }, Buffer.from('forbidden'))
        return
      }
      if (fault === 'descriptor-redirect') {
        response.writeHead(302, { Location: '/login' })
        response.end()
        return
      }
      send(response, 200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      }, descriptorBytes)
      return
    }

    if (url.pathname === APK_PATH) {
      const headers = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Disposition': APK_DISPOSITION,
        'Content-Type': APK_MEDIA_TYPE,
        'X-Content-Type-Options': 'nosniff',
      }
      const range = request.headers.range
      if (range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range)
        const start = Number(match?.[1])
        const end = Number(match?.[2])
        if (!match || end >= APK_BYTES.length || end < start) {
          send(response, 416, { ...headers, 'Content-Range': `bytes */${APK_BYTES.length}` })
          return
        }
        const bytes = APK_BYTES.subarray(start, end + 1)
        send(response, 206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${APK_BYTES.length}`,
        }, bytes)
        return
      }

      const bytes = fault === 'digest-mismatch'
        ? Buffer.concat([APK_BYTES.subarray(0, APK_BYTES.length - 1), Buffer.from([0x00])])
        : APK_BYTES
      send(response, 200, headers, bytes)
      return
    }

    if (url.pathname.startsWith('/downloads/')) {
      const bytes = fault === 'download-miss-html'
        ? spaBytes
        : Buffer.from('Release artifact not found\n')
      send(response, 404, {
        'Cache-Control': 'no-store',
        'Content-Type': fault === 'download-miss-html' ? 'text/html' : 'text/plain; charset=utf-8',
      }, bytes)
      return
    }

    if (url.pathname === '/manifest.json') {
      send(response, 200, { 'Content-Type': 'application/manifest+json' }, manifestBytes)
      return
    }
    if (url.pathname === '/icons/icon-192.png') {
      send(response, 200, { 'Content-Type': 'image/png' }, iconBytes)
      return
    }
    if (url.pathname === '/sw.js') {
      send(response, 200, { 'Content-Type': 'application/javascript; charset=utf-8' }, workerBytes)
      return
    }
    if (url.pathname === '/login') {
      send(response, 200, { 'Content-Type': 'text/html; charset=utf-8' }, spaBytes)
      return
    }

    send(response, 404, { 'Content-Type': 'text/plain' }, Buffer.from('not found'))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    descriptor,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
  }
}

async function assertVerificationFailure(options, expected) {
  await assert.rejects(
    verifyApkReleaseOrigin(options),
    error => {
      assert.ok(error instanceof ApkReleaseVerificationError)
      assert.equal(error.code, expected.code)
      assert.equal(error.classification, expected.classification)
      return true
    },
  )
}

test('bounded preview verification proves descriptor, ranges, full digest, miss routes, SPA, and PWA without credentials', { timeout: 15_000 }, async t => {
  const fixture = await createVerifierServer()
  t.after(fixture.close)

  const result = await verifyApkReleaseOrigin({
    bodyTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    expectedDescriptor: fixture.descriptor,
    mode: 'preview',
    origin: fixture.origin,
  })

  assert.deepEqual(result, {
    status: 'verified',
    mode: 'preview',
    origin: fixture.origin,
    path: APK_PATH,
    sourceRevision: fixture.descriptor.sourceRevision,
    byteSize: fixture.descriptor.byteSize,
    sha256: fixture.descriptor.sha256,
  })
  assert.ok(fixture.requests.length >= 9)
  assert.ok(fixture.requests.every(request => request.method === 'GET'))
  assert.ok(fixture.requests.every(request => request.authorization === undefined))
  assert.ok(fixture.requests.every(request => request.cookie === undefined))
  assert.ok(fixture.requests.some(request => request.pathname === DESCRIPTOR_PATH && request.search.startsWith('?revalidate=')))
  assert.ok(fixture.requests.some(request => request.pathname === APK_PATH && request.search === `?v=${fixture.descriptor.sha256}`))
})

test('full APK digest mismatch is classified as a release regression', { timeout: 15_000 }, async t => {
  const fixture = await createVerifierServer({ fault: 'digest-mismatch' })
  t.after(fixture.close)
  await assertVerificationFailure({
    bodyTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    expectedDescriptor: fixture.descriptor,
    mode: 'preview',
    origin: fixture.origin,
  }, {
    code: 'APK_DIGEST_MISMATCH',
    classification: 'release-regression',
  })
})

test('descriptor authorization failure is classified as external verification failure', { timeout: 15_000 }, async t => {
  const fixture = await createVerifierServer({ fault: 'authorization' })
  t.after(fixture.close)
  await assertVerificationFailure({
    bodyTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    expectedDescriptor: fixture.descriptor,
    mode: 'preview',
    origin: fixture.origin,
  }, {
    code: 'DESCRIPTOR_AUTHORIZATION_UNAVAILABLE',
    classification: 'external-verification-failure',
  })
})

test('redirects and SPA HTML download misses fail closed', { timeout: 15_000 }, async t => {
  const redirectFixture = await createVerifierServer({ fault: 'descriptor-redirect' })
  t.after(redirectFixture.close)
  await assertVerificationFailure({
    bodyTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    expectedDescriptor: redirectFixture.descriptor,
    mode: 'preview',
    origin: redirectFixture.origin,
  }, {
    code: 'DESCRIPTOR_REDIRECT',
    classification: 'release-regression',
  })

  const htmlFixture = await createVerifierServer({ fault: 'download-miss-html' })
  t.after(htmlFixture.close)
  await assertVerificationFailure({
    bodyTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    expectedDescriptor: htmlFixture.descriptor,
    mode: 'preview',
    origin: htmlFixture.origin,
  }, {
    code: 'DOWNLOAD_MISS_HTML_REJECTED',
    classification: 'release-regression',
  })
})

test('production verification rejects non-HTTPS origins before making a request', async () => {
  let requested = false
  await assertVerificationFailure({
    bodyTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    expectedDescriptor: createDescriptor(),
    fetchImpl: async () => {
      requested = true
      throw new Error('must not run')
    },
    mode: 'production',
    origin: 'http://127.0.0.1:4173',
  }, {
    code: 'PRODUCTION_HTTPS_REQUIRED',
    classification: 'release-regression',
  })
  assert.equal(requested, false)
})
