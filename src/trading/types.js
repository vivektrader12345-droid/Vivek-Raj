/**
 * Trading Platform Type Definitions
 * Professional-grade type system for orders, positions, and trades
 */

// ==================== ENUMS ====================

/** @enum {string} */
export const OrderSide = {
  BUY: 'buy',
  SELL: 'sell',
}

/** @enum {string} */
export const OrderType = {
  MARKET: 'market',
  LIMIT: 'limit',
  STOP: 'stop',
  STOP_LIMIT: 'stop_limit',
}

/** @enum {string} */
export const OrderStatus = {
  PENDING: 'pending',
  FILLED: 'filled',
  PARTIALLY_FILLED: 'partially_filled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
}

/** @enum {string} */
export const PositionStatus = {
  OPEN: 'open',
  CLOSED: 'closed',
  LIQUIDATED: 'liquidated',
}

/** @enum {string} */
export const CloseReason = {
  MANUAL: 'manual',
  STOP_LOSS: 'stop_loss',
  TAKE_PROFIT: 'take_profit',
  LIQUIDATION: 'liquidation',
  TRAILING_STOP: 'trailing_stop',
  REVERSE: 'reverse',
  PARTIAL: 'partial',
}

/** @enum {string} */
export const TimeFrame = {
  M1: '1m',
  M3: '3m',
  M5: '5m',
  M15: '15m',
  M30: '30m',
  H1: '1h',
  H4: '4h',
  D1: '1d',
  W1: '1w',
}

/** @enum {string} */
export const IndicatorType = {
  EMA: 'ema',
  VWAP: 'vwap',
  RSI: 'rsi',
  MACD: 'macd',
  VOLUME: 'volume',
  ATR: 'atr',
  BOLLINGER: 'bollinger',
  SUPERTREND: 'supertrend',
}

// ==================== FACTORY FUNCTIONS ====================

/**
 * Create a new pending order
 * @param {object} params
 * @param {string} params.symbol
 * @param {string} params.side - OrderSide
 * @param {string} params.type - OrderType
 * @param {number} params.qty
 * @param {number} params.price
 * @param {number} params.leverage
 * @param {number|null} [params.stopLoss]
 * @param {number|null} [params.takeProfit]
 * @param {number|null} [params.limitPrice]
 * @returns {Order}
 */
export function createOrder({
  symbol,
  side,
  type,
  qty,
  price,
  leverage,
  stopLoss = null,
  takeProfit = null,
  limitPrice = null,
}) {
  const margin = (price * qty) / leverage
  const liquidationPrice = calculateLiquidationPrice(price, side, leverage)
  const feeRate = 0.0004 // 0.04% taker fee (Binance standard)
  const fee = price * qty * feeRate

  return {
    id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    side,
    type,
    status: type === OrderType.MARKET ? OrderStatus.FILLED : OrderStatus.PENDING,
    qty,
    filledQty: type === OrderType.MARKET ? qty : 0,
    price,
    limitPrice,
    stopLoss,
    takeProfit,
    leverage,
    margin,
    fee,
    liquidationPrice,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    filledAt: type === OrderType.MARKET ? Date.now() : null,
  }
}

/**
 * Create an open position from a filled order
 * @param {Order} order
 * @returns {Position}
 */
export function createPositionFromOrder(order) {
  return {
    id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    status: PositionStatus.OPEN,
    entryPrice: order.price,
    currentPrice: order.price,
    markPrice: order.price,
    qty: order.qty,
    leverage: order.leverage,
    margin: order.margin,
    stopLoss: order.stopLoss,
    takeProfit: order.takeProfit,
    liquidationPrice: order.liquidationPrice,
    unrealizedPnl: 0,
    realizedPnl: 0,
    roi: 0,
    fee: order.fee,
    fundingFee: 0,
    totalFees: order.fee,
    openedAt: Date.now(),
    closedAt: null,
    closeReason: null,
    exitPrice: null,
    duration: null,
  }
}

/**
 * Create a closed trade record
 * @param {Position} position
 * @param {number} exitPrice
 * @param {string} reason - CloseReason
 * @returns {Trade}
 */
export function createTradeFromPosition(position, exitPrice, reason) {
  const pnl = calculatePnL(position.side, position.entryPrice, exitPrice, position.qty, position.leverage)
  const roi = calculateROI(pnl, position.margin)
  const duration = Date.now() - position.openedAt

  return {
    id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    positionId: position.id,
    orderId: position.orderId,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    qty: position.qty,
    leverage: position.leverage,
    margin: position.margin,
    pnl,
    roi,
    fee: position.totalFees,
    fundingFee: position.fundingFee,
    netPnl: pnl - position.totalFees,
    closeReason: reason,
    openedAt: position.openedAt,
    closedAt: Date.now(),
    duration,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
  }
}

// ==================== CALCULATION HELPERS ====================

/**
 * Calculate PnL for a position
 * @param {string} side
 * @param {number} entryPrice
 * @param {number} currentPrice
 * @param {number} qty
 * @param {number} leverage
 * @returns {number}
 */
export function calculatePnL(side, entryPrice, currentPrice, qty, leverage) {
  if (side === OrderSide.BUY) {
    return (currentPrice - entryPrice) * qty * leverage
  } else {
    return (entryPrice - currentPrice) * qty * leverage
  }
}

/**
 * Calculate ROI percentage
 * @param {number} pnl
 * @param {number} margin
 * @returns {number}
 */
export function calculateROI(pnl, margin) {
  if (margin === 0) return 0
  return (pnl / margin) * 100
}

/**
 * Calculate liquidation price
 * @param {number} entryPrice
 * @param {string} side
 * @param {number} leverage
 * @returns {number}
 */
export function calculateLiquidationPrice(entryPrice, side, leverage) {
  const maintenanceMarginRate = 0.005 // 0.5%
  if (side === OrderSide.BUY) {
    return entryPrice * (1 - (1 / leverage) + maintenanceMarginRate)
  } else {
    return entryPrice * (1 + (1 / leverage) - maintenanceMarginRate)
  }
}

/**
 * Calculate risk amount based on stop loss
 * @param {string} side
 * @param {number} entryPrice
 * @param {number} stopLoss
 * @param {number} qty
 * @param {number} leverage
 * @returns {number}
 */
export function calculateRisk(side, entryPrice, stopLoss, qty, leverage) {
  if (!stopLoss) return 0
  if (side === OrderSide.BUY) {
    return Math.abs(entryPrice - stopLoss) * qty * leverage
  } else {
    return Math.abs(stopLoss - entryPrice) * qty * leverage
  }
}

/**
 * Calculate risk percentage relative to margin
 * @param {number} risk
 * @param {number} margin
 * @returns {number}
 */
export function calculateRiskPercent(risk, margin) {
  if (margin === 0) return 0
  return (risk / margin) * 100
}

/**
 * Calculate reward amount based on take profit
 * @param {string} side
 * @param {number} entryPrice
 * @param {number} takeProfit
 * @param {number} qty
 * @param {number} leverage
 * @returns {number}
 */
export function calculateReward(side, entryPrice, takeProfit, qty, leverage) {
  if (!takeProfit) return 0
  if (side === OrderSide.BUY) {
    return Math.abs(takeProfit - entryPrice) * qty * leverage
  } else {
    return Math.abs(entryPrice - takeProfit) * qty * leverage
  }
}

/**
 * Calculate reward percentage relative to margin
 * @param {number} reward
 * @param {number} margin
 * @returns {number}
 */
export function calculateRewardPercent(reward, margin) {
  if (margin === 0) return 0
  return (reward / margin) * 100
}

export const DEFAULT_STOP_LOSS_PERCENT = 1
export const DEFAULT_TAKE_PROFIT_PERCENT = 2

/**
 * Return sensible initial protection prices for a newly opened position.
 * Explicitly deleted protection remains deleted; these defaults are only used
 * while creating or migrating a position.
 */
export function createDefaultProtection(entryPrice, side, stopPercent = DEFAULT_STOP_LOSS_PERCENT, takeProfitPercent = DEFAULT_TAKE_PROFIT_PERCENT) {
  const entry = Number(entryPrice)
  if (!Number.isFinite(entry) || entry <= 0) return { stopLoss: null, takeProfit: null }
  const direction = side === OrderSide.BUY ? 1 : -1
  const normalize = value => Number(value.toPrecision(12))
  return {
    stopLoss: normalize(entry * (1 - direction * Math.abs(stopPercent) / 100)),
    takeProfit: normalize(entry * (1 + direction * Math.abs(takeProfitPercent) / 100)),
  }
}

/**
 * Shared live TP/SL metrics used by chart labels and position panels.
 */
export function calculateProtectionMetrics(position, stopLoss = position?.stopLoss, takeProfit = position?.takeProfit) {
  if (!position) return { expectedProfit: 0, expectedLoss: 0, profitPercent: 0, lossPercent: 0, riskRewardRatio: 0 }
  const entry = Number(position.entryPrice) || 0
  const stop = Number(stopLoss) || 0
  const target = Number(takeProfit) || 0
  const direction = position.side === OrderSide.BUY ? 1 : -1
  const expectedProfit = target ? calculateReward(position.side, entry, target, position.qty, position.leverage) : 0
  const expectedLoss = stop ? calculateRisk(position.side, entry, stop, position.qty, position.leverage) : 0
  const profitPercent = entry && target ? Math.max(0, direction * ((target - entry) / entry) * 100) : 0
  const lossPercent = entry && stop ? Math.max(0, -direction * ((stop - entry) / entry) * 100) : 0
  return {
    expectedProfit,
    expectedLoss,
    profitPercent,
    lossPercent,
    riskRewardRatio: expectedLoss > 0 ? expectedProfit / expectedLoss : 0,
  }
}

/**
 * Format duration from milliseconds to human-readable
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!ms) return '—'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

/**
 * Format price with appropriate decimals
 * @param {number} price
 * @returns {string}
 */
export function formatPrice(price) {
  if (!price) return '0.00'
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (price >= 1) return price.toFixed(4)
  return price.toFixed(6)
}

/**
 * Format PnL with + sign
 * @param {number} pnl
 * @returns {string}
 */
export function formatPnL(pnl) {
  const prefix = pnl >= 0 ? '+' : ''
  return `${prefix}$${Math.abs(pnl).toFixed(2)}`
}

/**
 * Format ROI with + sign and %
 * @param {number} roi
 * @returns {string}
 */
export function formatROI(roi) {
  const prefix = roi >= 0 ? '+' : ''
  return `${prefix}${roi.toFixed(2)}%`
}

// ==================== TIMEFRAME HELPERS ====================

/** Map timeframe string to Binance interval */
export const TIMEFRAME_TO_BINANCE = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
}

/** Map timeframe to milliseconds */
export const TIMEFRAME_MS = {
  '1m': 60000,
  '3m': 180000,
  '5m': 300000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
  '4h': 14400000,
  '1d': 86400000,
  '1w': 604800000,
}

// ==================== TYPE DEFINITIONS (JSDoc) ====================

/**
 * @typedef {object} Order
 * @property {string} id
 * @property {string} symbol
 * @property {string} side - OrderSide
 * @property {string} type - OrderType
 * @property {string} status - OrderStatus
 * @property {number} qty
 * @property {number} filledQty
 * @property {number} price
 * @property {number|null} limitPrice
 * @property {number|null} stopLoss
 * @property {number|null} takeProfit
 * @property {number} leverage
 * @property {number} margin
 * @property {number} fee
 * @property {number} liquidationPrice
 * @property {number} createdAt - timestamp
 * @property {number} updatedAt - timestamp
 * @property {number|null} filledAt - timestamp
 */

/**
 * @typedef {object} Position
 * @property {string} id
 * @property {string} orderId
 * @property {string} symbol
 * @property {string} side - OrderSide
 * @property {string} status - PositionStatus
 * @property {number} entryPrice
 * @property {number} currentPrice
 * @property {number} markPrice
 * @property {number} qty
 * @property {number} leverage
 * @property {number} margin
 * @property {number|null} stopLoss
 * @property {number|null} takeProfit
 * @property {number} liquidationPrice
 * @property {number} unrealizedPnl
 * @property {number} realizedPnl
 * @property {number} roi
 * @property {number} fee
 * @property {number} fundingFee
 * @property {number} totalFees
 * @property {number} openedAt
 * @property {number|null} closedAt
 * @property {string|null} closeReason
 * @property {number|null} exitPrice
 * @property {number|null} duration
 */

/**
 * @typedef {object} Trade
 * @property {string} id
 * @property {string} positionId
 * @property {string} orderId
 * @property {string} symbol
 * @property {string} side
 * @property {number} entryPrice
 * @property {number} exitPrice
 * @property {number} qty
 * @property {number} leverage
 * @property {number} margin
 * @property {number} pnl
 * @property {number} roi
 * @property {number} fee
 * @property {number} fundingFee
 * @property {number} netPnl
 * @property {string} closeReason
 * @property {number} openedAt
 * @property {number} closedAt
 * @property {number} duration
 * @property {number|null} stopLoss
 * @property {number|null} takeProfit
 */

/**
 * @typedef {object} AccountInfo
 * @property {number} balance
 * @property {number} availableMargin
 * @property {number} usedMargin
 * @property {number} walletBalance
 * @property {number} dailyPnl
 * @property {number} totalPnl
 * @property {number} winRate
 * @property {number} totalTrades
 * @property {number} winningTrades
 * @property {number} losingTrades
 */

/**
 * @typedef {object} ChartCandle
 * @property {number} time - Unix timestamp in seconds
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 */
