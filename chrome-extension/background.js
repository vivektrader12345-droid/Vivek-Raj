importScripts('firebase-config.js', 'extension-core.js')

const EXTENSION_FIREBASE_CONFIG = globalThis.VMT_FIREBASE_CONFIG
const EXTENSION_FIRESTORE_BASE = globalThis.VMT_FIRESTORE_BASE
const core = globalThis.VMTExtensionCore
const OUTBOX_KEY = 'tradeSyncOutbox'
const AUTH_KEYS = ['authToken', 'refreshToken', 'userId', 'sessionGeneration', 'connected']

let syncStatus = 'idle'
let lastSyncTime = null
let errorLog = []
let syncChain = Promise.resolve()

function serializeSync(task) {
  const pending = syncChain.then(task, task)
  syncChain = pending.catch(() => undefined)
  return pending
}

function tokenUserId(token) {
  const payload = core.decodeTokenPayload(token)
  return payload.user_id || payload.sub || null
}

function validateTokenOwner(token, expectedUserId) {
  const actualUserId = tokenUserId(token)
  if (!actualUserId || actualUserId !== expectedUserId) {
    throw new Error('Firebase session does not belong to the configured User ID.')
  }
}

async function assertCurrentSession(userId, sessionGeneration) {
  const current = await chrome.storage.local.get(['userId', 'sessionGeneration', 'connected'])
  if (!current.connected || current.userId !== userId || current.sessionGeneration !== sessionGeneration) {
    throw new Error('Firebase session changed while a write was in progress.')
  }
}

async function refreshFirebaseSession({ refreshToken, userId, sessionGeneration }, persist = true) {
  if (!refreshToken) throw new Error('Firebase refresh token is missing. Reconnect the extension.')
  if (!userId || !sessionGeneration) throw new Error('Firebase session identity is incomplete. Reconnect the extension.')
  if (persist) await assertCurrentSession(userId, sessionGeneration)

  const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(EXTENSION_FIREBASE_CONFIG.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.id_token) {
    const detail = body?.error?.message || `HTTP ${response.status}`
    throw new Error(`Firebase session refresh failed: ${detail}`)
  }

  const next = {
    token: body.id_token,
    refreshToken: body.refresh_token || refreshToken,
    userId: body.user_id || userId,
    sessionGeneration,
  }
  validateTokenOwner(next.token, userId)
  if (next.userId !== userId) throw new Error('Refreshed Firebase session changed users; reconnect the extension.')

  if (persist) {
    await assertCurrentSession(userId, sessionGeneration)
    await chrome.storage.local.set({ authToken: next.token, refreshToken: next.refreshToken })
  }
  return next
}

async function getValidatedAuthContext(forceRefresh = false, expected = null) {
  const data = await chrome.storage.local.get(AUTH_KEYS)
  if (!data.connected) throw new Error('Extension is disconnected.')
  if (!data.userId || !data.sessionGeneration) throw new Error('Firebase session identity is missing. Reconnect the extension.')
  if (expected && (data.userId !== expected.userId || data.sessionGeneration !== expected.sessionGeneration)) {
    throw new Error('Firebase session changed while a write was in progress.')
  }
  if (!data.authToken) throw new Error('Firebase Auth token is missing. Reconnect the extension.')
  if (!data.refreshToken) throw new Error('Firebase refresh token is missing. Reconnect the extension.')

  validateTokenOwner(data.authToken, data.userId)
  const context = {
    token: data.authToken,
    refreshToken: data.refreshToken,
    userId: data.userId,
    sessionGeneration: data.sessionGeneration,
  }
  if (forceRefresh || core.tokenNeedsRefresh(data.authToken)) return refreshFirebaseSession(context)
  return context
}

async function connectAuth(pairingCode) {
  const code = String(pairingCode || '').trim()
  if (!code) throw new Error('A one-time pairing code is required.')

  const redeemResponse = await fetch(`${EXTENSION_FIREBASE_CONFIG.backendOrigin}/api/auth/extension/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode: code }),
  })
  const redeemBody = await redeemResponse.json().catch(() => ({}))
  if (!redeemResponse.ok || !redeemBody.customToken) {
    throw new Error(redeemBody.message || 'Unable to redeem the extension pairing code.')
  }

  const signInResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(EXTENSION_FIREBASE_CONFIG.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: redeemBody.customToken, returnSecureToken: true }),
  })
  const signInBody = await signInResponse.json().catch(() => ({}))
  if (!signInResponse.ok || !signInBody.idToken || !signInBody.refreshToken || !signInBody.localId) {
    const detail = signInBody?.error?.message || `HTTP ${signInResponse.status}`
    throw new Error(`Unable to establish the Firebase extension session: ${detail}`)
  }

  validateTokenOwner(signInBody.idToken, signInBody.localId)
  const sessionGeneration = crypto.randomUUID()
  const previous = await chrome.storage.local.get(['syncOwnerId'])
  const ownerChanged = previous.syncOwnerId !== signInBody.localId
  const sessionState = {
    authToken: signInBody.idToken,
    refreshToken: signInBody.refreshToken,
    userId: signInBody.localId,
    sessionGeneration,
    connected: true,
    syncOwnerId: signInBody.localId,
  }
  if (ownerChanged) {
    Object.assign(sessionState, {
      syncStatus: 'idle',
      lastSyncTime: null,
      errorLog: [],
      syncedCount: 0,
      failedCount: 0,
    })
    syncStatus = 'idle'
    lastSyncTime = null
    errorLog = []
  }
  await chrome.storage.local.set(sessionState)
  updateBadge(ownerChanged ? 'idle' : syncStatus)
  return { userId: signInBody.localId, sessionGeneration }
}

function firestoreFields(trade) {
  const fields = {}
  for (const [key, value] of Object.entries(trade)) {
    if (value === null || value === undefined) fields[key] = { nullValue: null }
    else if (typeof value === 'number') fields[key] = { doubleValue: value }
    else if (typeof value === 'boolean') fields[key] = { booleanValue: value }
    else fields[key] = { stringValue: String(value) }
  }
  return fields
}

async function saveTradeToFirestore(trade, expectedSession) {
  const docId = (trade.tradeId || `tv_${trade.symbol}_${Date.now()}`)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80)
  const now = new Date().toISOString()
  const fields = firestoreFields({
    ...trade,
    source: 'tradingview_extension',
    syncedAt: now,
    createdAt: trade.entryDate || trade.exitDate || trade.capturedAt || now,
  })

  const response = await core.requestWithSingleAuthRefresh({
    getAuthContext: () => getValidatedAuthContext(false, expectedSession),
    refreshAuthContext: context => refreshFirebaseSession(context),
    request: ({ token, userId, sessionGeneration }) => {
      if (userId !== expectedSession.userId || sessionGeneration !== expectedSession.sessionGeneration) {
        throw new Error('Firebase session changed while a write was in progress.')
      }
      return fetch(
        `${EXTENSION_FIRESTORE_BASE}/users/${encodeURIComponent(expectedSession.userId)}/trades/${encodeURIComponent(docId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ fields }),
        },
      )
    },
  })

  if (!response.ok) {
    const body = await response.text()
    if (response.status === 401) throw new Error('Firebase session was rejected after one refresh. Reconnect the extension.')
    if (response.status === 403) throw new Error('Firestore denied this Firebase session. Complete current OTP verification, then reconnect.')
    throw new Error(`Firestore HTTP ${response.status}: ${body.slice(0, 500)}`)
  }
}

function stableHash(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function makeTradeId(record, recordType) {
  const externalId = record.tradeId || record.orderId || record.positionId || record.id
  if (externalId) return `tv_${String(externalId)}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  const identity = [recordType, record.exchange, record.symbol, record.side, record.entryPrice, record.limitPrice, record.quantity, record.entryTime]
    .map(value => value ?? '')
    .join('|')
  return `tv_${stableHash(identity)}`
}

function toDateOnly(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function processTradeData(rawData) {
  const groups = [['position', rawData.positions || []], ['history', rawData.history || []]]
  const trades = new Map()

  groups.forEach(([recordType, records]) => {
    records.forEach(record => {
      if (!record?.symbol || record.symbol === 'Unknown' || record.captureSource !== 'tradingview_chart_overlay') return

      const tradeId = makeTradeId(record, recordType)
      const side = record.side === 'sell' ? 'sell' : record.side === 'buy' ? 'buy' : null
      const type = record.type === 'short' || side === 'sell' ? 'short' : record.type === 'long' || side === 'buy' ? 'long' : null
      const entryPrice = toFiniteNumber(record.entryPrice)
      const rawQuantity = toFiniteNumber(record.quantity)
      const quantity = rawQuantity === null ? null : Math.abs(rawQuantity)
      if (!tradeId || !side || !type || !Number.isFinite(entryPrice) || !Number.isFinite(quantity) || quantity <= 0) return

      const exitPrice = toFiniteNumber(record.exitPrice)
      let pnl = toFiniteNumber(record.pnl)
      if (pnl === null && recordType === 'history' && exitPrice !== null) {
        pnl = Number(((type === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice) * quantity).toFixed(8))
      }
      const entryDate = record.entryDate || record.firstSeenAt || null
      const exitDate = recordType === 'history' ? (record.exitDate || null) : null
      const status = recordType === 'history' ? 'closed' : 'open'
      const result = status === 'closed' && pnl !== null ? (pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven') : null

      trades.set(tradeId, {
        tradeId,
        symbol: record.symbol,
        pair: record.pair || record.symbol,
        exchange: record.exchange || 'TradingView Paper',
        timeframe: record.timeframe || null,
        side,
        type,
        entryPrice,
        exitPrice,
        quantity,
        signedQuantity: toFiniteNumber(record.signedQuantity) ?? (side === 'sell' ? -quantity : quantity),
        leverage: toFiniteNumber(record.leverage),
        margin: toFiniteNumber(record.margin),
        stopLoss: toFiniteNumber(record.stopLoss),
        takeProfit: toFiniteNumber(record.takeProfit),
        riskRewardRatio: toFiniteNumber(record.riskRewardRatio),
        pnl,
        pnlPercent: toFiniteNumber(record.pnlPercent),
        fees: toFiniteNumber(record.fees),
        entryDate,
        exitDate,
        date: toDateOnly(exitDate || entryDate || record.capturedAt),
        duration: record.duration ?? null,
        durationMs: record.durationMs ?? null,
        status,
        positionStatus: status,
        result,
        recordType,
        closeReason: record.closeReason || null,
        exitPriceSource: record.exitPriceSource || null,
        positionColor: record.positionColor || null,
        entryTimeSource: record.entryTimeSource || null,
        captureSource: 'tradingview_chart_overlay',
        source: 'tradingview_extension',
        capturedAt: record.capturedAt || (rawData.timestamp ? new Date(rawData.timestamp).toISOString() : new Date().toISOString()),
      })
    })
  })

  return Array.from(trades.values())
}

async function readOutbox() {
  const data = await chrome.storage.local.get([OUTBOX_KEY])
  return Array.isArray(data[OUTBOX_KEY]) ? data[OUTBOX_KEY] : []
}

async function queueTrades(trades, userId) {
  const existing = await readOutbox()
  const requestedIds = new Set(trades.map(trade => trade.tradeId))
  const merged = core.mergeOutbox(existing, trades, userId)
  await chrome.storage.local.set({ [OUTBOX_KEY]: merged })
  return requestedIds
}

async function flushOutbox({ force = false, requestedIds = new Set() } = {}) {
  const deliverySession = await getValidatedAuthContext()

  const outbox = await readOutbox()
  const remaining = []
  let synced = 0
  let failed = 0
  let firstError = null
  const now = Date.now()

  for (const entry of outbox) {
    const requested = requestedIds.has(entry.trade?.tradeId)
    if (entry.userId !== deliverySession.userId || (!force && Number(entry.nextAttemptAt || 0) > now)) {
      remaining.push(entry)
      continue
    }

    try {
      await saveTradeToFirestore(entry.trade, deliverySession)
      if (requested) synced += 1
    } catch (error) {
      const attempts = Number(entry.attempts || 0) + 1
      const message = error.message || String(error)
      remaining.push({
        ...entry,
        attempts,
        nextAttemptAt: Date.now() + core.retryDelayMs(attempts),
        lastError: message,
      })
      if (requested) failed += 1
      firstError ||= message
    }
    await chrome.storage.local.set({ [OUTBOX_KEY]: remaining.concat(outbox.slice(outbox.indexOf(entry) + 1)) })
  }

  await chrome.storage.local.set({ [OUTBOX_KEY]: remaining })
  const retryCount = remaining.filter(entry => entry.userId === deliverySession.userId).length
  return { synced, failed, error: firstError, retryCount }
}

async function syncTrades(rawData) {
  const trades = processTradeData(rawData)
  const auth = await chrome.storage.local.get(['userId', 'connected', 'syncOwnerId'])
  if (!auth.connected || !auth.userId) {
    return { synced: 0, failed: Math.max(trades.length, 1), error: 'Extension is disconnected. Connect a Firebase session first.' }
  }
  if (trades.length === 0) {
    const error = 'No complete TradingView chart overlay record was received.'
    await logError(error)
    return { synced: 0, failed: 1, error }
  }

  syncStatus = 'syncing'
  updateBadge(syncStatus)
  await chrome.storage.local.set({
    syncOwnerId: auth.userId,
    syncStatus,
    syncTotal: trades.length,
    syncProgress: 0,
    failedCount: 0,
  })

  try {
    const requestedIds = await queueTrades(trades, auth.userId)
    const result = await flushOutbox({ force: true, requestedIds })
    lastSyncTime = new Date().toISOString()
    syncStatus = result.failed === 0 && result.retryCount === 0 ? 'synced' : 'error'
    updateBadge(syncStatus)
    if (result.error) await logError(`Firestore sync failed: ${result.error}`)
    await chrome.storage.local.set({
      syncOwnerId: auth.userId,
      lastSyncTime,
      syncStatus,
      syncProgress: result.synced + result.failed,
      syncedCount: result.synced,
      failedCount: result.failed,
    })
    return result
  } catch (error) {
    const message = error.message || String(error)
    lastSyncTime = new Date().toISOString()
    syncStatus = 'error'
    updateBadge(syncStatus)
    await logError(message)
    await chrome.storage.local.set({
      syncOwnerId: auth.userId,
      lastSyncTime,
      syncStatus,
      syncedCount: 0,
      failedCount: trades.length,
    })
    return { synced: 0, failed: trades.length, error: message }
  }
}

async function retryFailedSyncs(force = false) {
  return serializeSync(async () => {
    try {
      const result = await flushOutbox({ force })
      const auth = await chrome.storage.local.get(['userId', 'connected'])
      syncStatus = result.retryCount === 0 ? 'synced' : 'error'
      updateBadge(syncStatus)
      if (auth.connected && auth.userId) {
        await chrome.storage.local.set({ syncOwnerId: auth.userId, syncStatus, failedCount: result.retryCount })
      }
      if (result.error) await logError(`Retry failed: ${result.error}`)
      return result
    } catch (error) {
      await logError(error.message || String(error))
      return { synced: 0, failed: 0, error: error.message || String(error) }
    }
  })
}

function updateBadge(status) {
  const colors = { idle: '#6b7280', syncing: '#eab308', synced: '#22c55e', error: '#ef4444' }
  const texts = { idle: '', syncing: '⟳', synced: '✓', error: '!' }
  chrome.action.setBadgeBackgroundColor({ color: colors[status] || colors.idle })
  chrome.action.setBadgeText({ text: texts[status] || '' })
}

async function logError(message) {
  const data = await chrome.storage.local.get(['connected', 'userId', 'syncOwnerId', 'errorLog'])
  if (!data.connected || !data.userId || data.syncOwnerId !== data.userId) return
  errorLog = (Array.isArray(data.errorLog) ? data.errorLog : [])
    .filter(entry => entry.userId === data.userId)
  errorLog.push({ userId: data.userId, message, time: new Date().toISOString() })
  errorLog = errorLog.slice(-50)
  await chrome.storage.local.set({ syncOwnerId: data.userId, errorLog })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TRADE_UPDATE') {
    serializeSync(() => syncTrades(message)).then(sendResponse)
    return true
  }
  if (message.type === 'NETWORK_DATA') {
    sendResponse({ ignored: true })
    return false
  }
  if (message.type === 'CONNECT_AUTH') {
    serializeSync(() => connectAuth(message.pairingCode))
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }))
    return true
  }
  if (message.type === 'DISCONNECT_AUTH') {
    serializeSync(async () => {
      await chrome.storage.local.remove(['authToken', 'refreshToken', 'userId', 'sessionGeneration'])
      await chrome.storage.local.set({ connected: false, syncStatus: 'idle' })
      syncStatus = 'idle'
      lastSyncTime = null
      errorLog = []
      updateBadge('idle')
    }).then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }))
    return true
  }
  if (message.type === 'GET_STATUS') {
    chrome.storage.local.get(['connected', 'userId', 'syncOwnerId', 'syncStatus', 'lastSyncTime', 'errorLog', OUTBOX_KEY])
      .then(data => {
        const ownerMatches = Boolean(data.connected && data.userId && data.syncOwnerId === data.userId)
        sendResponse({
          connected: Boolean(data.connected),
          syncStatus: ownerMatches ? (data.syncStatus || 'idle') : 'idle',
          lastSyncTime: ownerMatches ? (data.lastSyncTime || null) : null,
          errorLog: ownerMatches
            ? (data.errorLog || []).filter(entry => entry.userId === data.userId).slice(-10)
            : [],
          retryCount: Array.isArray(data[OUTBOX_KEY])
            ? data[OUTBOX_KEY].filter(entry => data.connected && entry.userId === data.userId).length
            : 0,
        })
      })
    return true
  }
  if (message.type === 'RETRY_SYNC') {
    retryFailedSyncs(Boolean(message.force)).then(result => sendResponse({ done: !result.error, ...result }))
    return true
  }
  return false
})

chrome.alarms.create('retry-sync', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'retry-sync') retryFailedSyncs(false)
})

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(['errorLog', OUTBOX_KEY, 'syncStatus'])
  await chrome.storage.local.set({
    errorLog: Array.isArray(data.errorLog) ? data.errorLog : [],
    [OUTBOX_KEY]: Array.isArray(data[OUTBOX_KEY]) ? data[OUTBOX_KEY] : [],
    syncStatus: data.syncStatus || 'idle',
  })
})

chrome.storage.local.get(['connected', 'userId', 'syncOwnerId', 'syncStatus', 'lastSyncTime', 'errorLog']).then(data => {
  const ownerMatches = Boolean(data.connected && data.userId && data.syncOwnerId === data.userId)
  syncStatus = ownerMatches ? (data.syncStatus || 'idle') : 'idle'
  lastSyncTime = ownerMatches ? (data.lastSyncTime || null) : null
  errorLog = ownerMatches
    ? (Array.isArray(data.errorLog) ? data.errorLog.filter(entry => entry.userId === data.userId) : [])
    : []
  updateBadge(syncStatus)
})
