import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const APK_PATH = '/downloads/vivek-marco-trader.apk'
const DESCRIPTOR_PATH = `${APK_PATH}.json`
const APK_CONTENT_TYPE = 'application/vnd.android.package-archive'
const APK_DISPOSITION = 'attachment; filename="vivek-marco-trader.apk"'

async function createBuiltSiteContractServer() {
  const [apk, descriptor, indexHtml] = await Promise.all([
    readFile(path.join(dist, 'downloads', 'vivek-marco-trader.apk')),
    readFile(path.join(dist, 'downloads', 'vivek-marco-trader.apk.json')),
    readFile(path.join(dist, 'index.html')),
  ])

  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://local.test').pathname

    if (pathname === APK_PATH) {
      const sharedHeaders = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Disposition': APK_DISPOSITION,
        'Content-Type': APK_CONTENT_TYPE,
        'X-Content-Type-Options': 'nosniff',
      }
      const range = request.headers.range
      if (range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range)
        const start = Number(match?.[1])
        const end = Number(match?.[2])
        if (!match || start < 0 || end < start || end >= apk.length) {
          response.writeHead(416, { ...sharedHeaders, 'Content-Range': `bytes */${apk.length}` })
          response.end()
          return
        }
        const body = apk.subarray(start, end + 1)
        response.writeHead(206, {
          ...sharedHeaders,
          'Content-Length': String(body.length),
          'Content-Range': `bytes ${start}-${end}/${apk.length}`,
        })
        response.end(body)
        return
      }

      response.writeHead(200, { ...sharedHeaders, 'Content-Length': String(apk.length) })
      response.end(apk)
      return
    }

    if (pathname === DESCRIPTOR_PATH) {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': String(descriptor.length),
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      })
      response.end(descriptor)
      return
    }

    if (pathname.startsWith('/downloads/')) {
      const body = Buffer.from('Release artifact not found\n')
      response.writeHead(404, {
        'Cache-Control': 'no-store',
        'Content-Length': String(body.length),
        'Content-Type': 'text/plain; charset=utf-8',
      })
      response.end(body)
      return
    }

    response.writeHead(200, {
      'Content-Length': String(indexHtml.length),
      'Content-Type': 'text/html; charset=utf-8',
    })
    response.end(indexHtml)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()

  return {
    apk,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    descriptor,
    indexHtml,
  }
}

test('Netlify-compatible built-site contract serves canonical files before download misses and preserves SPA routes', { timeout: 30_000 }, async t => {
  const fixture = await createBuiltSiteContractServer()
  t.after(fixture.close)
  const descriptorRecord = JSON.parse(fixture.descriptor.toString('utf8'))

  for (const query of ['', `?v=${descriptorRecord.sha256}`]) {
    const fullResponse = await fetch(`${fixture.baseUrl}${APK_PATH}${query}`, { redirect: 'manual' })
    assert.equal(fullResponse.status, 200)
    assert.equal(fullResponse.redirected, false)
    assert.equal(fullResponse.headers.get('content-type'), APK_CONTENT_TYPE)
    assert.equal(fullResponse.headers.get('content-disposition'), APK_DISPOSITION)
    assert.match(fullResponse.headers.get('cache-control') || '', /(?:^|,)\s*no-store\b/i)
    assert.equal(fullResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(fullResponse.headers.get('content-length'), String(fixture.apk.length))
    const fullBytes = Buffer.from(await fullResponse.arrayBuffer())
    assert.deepEqual(fullBytes, fixture.apk)
    assert.equal(createHash('sha256').update(fullBytes).digest('hex'), descriptorRecord.sha256)
  }

  const rangeResponse = await fetch(`${fixture.baseUrl}${APK_PATH}?v=${descriptorRecord.sha256}`, {
    headers: { Range: 'bytes=0-3' },
    redirect: 'manual',
  })
  assert.equal(rangeResponse.status, 206)
  assert.equal(rangeResponse.headers.get('content-range'), `bytes 0-3/${fixture.apk.length}`)
  assert.equal(rangeResponse.headers.get('content-length'), '4')
  assert.equal(rangeResponse.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual([...new Uint8Array(await rangeResponse.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04])

  for (const query of ['', '?revalidate=contract-test']) {
    const descriptorResponse = await fetch(`${fixture.baseUrl}${DESCRIPTOR_PATH}${query}`, { redirect: 'manual' })
    assert.equal(descriptorResponse.status, 200)
    assert.equal(descriptorResponse.redirected, false)
    assert.match(descriptorResponse.headers.get('content-type') || '', /^application\/json(?:\s*;|$)/i)
    assert.match(descriptorResponse.headers.get('cache-control') || '', /(?:^|,)\s*no-store\b/i)
    assert.equal(descriptorResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await descriptorResponse.arrayBuffer()), fixture.descriptor)
  }

  for (const missingPath of [
    '/downloads/intentionally-absent.apk',
    '/downloads/Vivek-Marco-Trader.apk',
    '/downloads/vivek-marco-trader.APK',
    '/downloads/Vivek-Marco-Trader.apk.json',
    `${DESCRIPTOR_PATH}.missing?revalidate=contract-test`,
  ]) {
    const missingResponse = await fetch(`${fixture.baseUrl}${missingPath}`, { redirect: 'manual' })
    assert.equal(missingResponse.status, 404, `${missingPath} must be handled by the download miss branch`)
    assert.equal(missingResponse.redirected, false)
    assert.doesNotMatch(missingResponse.headers.get('content-type') || '', /^text\/html\b/i)
    assert.doesNotMatch(await missingResponse.text(), /<!doctype\s+html/i)
  }

  for (const spaPath of ['/', '/login', '/pro-trading', '/settings']) {
    const spaResponse = await fetch(`${fixture.baseUrl}${spaPath}`, { redirect: 'manual' })
    assert.equal(spaResponse.status, 200, `${spaPath} must retain SPA fallback`)
    assert.equal(spaResponse.redirected, false)
    assert.match(spaResponse.headers.get('content-type') || '', /^text\/html\b/i)
    assert.deepEqual(Buffer.from(await spaResponse.arrayBuffer()), fixture.indexHtml)
  }
})
