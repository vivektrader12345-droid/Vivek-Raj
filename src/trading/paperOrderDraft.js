export const SINGLE_CHART_TILE_ID = 'single-chart'
export const QUOTE_STALE_AFTER_MS = 10_000

export const QuoteStatus = Object.freeze({
  CURRENT: 'current',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
})

const validSide = side => side === 'buy' || side === 'sell'
const canonicalSymbol = symbol => typeof symbol === 'string'
  ? symbol.replace(/[^a-z0-9]/gi, '').toUpperCase()
  : ''

export function createPaperQuote({ price, connected, lastTickTime, now = Date.now() }) {
  const normalizedPrice = Number(price)
  if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
    return Object.freeze({ status: QuoteStatus.UNAVAILABLE, bid: null, ask: null, spread: null })
  }

  const normalizedTickTime = Number(lastTickTime)
  const age = now - normalizedTickTime
  const current = connected === true && Number.isFinite(normalizedTickTime) && normalizedTickTime > 0 && age >= 0 && age < QUOTE_STALE_AFTER_MS
  const spread = Math.max(normalizedPrice * 0.0001, 0.01)

  return Object.freeze({
    status: current ? QuoteStatus.CURRENT : QuoteStatus.STALE,
    bid: Math.max(0, normalizedPrice - spread / 2),
    ask: normalizedPrice + spread / 2,
    spread,
  })
}

/**
 * The single entry command for paper-order drafts. It validates that the
 * request still targets the active tile and symbol, then opens review state.
 * It never imports or invokes tradingStore.placeOrder.
 */
export function openPaperOrderDraft({
  tileId,
  activeTileId,
  symbol,
  activeSymbol,
  symbolDisplay,
  side = 'buy',
  price,
  quoteStatus = QuoteStatus.UNAVAILABLE,
}, openDraft) {
  if (!tileId || tileId !== activeTileId) {
    return { success: false, error: 'Paper order target is not the active chart' }
  }

  const normalizedSymbol = canonicalSymbol(symbol)
  if (!normalizedSymbol || normalizedSymbol !== canonicalSymbol(activeSymbol)) {
    return { success: false, error: 'Paper order market is no longer current' }
  }

  if (!validSide(side)) {
    return { success: false, error: 'Paper order side must be buy or sell' }
  }

  let normalizedPrice = null
  if (price !== undefined && price !== null) {
    normalizedPrice = Number(price)
    if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
      return { success: false, error: 'Paper order draft price must be a positive finite number' }
    }
  }

  if (typeof openDraft !== 'function') {
    return { success: false, error: 'Paper order draft destination is unavailable' }
  }

  const draft = Object.freeze({
    tileId,
    symbol: normalizedSymbol,
    symbolDisplay: typeof symbolDisplay === 'string' && symbolDisplay.trim()
      ? symbolDisplay.trim()
      : normalizedSymbol.replace(/USDT$/, '/USDT'),
    side,
    price: normalizedPrice,
    quoteStatus: Object.values(QuoteStatus).includes(quoteStatus) ? quoteStatus : QuoteStatus.UNAVAILABLE,
  })
  openDraft(draft)
  return { success: true, draft }
}
