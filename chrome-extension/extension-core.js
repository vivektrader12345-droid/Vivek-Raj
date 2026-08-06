(function exposeExtensionCore(root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  root.VMTExtensionCore = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function createExtensionCore() {
  function decodeTokenPayload(token) {
    try {
      const encoded = String(token || '').split('.')[1]
      if (!encoded) throw new Error('missing payload')
      const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
      const decoded = typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('binary')
      return JSON.parse(decoded)
    } catch {
      throw new Error('Invalid Firebase Auth token. Reconnect the extension with a valid session.')
    }
  }

  function tokenNeedsRefresh(token, now = Date.now(), skewMs = 60_000) {
    const payload = decodeTokenPayload(token)
    return !Number.isFinite(Number(payload.exp)) || Number(payload.exp) * 1000 <= now + skewMs
  }

  async function requestWithSingleAuthRefresh({ getAuthContext, refreshAuthContext, request }) {
    let authContext = await getAuthContext()
    let response = await request(authContext)
    if (response.status !== 401) return response

    authContext = await refreshAuthContext(authContext)
    return request(authContext)
  }

  function mergeOutbox(existing, trades, userId, now = Date.now()) {
    if (!userId) throw new Error('userId is required to queue trades')
    const keyFor = entry => `${entry?.userId || '__ownerless__'}\u0000${entry?.trade?.tradeId || ''}`
    const records = new Map((Array.isArray(existing) ? existing : []).map(entry => [keyFor(entry), entry]))
    for (const trade of trades) {
      if (!trade?.tradeId) continue
      const key = `${userId}\u0000${trade.tradeId}`
      const previous = records.get(key)
      records.set(key, {
        trade,
        userId,
        attempts: previous?.attempts || 0,
        nextAttemptAt: now,
        lastError: null,
        queuedAt: previous?.queuedAt || new Date(now).toISOString(),
      })
    }
    return Array.from(records.values())
  }

  function retryDelayMs(attempts) {
    const exponent = Math.max(0, Math.min(Number(attempts) - 1, 7))
    return Math.min(60 * 60 * 1000, 30_000 * (2 ** exponent))
  }

  function normalizeIdentity(value) {
    return String(value || '').trim().toUpperCase()
  }

  function sameChartContext(snapshot, context) {
    if (!snapshot || !context) return false
    if (!normalizeIdentity(snapshot.symbol) || normalizeIdentity(snapshot.symbol) !== normalizeIdentity(context.symbol)) return false
    if (snapshot.exchange && normalizeIdentity(snapshot.exchange) !== normalizeIdentity(context.exchange)) return false
    if (snapshot.timeframe && normalizeIdentity(snapshot.timeframe) !== normalizeIdentity(context.timeframe)) return false
    return true
  }

  function canConfirmOverlayClose({
    canvasHealthy,
    incomplete,
    sameContext,
    observations,
    missCount,
    firstMissAt,
    now = Date.now(),
    minimumMisses = 5,
    minimumDurationMs = 7_500,
  }) {
    return Boolean(canvasHealthy)
      && !incomplete
      && Boolean(sameContext)
      && Number(observations) >= 2
      && Number(missCount) >= minimumMisses
      && Number.isFinite(firstMissAt)
      && now - firstMissAt >= minimumDurationMs
  }

  function buildSafeCompletedTrade(snapshot, exitDate = new Date().toISOString()) {
    const entryDate = snapshot.firstSeenAt || null
    const parsedEntryTime = entryDate ? Date.parse(entryDate) : NaN
    const parsedExitTime = Date.parse(exitDate)
    const durationMs = Number.isFinite(parsedEntryTime) && Number.isFinite(parsedExitTime)
      ? Math.max(0, parsedExitTime - parsedEntryTime)
      : null

    return {
      ...snapshot,
      exitPrice: null,
      exitPriceSource: null,
      pnl: null,
      pnlPercent: null,
      result: null,
      entryDate,
      entryTimeSource: 'first_observed_on_chart',
      exitDate,
      date: exitDate.slice(0, 10),
      duration: durationMs,
      durationMs,
      status: 'closed',
      positionStatus: 'closed',
      recordType: 'history',
      closeReason: 'user_confirmed_overlay_disappearance',
      capturedAt: exitDate,
    }
  }

  return {
    buildSafeCompletedTrade,
    canConfirmOverlayClose,
    decodeTokenPayload,
    mergeOutbox,
    requestWithSingleAuthRefresh,
    retryDelayMs,
    sameChartContext,
    tokenNeedsRefresh,
  }
})
