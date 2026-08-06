import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'

import '../chrome-extension/extension-core.js'

const core = globalThis.VMTExtensionCore

function token(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${encoded}.signature`
}

test('Firebase requests refresh once on 401 and replay with the refreshed identity', async () => {
  const contexts = []
  let refreshes = 0
  const response = await core.requestWithSingleAuthRefresh({
    getAuthContext: async () => ({ token: 'old', userId: 'user-1' }),
    refreshAuthContext: async context => {
      refreshes += 1
      assert.equal(context.userId, 'user-1')
      return { token: 'new', userId: 'user-1' }
    },
    request: async context => {
      contexts.push(context)
      return { status: context.token === 'old' ? 401 : 200 }
    },
  })

  assert.equal(response.status, 200)
  assert.equal(refreshes, 1)
  assert.deepEqual(contexts.map(context => context.token), ['old', 'new'])
})

test('token expiry uses a safety window and malformed tokens fail closed', () => {
  const now = Date.now()
  assert.equal(core.tokenNeedsRefresh(token({ exp: Math.floor((now + 30_000) / 1000) }), now), true)
  assert.equal(core.tokenNeedsRefresh(token({ exp: Math.floor((now + 120_000) / 1000) }), now), false)
  assert.throws(() => core.tokenNeedsRefresh('not-a-jwt', now), /Invalid Firebase Auth token/)
})

test('durable outbox keys retries by owner and trade identity', () => {
  const existing = [{
    userId: 'user-1',
    trade: { tradeId: 'trade-1', pnl: 1 },
    attempts: 2,
    nextAttemptAt: 999,
    queuedAt: 'earlier',
  }]
  const mergedForFirstUser = core.mergeOutbox(existing, [
    { tradeId: 'trade-1', pnl: 2 },
    { tradeId: 'trade-2', pnl: null },
  ], 'user-1', 123)
  const merged = core.mergeOutbox(
    mergedForFirstUser,
    [{ tradeId: 'trade-1', pnl: 99 }],
    'user-2',
    456,
  )

  assert.equal(merged.length, 3)
  assert.deepEqual(merged[0], {
    trade: { tradeId: 'trade-1', pnl: 2 },
    userId: 'user-1',
    attempts: 2,
    nextAttemptAt: 123,
    lastError: null,
    queuedAt: 'earlier',
  })
  assert.equal(merged[1].trade.tradeId, 'trade-2')
  assert.equal(merged[1].userId, 'user-1')
  assert.equal(merged[2].trade.pnl, 99)
  assert.equal(merged[2].userId, 'user-2')
  assert.equal(core.retryDelayMs(1), 30_000)
  assert.equal(core.retryDelayMs(99), 3_600_000)
})

test('close confirmation requires healthy matching observations over time', () => {
  const base = {
    canvasHealthy: true,
    incomplete: false,
    sameContext: true,
    observations: 3,
    missCount: 5,
    firstMissAt: 1_000,
    now: 8_500,
  }
  assert.equal(core.canConfirmOverlayClose(base), true)
  assert.equal(core.canConfirmOverlayClose({ ...base, canvasHealthy: false }), false)
  assert.equal(core.canConfirmOverlayClose({ ...base, sameContext: false }), false)
  assert.equal(core.canConfirmOverlayClose({ ...base, now: 8_499 }), false)
})

test('confirmed disappearance closes identity without fabricating execution values', () => {
  const closed = core.buildSafeCompletedTrade({
    tradeId: 'tv_chart_1',
    symbol: 'BTCUSDT',
    firstSeenAt: '2026-08-06T00:00:00.000Z',
    entryPrice: 100,
    currentPrice: 110,
    pnl: 10,
    pnlPercent: 10,
  }, '2026-08-06T00:01:00.000Z')

  assert.equal(closed.tradeId, 'tv_chart_1')
  assert.equal(closed.status, 'closed')
  assert.equal(closed.exitPrice, null)
  assert.equal(closed.exitPriceSource, null)
  assert.equal(closed.pnl, null)
  assert.equal(closed.pnlPercent, null)
  assert.equal(closed.durationMs, 60_000)
  assert.equal(closed.closeReason, 'user_confirmed_overlay_disappearance')
})

test('MV3 package declares all executable and icon assets', () => {
  const manifestPath = new URL('../chrome-extension/manifest.json', import.meta.url)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.background.service_worker, 'background.js')
  assert.equal(manifest.action.default_popup, 'popup.html')

  const packageRoot = new URL('../chrome-extension/', import.meta.url)
  const assets = [
    'background.js', 'content.js', 'extension-core.js', 'firebase-config.js',
    'page-bridge.js', 'popup.html', 'popup.css', 'popup.js',
    'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png',
  ]
  assets.forEach(asset => assert.equal(existsSync(new URL(asset, packageRoot)), true, `${asset} is missing`))
})

test('classic MV3 service worker boots with local imported scripts', async () => {
  const listeners = { messages: [], alarms: [], installed: [] }
  const storage = {}
  const context = vm.createContext({
    console,
    URLSearchParams,
    crypto: globalThis.crypto,
    fetch: async () => { throw new Error('unexpected network call during boot') },
    setTimeout,
    clearTimeout,
    chrome: {
      action: {
        setBadgeBackgroundColor() {},
        setBadgeText() {},
      },
      alarms: {
        create() {},
        onAlarm: { addListener(listener) { listeners.alarms.push(listener) } },
      },
      runtime: {
        onMessage: { addListener(listener) { listeners.messages.push(listener) } },
        onInstalled: { addListener(listener) { listeners.installed.push(listener) } },
      },
      storage: {
        local: {
          async get(keys) {
            const names = Array.isArray(keys) ? keys : Object.keys(keys || {})
            return Object.fromEntries(names.filter(name => name in storage).map(name => [name, storage[name]]))
          },
          async set(values) { Object.assign(storage, values) },
          async remove(keys) { for (const key of keys) delete storage[key] },
        },
      },
    },
  })
  const root = new URL('../chrome-extension/', import.meta.url)
  context.importScripts = (...paths) => {
    paths.forEach(path => vm.runInContext(readFileSync(new URL(path, root), 'utf8'), context, { filename: path }))
  }

  vm.runInContext(readFileSync(new URL('background.js', root), 'utf8'), context, { filename: 'background.js' })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(listeners.messages.length, 1)
  assert.equal(listeners.alarms.length, 1)
  assert.equal(listeners.installed.length, 1)
})

test('extension authorization is limited to owner trade writes', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
  const normalProof = rules.slice(
    rules.indexOf('function hasCurrentOtpProof'),
    rules.indexOf('function isAuthorizedOwner'),
  )
  const tradeMatch = rules.slice(
    rules.indexOf('match /trades/{docId}'),
    rules.indexOf('match /{subcollection}/{docId}'),
  )

  assert.doesNotMatch(normalProof, /extension_session/)
  assert.match(tradeMatch, /allow write: if isAuthorizedTradeExtension\(userId\)/)
  assert.doesNotMatch(tradeMatch, /allow read: if isAuthorizedTradeExtension/)
})

test('content script accepts only a real render timestamp from this document', () => {
  const content = readFileSync(new URL('../chrome-extension/content.js', import.meta.url), 'utf8')
  assert.match(content, /renderTimestamp >= DOCUMENT_STARTED_AT/)
  assert.match(content, /if \(currentDocumentRender\) canvasHeartbeatAt = renderTimestamp/)
  assert.doesNotMatch(content, /Number\(event\.data\.timestamp\) \|\| Date\.now\(\)/)
})
