import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  delay,
  startBrowserHarness,
  stopBrowserHarness,
  summarizeEvents,
  waitForPage,
} from './tradeHistoryBrowserHarness.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const distDirectory = path.join(repositoryRoot, 'dist')

async function startSpaServer() {
  const indexHtml = await readFile(path.join(distDirectory, 'index.html'))
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://built-artifact.test').pathname
      const requestedPath = pathname === '/' || pathname === '/history'
        ? path.join(distDirectory, 'index.html')
        : path.join(distDirectory, pathname.replace(/^\/+/, ''))
      const body = requestedPath === path.join(distDirectory, 'index.html')
        ? indexHtml
        : await readFile(requestedPath)
      response.writeHead(200, {
        'content-type': requestedPath.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8',
      })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end('Not found')
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    indexHtml,
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

test('route boundary recovers on navigation and direct-loaded history handles heterogeneous trades', { timeout: 120_000 }, async () => {
  const harness = await startBrowserHarness('route-artifact')
  try {
    harness.client.events.length = 0
    const directUrl = `http://127.0.0.1:${harness.vitePort}/history?case=primary`
    await harness.client.send('Page.navigate', { url: directUrl })
    await waitForPage(harness.client, `Boolean(window.__tradeHistoryFixture?.ready && location.pathname === '/history' && document.body.innerText.includes('Trade History'))`)
    await delay(100)

    const directLoad = await harness.client.evaluate('window.__tradeHistoryFixture.routeSnapshot()')
    assert.equal(directLoad.path, '/history')
    assert.equal(directLoad.applicationShellVisible, true)
    assert.equal(directLoad.tradeHistoryVisible, true)
    assert.equal(directLoad.allInputTradeIdentitiesRepresented, true)
    assert.equal(directLoad.invalidFieldsUseStableFallbacks, true)
    assert.equal(directLoad.errorBoundaryActivated, false)
    assert.deepEqual(summarizeEvents(harness.client.events), [], 'Direct-loaded heterogeneous history emitted browser errors')

    harness.client.events.length = 0
    await harness.client.evaluate(`window.__tradeHistoryFixture.navigate('/boundary-probe')`)
    await waitForPage(harness.client, `document.body.innerText.includes('Something went wrong')`)
    await delay(100)

    const boundary = await harness.client.evaluate('window.__tradeHistoryFixture.boundarySnapshot()')
    const diagnostics = summarizeEvents(harness.client.events)
    assert.deepEqual(boundary, {
      path: '/boundary-probe',
      headingVisible: true,
      messageVisible: true,
      controls: ['Reload App', 'Try Again'],
    })
    assert.equal(diagnostics.some(event => event.text.includes('React Error Boundary caught:')), true)
    assert.equal(diagnostics.some(event => event.text.includes('Synthetic unrelated child render failure')), true)

    await harness.client.evaluate(`window.__tradeHistoryFixture.navigate('/history')`)
    await waitForPage(harness.client, `location.pathname === '/history' && document.body.innerText.includes('Trade History')`)
    const recovered = await harness.client.evaluate('window.__tradeHistoryFixture.routeSnapshot()')
    assert.equal(recovered.applicationShellVisible, true)
    assert.equal(recovered.tradeHistoryVisible, true)
    assert.equal(recovered.errorBoundaryActivated, false)
  } finally {
    await stopBrowserHarness(harness)
  }
})

test('built artifact preserves the history SPA entry and diagnostic boundary markers', { timeout: 30_000 }, async () => {
  const [netlifyConfig, publicRedirects, indexHtmlText] = await Promise.all([
    readFile(path.join(repositoryRoot, 'netlify.toml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'public', '_redirects'), 'utf8'),
    readFile(path.join(distDirectory, 'index.html'), 'utf8'),
  ])

  assert.match(netlifyConfig, /from\s*=\s*"\/\*"[\s\S]*to\s*=\s*"\/index\.html"[\s\S]*status\s*=\s*200/)
  assert.match(publicRedirects, /^\/\*\s+\/index\.html\s+200\s*$/m)

  const assetMatch = indexHtmlText.match(/<script[^>]+src="(\/assets\/index-[^"]+\.js)"/)
  assert.ok(assetMatch, 'Could not identify the built application asset from dist/index.html')
  const productionAssetIdentifier = assetMatch[1]
  const bundle = await readFile(path.join(distDirectory, productionAssetIdentifier.replace(/^\//, '')), 'utf8')

  for (const marker of [
    'Trade History',
    'Unknown',
    'Something went wrong',
    'React Error Boundary caught:',
    'Reload App',
    'Try Again',
  ]) {
    assert.equal(bundle.includes(marker), true, `Built asset omitted required marker: ${marker}`)
  }

  const spaServer = await startSpaServer()
  try {
    const [rootResponse, historyResponse, assetResponse] = await Promise.all([
      fetch(`${spaServer.origin}/`),
      fetch(`${spaServer.origin}/history`),
      fetch(`${spaServer.origin}${productionAssetIdentifier}`),
    ])
    assert.equal(rootResponse.status, 200)
    assert.equal(historyResponse.status, 200)
    assert.equal(assetResponse.status, 200)
    assert.equal(await historyResponse.text(), await rootResponse.text(), 'The /history deep link did not receive the SPA entry document')
    assert.equal(await assetResponse.text(), bundle, 'The built application asset was not runnable from its emitted URL')
  } finally {
    await spaServer.stop()
  }

  const report = {
    productionAssetIdentifier,
    postDeploymentAssetUrl: `https://vijaycontractor.space${productionAssetIdentifier}`,
    checks: {
      netlifySpaRewrite: true,
      publicRedirectFallback: true,
      directHistoryResponse: 200,
      fixedHistoryMarkersPresent: true,
      visibleBoundaryMarkersPresent: true,
    },
  }
  const artifactDirectory = path.join(testDirectory, 'artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(path.join(artifactDirectory, 'route-artifact-report.json'), `${JSON.stringify(report, null, 2)}\n`)
})
