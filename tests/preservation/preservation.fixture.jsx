import React from 'react'
import { createRoot } from 'react-dom/client'
import useTradingStore from '../../src/trading/stores/tradingStore'
import useChartStore from '../../src/trading/stores/chartStore'
import useSettingsStore from '../../src/trading/stores/settingsStore'
import {
  CloseReason,
  OrderSide,
  OrderType,
  TIMEFRAME_TO_BINANCE,
  calculateLiquidationPrice,
} from '../../src/trading/types'
import {
  connectWebSocket,
  disconnectWebSocket,
  fetchCandles,
  initializeChartData,
} from '../../src/trading/utils/binanceWS'
import ProChart from '../../src/trading/components/ProChart'
import ChartOrderLines from '../../src/trading/components/ChartOrderLines'
import TradeMarkers from '../../src/trading/components/TradeMarkers'
import RiskRewardTool from '../../src/trading/components/RiskRewardTool'
import { useTradeBridge } from '../../src/trading/useTradeBridge'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const initialAccount = () => ({
  balance: 100000,
  availableMargin: 100000,
  usedMargin: 0,
  walletBalance: 100000,
  dailyPnl: 0,
  totalPnl: 0,
  winRate: 0,
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
})

function resetTradingStore() {
  useTradingStore.getState().resetAccount()
  useTradingStore.setState({ currentPrice: 0, markPrice: 0, lastTickTime: 0 })
}

function resetChartStore() {
  useChartStore.setState({
    symbol: 'BTCUSDT',
    symbolDisplay: 'BTC/USDT',
    timeframe: '1m',
    candles: [],
    currentCandle: null,
    isLoading: false,
    wsConnected: false,
    chartRef: null,
    seriesRef: null,
    volumeSeriesRef: null,
  })
}

const numeric = value => typeof value === 'number' ? Math.round(value * 1e8) / 1e8 : value
const projectAccount = account => Object.fromEntries(Object.entries(account).map(([key, value]) => [key, numeric(value)]))
const projectPosition = position => ({
  side: position.side,
  status: position.status,
  entryPrice: numeric(position.entryPrice),
  currentPrice: numeric(position.currentPrice),
  markPrice: numeric(position.markPrice),
  qty: numeric(position.qty),
  leverage: numeric(position.leverage),
  margin: numeric(position.margin),
  stopLoss: position.stopLoss,
  takeProfit: position.takeProfit,
  liquidationPrice: numeric(position.liquidationPrice),
  unrealizedPnl: numeric(position.unrealizedPnl),
  roi: numeric(position.roi),
  fee: numeric(position.fee),
  totalFees: numeric(position.totalFees),
})
const projectOrder = order => ({
  side: order.side,
  type: order.type,
  status: order.status,
  qty: numeric(order.qty),
  filledQty: numeric(order.filledQty),
  price: numeric(order.price),
  limitPrice: numeric(order.limitPrice),
  leverage: numeric(order.leverage),
  margin: numeric(order.margin),
  fee: numeric(order.fee),
  stopLoss: order.stopLoss,
  takeProfit: order.takeProfit,
})
const projectTrade = trade => ({
  side: trade.side,
  entryPrice: numeric(trade.entryPrice),
  exitPrice: numeric(trade.exitPrice),
  qty: numeric(trade.qty),
  leverage: numeric(trade.leverage),
  margin: numeric(trade.margin),
  pnl: numeric(trade.pnl),
  roi: numeric(trade.roi),
  fee: numeric(trade.fee),
  netPnl: numeric(trade.netPnl),
  closeReason: trade.closeReason,
  stopLoss: trade.stopLoss,
  takeProfit: trade.takeProfit,
})
const projectPaperState = state => ({
  positions: state.positions.map(projectPosition),
  pendingOrders: state.pendingOrders.map(projectOrder),
  trades: state.trades.map(projectTrade),
  account: projectAccount(state.account),
  currentPrice: numeric(state.currentPrice),
  markPrice: numeric(state.markPrice),
})

const pnl = (side, entry, exit, qty, leverage) => side === 'buy'
  ? (exit - entry) * qty * leverage
  : (entry - exit) * qty * leverage
const roi = (value, margin) => margin === 0 ? 0 : (value / margin) * 100

function newModel() {
  return { positions: [], pendingOrders: [], trades: [], account: initialAccount(), currentPrice: 0, markPrice: 0 }
}

function modelOrder(action, price) {
  const margin = (price * action.qty) / action.leverage
  const fee = price * action.qty * 0.0004
  return {
    side: action.side,
    type: action.type,
    status: action.type === 'market' ? 'filled' : 'pending',
    qty: action.qty,
    filledQty: action.type === 'market' ? action.qty : 0,
    price,
    limitPrice: action.type === 'market' ? null : price,
    leverage: action.leverage,
    margin,
    fee,
    stopLoss: action.stopLoss ?? null,
    takeProfit: action.takeProfit ?? null,
    liquidationPrice: calculateLiquidationPrice(price, action.side, action.leverage),
  }
}

function modelPosition(order) {
  return {
    side: order.side,
    status: 'open',
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
    roi: 0,
    fee: order.fee,
    totalFees: order.fee,
  }
}

function modelPlace(state, action) {
  const price = action.type === 'market' ? state.currentPrice : (action.limitPrice || action.price)
  if (!price || price <= 0) return false
  const order = modelOrder(action, price)
  if (order.margin > state.account.availableMargin) return false
  if (action.type === 'market') {
    state.positions.push(modelPosition(order))
    state.account.usedMargin += order.margin
    state.account.availableMargin -= order.margin
    state.account.balance -= order.fee
  } else {
    state.pendingOrders.push(order)
    state.account.availableMargin -= order.margin
  }
  return true
}

function modelClose(state, index, reason) {
  const position = state.positions[index]
  if (!position) return
  const grossPnl = pnl(position.side, position.entryPrice, state.currentPrice, position.qty, position.leverage)
  const trade = {
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: state.currentPrice,
    qty: position.qty,
    leverage: position.leverage,
    margin: position.margin,
    pnl: grossPnl,
    roi: roi(grossPnl, position.margin),
    fee: position.totalFees,
    netPnl: grossPnl - position.totalFees,
    closeReason: reason,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
  }
  const isWin = trade.netPnl > 0
  state.positions.splice(index, 1)
  state.trades.push(trade)
  state.account.balance += position.margin + trade.netPnl
  state.account.availableMargin += position.margin + trade.netPnl
  state.account.usedMargin -= position.margin
  state.account.totalPnl += trade.netPnl
  state.account.dailyPnl += trade.netPnl
  state.account.totalTrades += 1
  state.account.winningTrades += isWin ? 1 : 0
  state.account.losingTrades += isWin ? 0 : 1
  state.account.winRate = (state.account.winningTrades / state.account.totalTrades) * 100
}

function modelPartialClose(state, index, closeQty) {
  const position = state.positions[index]
  if (!position || closeQty >= position.qty) return modelClose(state, index, 'partial')
  const ratio = closeQty / position.qty
  const closedMargin = position.margin * ratio
  const partial = { ...position, qty: closeQty, margin: closedMargin }
  const grossPnl = pnl(partial.side, partial.entryPrice, state.currentPrice, closeQty, partial.leverage)
  const trade = {
    side: partial.side,
    entryPrice: partial.entryPrice,
    exitPrice: state.currentPrice,
    qty: closeQty,
    leverage: partial.leverage,
    margin: closedMargin,
    pnl: grossPnl,
    roi: roi(grossPnl, closedMargin),
    fee: partial.totalFees,
    netPnl: grossPnl - partial.totalFees,
    closeReason: 'partial',
    stopLoss: partial.stopLoss,
    takeProfit: partial.takeProfit,
  }
  const isWin = trade.netPnl > 0
  position.qty -= closeQty
  position.margin -= closedMargin
  state.trades.push(trade)
  state.account.balance += closedMargin + trade.netPnl
  state.account.availableMargin += closedMargin + trade.netPnl
  state.account.usedMargin -= closedMargin
  state.account.totalPnl += trade.netPnl
  state.account.dailyPnl += trade.netPnl
  state.account.totalTrades += 1
  state.account.winningTrades += isWin ? 1 : 0
  state.account.losingTrades += isWin ? 0 : 1
  state.account.winRate = (state.account.winningTrades / state.account.totalTrades) * 100
}

function modelUpdate(state, price) {
  if (price === state.currentPrice) return
  state.currentPrice = price
  state.markPrice = price
  state.positions.forEach(position => {
    const unrealizedPnl = pnl(position.side, position.entryPrice, price, position.qty, position.leverage)
    position.currentPrice = price
    position.markPrice = price
    position.unrealizedPnl = unrealizedPnl
    position.roi = roi(unrealizedPnl, position.margin)
  })

  const positionsAtTick = [...state.positions]
  positionsAtTick.forEach(position => {
    let reason = null
    if (position.stopLoss && ((position.side === 'buy' && price <= position.stopLoss) || (position.side === 'sell' && price >= position.stopLoss))) reason = 'stop_loss'
    else if (position.takeProfit && ((position.side === 'buy' && price >= position.takeProfit) || (position.side === 'sell' && price <= position.takeProfit))) reason = 'take_profit'
    else if (position.liquidationPrice && ((position.side === 'buy' && price <= position.liquidationPrice) || (position.side === 'sell' && price >= position.liquidationPrice))) reason = 'liquidation'
    if (reason) modelClose(state, state.positions.indexOf(position), reason)
  })

  const pending = [...state.pendingOrders]
  pending.forEach(order => {
    const triggered = order.type === 'limit'
      ? (order.side === 'buy' ? price <= order.price : price >= order.price)
      : (order.side === 'buy' ? price >= order.price : price <= order.price)
    if (!triggered) return
    const index = state.pendingOrders.indexOf(order)
    if (index >= 0) state.pendingOrders.splice(index, 1)
    state.positions.push(modelPosition({ ...order, status: 'filled', filledQty: order.qty }))
    state.account.usedMargin += order.margin
    state.account.balance -= order.fee
  })
}

function assertProjectionParity(model, label) {
  const actual = projectPaperState(useTradingStore.getState())
  const expected = projectPaperState(model)
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${label} transition parity failed\nactual=${actualJson}\nmodel=${expectedJson}`)
  }
}

function makeGenerator(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state
  }
}

function runGeneratedHistory(seed, steps) {
  resetTradingStore()
  const model = newModel()
  const next = makeGenerator(seed)
  const initialPrice = 80 + (next() % 120)
  useTradingStore.getState().updatePrice(initialPrice)
  modelUpdate(model, initialPrice)
  assertProjectionParity(model, `seed ${seed} initial price`)

  for (let step = 0; step < steps; step += 1) {
    const choice = next() % 9
    const store = useTradingStore.getState()
    const price = Math.max(10, model.currentPrice + ((next() % 21) - 10))
    if (choice === 0 || (!model.positions.length && !model.pendingOrders.length)) {
      const action = { symbol: 'BTC/USDT', side: next() % 2 ? 'buy' : 'sell', type: 'market', qty: ((next() % 8) + 2) / 10, price: model.currentPrice, leverage: (next() % 5) + 1, stopLoss: null, takeProfit: null }
      const expected = modelPlace(model, action)
      const result = store.placeOrder(action)
      if (result.success !== expected) throw new Error(`seed ${seed} step ${step} market result mismatch`)
    } else if (choice === 1) {
      const side = next() % 2 ? 'buy' : 'sell'
      const limitPrice = side === 'buy' ? Math.max(1, model.currentPrice - ((next() % 5) + 1)) : model.currentPrice + ((next() % 5) + 1)
      const action = { symbol: 'BTC/USDT', side, type: 'limit', qty: ((next() % 5) + 1) / 10, price: limitPrice, limitPrice, leverage: (next() % 5) + 1, stopLoss: null, takeProfit: null }
      const expected = modelPlace(model, action)
      const result = store.placeOrder(action)
      if (result.success !== expected) throw new Error(`seed ${seed} step ${step} limit result mismatch`)
    } else if (choice === 2) {
      const side = next() % 2 ? 'buy' : 'sell'
      const stopPrice = side === 'buy' ? model.currentPrice + ((next() % 5) + 1) : Math.max(1, model.currentPrice - ((next() % 5) + 1))
      const action = { symbol: 'BTC/USDT', side, type: 'stop', qty: ((next() % 5) + 1) / 10, price: stopPrice, limitPrice: stopPrice, leverage: (next() % 5) + 1, stopLoss: null, takeProfit: null }
      const expected = modelPlace(model, action)
      const result = store.placeOrder(action)
      if (result.success !== expected) throw new Error(`seed ${seed} step ${step} stop result mismatch`)
    } else if (choice === 3) {
      store.updatePrice(price)
      modelUpdate(model, price)
    } else if (choice === 4 && model.pendingOrders.length) {
      store.cancelOrder(store.pendingOrders[0].id)
      const order = model.pendingOrders.shift()
      model.account.availableMargin += order.margin
    } else if (choice === 5 && model.positions.length) {
      store.closePosition(store.positions[0].id, 'manual')
      modelClose(model, 0, 'manual')
    } else if (choice === 6 && model.positions.length) {
      const closeQty = model.positions[0].qty / 2
      store.partialClose(store.positions[0].id, closeQty)
      modelPartialClose(model, 0, closeQty)
    } else if (choice === 7 && model.positions.length) {
      const position = { ...model.positions[0] }
      store.reversePosition(store.positions[0].id)
      modelClose(model, 0, 'reverse')
      modelPlace(model, { symbol: 'BTC/USDT', side: position.side === 'buy' ? 'sell' : 'buy', type: 'market', qty: position.qty, price: model.currentPrice, leverage: position.leverage, stopLoss: null, takeProfit: null })
    } else {
      store.updatePrice(price)
      modelUpdate(model, price)
    }
    assertProjectionParity(model, `seed ${seed} step ${step}`)
  }
  return { seed, steps, final: projectPaperState(useTradingStore.getState()) }
}

async function characterizePaperTrading() {
  localStorage.clear()
  localStorage.setItem('unrelated-product-key', JSON.stringify({ keep: true, version: 7 }))
  resetTradingStore()
  const observations = []
  const store = useTradingStore.getState()
  store.updatePrice(100)
  const market = store.placeOrder({ symbol: 'BTC/USDT', side: OrderSide.BUY, type: OrderType.MARKET, qty: 2, price: 100, leverage: 10, stopLoss: 90, takeProfit: 120 })
  if (!market.success) throw new Error('targeted market order did not execute')
  let state = useTradingStore.getState()
  if (numeric(state.account.balance) !== 99999.92 || state.account.usedMargin !== 20 || state.account.availableMargin !== 99980) throw new Error('market fee/margin observation changed')
  store.updatePrice(105)
  state = useTradingStore.getState()
  if (state.positions[0].unrealizedPnl !== 100 || state.positions[0].roi !== 500 || state.markPrice !== 105) throw new Error('mark-price/P&L observation changed')
  store.partialClose(state.positions[0].id, 0.5)
  state = useTradingStore.getState()
  if (state.positions[0].qty !== 1.5 || state.trades.at(-1).closeReason !== CloseReason.PARTIAL) throw new Error('partial-close observation changed')
  store.updatePrice(103)
  store.reversePosition(useTradingStore.getState().positions[0].id)
  state = useTradingStore.getState()
  if (state.positions.length !== 1 || state.positions[0].side !== OrderSide.SELL || state.trades.at(-1).closeReason !== CloseReason.REVERSE) throw new Error('reverse observation changed')
  store.updatePrice(100)
  store.closeAllPositions()
  state = useTradingStore.getState()
  if (state.positions.length !== 0 || state.trades.length !== 3) throw new Error('close-all observation changed')
  observations.push({ contract: 'market-fee-margin-mark-partial-reverse-close-all', snapshot: projectPaperState(state) })

  resetTradingStore()
  useTradingStore.getState().updatePrice(100)
  const limit = useTradingStore.getState().placeOrder({ symbol: 'BTC/USDT', side: 'buy', type: 'limit', qty: 1, price: 98, limitPrice: 98, leverage: 5 })
  const stop = useTradingStore.getState().placeOrder({ symbol: 'BTC/USDT', side: 'sell', type: 'stop', qty: 1, price: 95, limitPrice: 95, leverage: 5 })
  useTradingStore.getState().modifyOrder(limit.order.id, 97)
  if (useTradingStore.getState().pendingOrders[0].price !== 97) throw new Error('pending modify observation changed')
  useTradingStore.getState().updatePrice(97)
  state = useTradingStore.getState()
  if (state.positions.length !== 1 || state.pendingOrders.length !== 1 || state.positions[0].side !== 'buy') throw new Error('limit fill observation changed')
  useTradingStore.getState().updatePrice(94)
  state = useTradingStore.getState()
  if (state.positions.length !== 2 || state.pendingOrders.length !== 0 || !state.positions.some(position => position.side === 'sell')) throw new Error('stop fill observation changed')
  const cancellable = useTradingStore.getState().placeOrder({ symbol: 'BTC/USDT', side: 'buy', type: 'limit', qty: 1, price: 80, limitPrice: 80, leverage: 4 })
  const availableBeforeCancel = useTradingStore.getState().account.availableMargin
  useTradingStore.getState().cancelOrder(cancellable.order.id)
  if (numeric(useTradingStore.getState().account.availableMargin - availableBeforeCancel) !== numeric(cancellable.order.margin)) throw new Error('cancel margin observation changed')
  observations.push({ contract: 'limit-stop-pending-modify-cancel', snapshot: projectPaperState(useTradingStore.getState()) })

  const triggerCases = [
    { name: 'stop-loss', side: 'buy', stopLoss: 95, takeProfit: null, trigger: 94, reason: 'stop_loss' },
    { name: 'take-profit', side: 'buy', stopLoss: null, takeProfit: 110, trigger: 111, reason: 'take_profit' },
    { name: 'liquidation', side: 'buy', stopLoss: null, takeProfit: null, trigger: 80, reason: 'liquidation' },
  ]
  for (const item of triggerCases) {
    resetTradingStore()
    useTradingStore.getState().updatePrice(100)
    useTradingStore.getState().placeOrder({ symbol: 'BTC/USDT', side: item.side, type: 'market', qty: 1, price: 100, leverage: 5, stopLoss: item.stopLoss, takeProfit: item.takeProfit })
    useTradingStore.getState().updatePrice(item.trigger)
    const triggered = useTradingStore.getState()
    if (triggered.positions.length !== 0 || triggered.trades.at(-1)?.closeReason !== item.reason) throw new Error(`${item.name} observation changed`)
    observations.push({ contract: item.name, trade: projectTrade(triggered.trades.at(-1)) })
  }

  const generated = Array.from({ length: 16 }, (_, index) => runGeneratedHistory(1009 + index * 7919, 40))

  resetTradingStore()
  useTradingStore.getState().updatePrice(250)
  useTradingStore.getState().placeOrder({ symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1.25, price: 250, leverage: 5 })
  await delay(0)
  const persistedRaw = localStorage.getItem('pro-trading-store')
  if (!persistedRaw) throw new Error('pro-trading-store was not persisted')
  const persisted = JSON.parse(persistedRaw)
  const persistedKeys = Object.keys(persisted.state).sort()
  const expectedKeys = ['account', 'pendingOrders', 'positions', 'trades']
  if (JSON.stringify(persistedKeys) !== JSON.stringify(expectedKeys)) throw new Error(`persisted subset changed: ${persistedKeys.join(',')}`)
  const beforeHydration = projectPaperState(useTradingStore.getState())
  useTradingStore.setState({ positions: [], pendingOrders: [], trades: [], account: initialAccount() })
  localStorage.setItem('pro-trading-store', persistedRaw)
  await useTradingStore.persist.rehydrate()
  const afterHydration = projectPaperState(useTradingStore.getState())
  if (JSON.stringify(beforeHydration.positions) !== JSON.stringify(afterHydration.positions) || JSON.stringify(beforeHydration.account) !== JSON.stringify(afterHydration.account)) throw new Error('persisted rehydration observation changed')
  useTradingStore.getState().resetAccount()
  if (localStorage.getItem('unrelated-product-key') !== JSON.stringify({ keep: true, version: 7 })) throw new Error('paper reset changed an unrelated local-storage key')
  observations.push({ contract: 'persistence-and-reset', storageKey: 'pro-trading-store', persistedKeys, unrelatedKeyPreserved: true })

  return { observations, generatedHistories: generated.length, generatedTransitions: generated.length * 40, persistedKeys }
}

async function characterizeBinanceLifecycle() {
  disconnectWebSocket()
  resetTradingStore()
  resetChartStore()
  const originalFetch = window.fetch
  const OriginalWebSocket = window.WebSocket
  const originalSetTimeout = window.setTimeout
  const originalClearTimeout = window.clearTimeout
  const requests = []
  const sockets = []
  const timers = new Map()
  let timerId = 0

  class FakeWebSocket {
    constructor(url) {
      this.url = url
      this.closed = false
      sockets.push(this)
    }
    close() { this.closed = true }
    emitOpen() { this.onopen?.() }
    emitMessage(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }
    emitClose() { this.onclose?.() }
  }

  window.fetch = async url => {
    requests.push(String(url))
    return {
      ok: true,
      async json() {
        return [
          [1700000000123, '100.5', '105.25', '99.75', '104.5', '12.25'],
          [1700000060789, '104.5', '108', '103', '107.25', '15.5'],
        ]
      },
    }
  }
  window.WebSocket = FakeWebSocket
  window.setTimeout = (callback, milliseconds) => {
    const id = ++timerId
    timers.set(id, { callback, milliseconds, cleared: false })
    return id
  }
  window.clearTimeout = id => {
    if (timers.has(id)) timers.get(id).cleared = true
  }

  try {
    const candles = await fetchCandles('BTCUSDT', '1m', 2)
    if (!requests[0].startsWith('https://api.binance.com/api/v3/klines?') || requests[0].includes('apiKey') || requests[0].includes('signature')) throw new Error('Binance bootstrap endpoint contract changed')
    if (candles.length !== 2 || candles.some(candle => !Number.isInteger(candle.time) || candle.time > 2_000_000_000 || Object.values(candle).some(value => !Number.isFinite(value)))) throw new Error('finite epoch-second OHLCV mapping changed')
    if (useTradingStore.getState().currentPrice !== 107.25) throw new Error('bootstrap mark-price update changed')

    await initializeChartData('BTCUSDT', '1m')
    const btcSocket = sockets.at(-1)
    if (btcSocket.url !== 'wss://stream.binance.com:9443/ws/btcusdt@kline_1m') throw new Error('public kline socket URL changed')
    btcSocket.emitOpen()
    btcSocket.emitMessage({ e: 'kline', k: { t: 1700000060000, o: '104.5', h: '109', l: '103', c: '108.5', v: '20' } })
    if (useChartStore.getState().candles.at(-1).close !== 108.5 || useTradingStore.getState().markPrice !== 108.5) throw new Error('live candle/mark-price update changed')

    useChartStore.getState().setSymbol('ETHUSDT')
    useChartStore.getState().setTimeframe('5m')
    const ethSocket = connectWebSocket('ETHUSDT', '5m')
    if (!btcSocket.closed || btcSocket.onclose !== null || ethSocket.url !== 'wss://stream.binance.com:9443/ws/ethusdt@kline_5m') throw new Error('symbol/timeframe obsolete-stream cleanup changed')

    ethSocket.emitClose()
    const reconnect = [...timers.values()].find(timer => timer.milliseconds === 3000 && !timer.cleared)
    if (!reconnect) throw new Error('bounded 3-second reconnect observation changed')
    reconnect.callback()
    const reconnected = sockets.at(-1)
    if (reconnected === ethSocket || reconnected.url !== 'wss://stream.binance.com:9443/ws/ethusdt@kline_5m') throw new Error('reconnect target observation changed')
    disconnectWebSocket()
    if (!reconnected.closed || useChartStore.getState().wsConnected !== false) throw new Error('explicit stream destroy cleanup changed')

    const expectedMapping = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' }
    if (JSON.stringify(TIMEFRAME_TO_BINANCE) !== JSON.stringify(expectedMapping)) throw new Error('TIMEFRAME_TO_BINANCE compatibility changed')
    return {
      restEndpoint: 'https://api.binance.com/api/v3/klines',
      websocketEndpoint: 'wss://stream.binance.com:9443/ws/{symbol}@kline_{interval}',
      mappedCandles: candles,
      socketsCreated: sockets.length,
      obsoleteSocketClosed: btcSocket.closed,
      reconnectDelayMs: reconnect.milliseconds,
      explicitCleanup: reconnected.closed,
      timeframeMapping: TIMEFRAME_TO_BINANCE,
    }
  } finally {
    disconnectWebSocket()
    window.fetch = originalFetch
    window.WebSocket = OriginalWebSocket
    window.setTimeout = originalSetTimeout
    window.clearTimeout = originalClearTimeout
  }
}

async function characterizeChart() {
  window.__lightweightChartRecords.reset()
  resetChartStore()
  resetTradingStore()
  useSettingsStore.setState({
    chartStyle: 'candles',
    showGrid: true,
    showVolume: true,
    showCrosshair: true,
    showOrderLines: true,
    showPositionLines: true,
    showLiquidationLine: true,
    showTradeMarkers: true,
  })
  const nowSeconds = Math.floor(Date.now() / 1000)
  const candles = Array.from({ length: 80 }, (_, index) => {
    const open = 100 + index * 0.2
    const close = open + (index % 2 ? -0.6 : 0.8)
    return { time: nowSeconds - (79 - index) * 60, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 + index * 10 }
  })
  useChartStore.getState().setCandles(candles)
  useTradingStore.getState().updatePrice(candles.at(-1).close)
  const firstPosition = useTradingStore.getState().placeOrder({ symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 1, price: candles.at(-1).close, leverage: 5 })
  useTradingStore.getState().updatePrice(candles.at(-1).close + 2)
  useTradingStore.getState().closePosition(firstPosition.position.id)
  useTradingStore.getState().placeOrder({ symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 2, price: candles.at(-1).close + 2, leverage: 5, stopLoss: 100, takeProfit: 140 })
  useTradingStore.getState().placeOrder({ symbol: 'BTC/USDT', side: 'sell', type: 'limit', qty: 1, price: 135, limitPrice: 135, leverage: 3 })

  const host = document.getElementById('root')
  host.innerHTML = '<div id="chart-host"></div>'
  const chartHost = host.firstElementChild
  const root = createRoot(chartHost)
  root.render(<>
    <ProChart height="100%" />
    <ChartOrderLines />
    <TradeMarkers />
    <RiskRewardTool />
  </>)
  await delay(750)

  const records = window.__lightweightChartRecords.charts
  const firstChart = records[0]
  if (!firstChart) throw new Error('lightweight-charts did not mount')
  const candleSeries = firstChart.series.find(series => series.type === 'candlestick')
  const volumeSeries = firstChart.series.find(series => series.type === 'histogram')
  if (!candleSeries?.history[0]?.length || !volumeSeries?.history[0]?.length) throw new Error('chart history/volume contract changed')
  if (!candleSeries.options.wickUpColor || !candleSeries.options.wickDownColor || candleSeries.options.priceLineVisible !== true || candleSeries.options.lastValueVisible !== true) throw new Error('candles/wicks/price-line contract changed')
  const chartOptionObservation = {
    gridColor: firstChart.options.grid.vertLines.color,
    crosshairMode: firstChart.options.crosshair.mode,
    timeVisible: firstChart.options.timeScale.timeVisible,
    autoScale: firstChart.options.rightPriceScale.autoScale,
  }
  // lightweight-charts 4.1.1 defines CrosshairMode.Normal as numeric 0 (Hidden is 2).
  if (chartOptionObservation.gridColor === 'transparent' || chartOptionObservation.crosshairMode !== 0 || chartOptionObservation.timeVisible !== true || chartOptionObservation.autoScale !== true) {
    throw new Error(`grid/crosshair/scale contract changed: ${JSON.stringify(chartOptionObservation)}`)
  }
  if (!firstChart.options.handleScroll.mouseWheel || !firstChart.options.handleScroll.pressedMouseMove || !firstChart.options.handleScale.axisPressedMouseMove || !firstChart.options.handleScale.axisDoubleClickReset || !firstChart.options.handleScale.pinch) throw new Error('wheel/pointer/axis interaction contract changed')
  if (!candleSeries.markers.at(-1)?.length) throw new Error('trade marker contract changed')
  if (candleSeries.priceLines.length < 5 || !candleSeries.priceLines.some(line => line.title.includes('Entry')) || !candleSeries.priceLines.some(line => line.title.includes('[PENDING]'))) throw new Error('position/order-line contract changed')
  if (!chartHost.textContent.includes('Long press on chart to create Risk/Reward setup')) throw new Error('risk/reward tool contract changed')

  useTradingStore.getState().updatePrice(candles.at(-1).close + 3)
  await delay(50)
  if (!candleSeries.updates.length) throw new Error('live chart update contract changed')
  useSettingsStore.setState({ showGrid: false, showCrosshair: false, showVolume: false })
  await delay(80)
  if (!firstChart.appliedOptions.some(options => options.grid?.vertLines?.color === 'transparent')) throw new Error('grid toggle contract changed')
  if (!volumeSeries.appliedOptions.some(options => options.visible === false)) throw new Error('volume toggle contract changed')

  chartHost.firstElementChild?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  chartHost.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
  chartHost.dispatchEvent(new MouseEvent('mousedown', { clientX: 300, clientY: 240, bubbles: true }))
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 330, clientY: 250, bubbles: true }))
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  const chartApi = useChartStore.getState().chartRef
  chartApi.timeScale().fitContent()
  chartApi.timeScale().setVisibleLogicalRange({ from: 10, to: 60 })
  chartApi.priceScale('right').applyOptions({ autoScale: true })
  const screenshot = chartApi.takeScreenshot()
  if (!(screenshot instanceof HTMLCanvasElement) || screenshot.width <= 0 || screenshot.height <= 0) throw new Error('screenshot contract changed')

  chartHost.style.width = '720px'
  chartHost.style.height = '420px'
  window.dispatchEvent(new Event('resize'))
  await delay(100)
  if (!firstChart.appliedOptions.some(options => options.width > 0 && options.height > 0)) throw new Error('resize contract changed')

  useSettingsStore.setState({ chartStyle: 'line' })
  await delay(150)
  const secondChart = records.at(-1)
  if (secondChart === firstChart || !firstChart.removed || !secondChart.series.some(series => series.type === 'line')) throw new Error('chart-style recreation/cleanup contract changed')
  if (!secondChart.series.find(series => series.type === 'line')?.history[0]?.every(point => Number.isFinite(point.value))) throw new Error('line history mapping changed')

  const summary = {
    engineVersion: '4.1.1',
    historyPoints: candleSeries.history[0].length,
    volumePoints: volumeSeries.history[0].length,
    liveUpdates: candleSeries.updates.length,
    markerCount: candleSeries.markers.at(-1).length,
    priceLineTitles: candleSeries.priceLines.map(line => line.title),
    interactions: {
      wheelZoom: firstChart.options.handleScale.mouseWheel,
      pointerPan: firstChart.options.handleScroll.pressedMouseMove,
      priceAndTimeAxisDrag: firstChart.options.handleScale.axisPressedMouseMove,
      doubleClickReset: firstChart.options.handleScale.axisDoubleClickReset,
      autoScaleCalls: firstChart.priceScales.right?.appliedOptions.filter(options => options.autoScale).length || 0,
      fitContentCalls: firstChart.timeScale.fitContent,
    },
    screenshot: { width: screenshot.width, height: screenshot.height },
    resized: true,
    riskRewardPresent: true,
  }

  root.unmount()
  await delay(80)
  if (!records.every(record => record.removed)) throw new Error('chart destroy cleanup changed')
  const chartState = useChartStore.getState()
  if (chartState.chartRef !== null || chartState.seriesRef !== null || chartState.volumeSeriesRef !== null) throw new Error('chart references were not cleared on destroy')
  summary.destroyedCharts = records.filter(record => record.removed).length
  summary.refsCleared = true
  return summary
}

function BridgeProbe() {
  useTradeBridge()
  return null
}

const closedTrade = (id, overrides = {}) => ({
  id,
  symbol: 'BTC/USDT',
  side: 'buy',
  entryPrice: 100,
  exitPrice: 110,
  qty: 2,
  leverage: 5,
  margin: 40,
  stopLoss: 95,
  takeProfit: 115,
  fee: 0.08,
  pnl: 100,
  netPnl: 99.92,
  roi: 249.8,
  closeReason: 'manual',
  openedAt: Date.parse('2026-01-02T03:04:05.000Z'),
  closedAt: Date.parse('2026-01-02T03:14:05.000Z'),
  duration: 600000,
  ...overrides,
})

async function characterizeTradeBridge() {
  resetTradingStore()
  const baseline = closedTrade('persisted-baseline')
  useTradingStore.setState({ trades: [baseline] })
  const bridgeCalls = []
  const attempts = []
  const documents = new Map()
  const deferred = []
  const authenticatedUid = 'auth-uid-preservation'

  const idempotentWrite = payload => {
    const key = `${authenticatedUid}:${payload.tradeId}`
    attempts.push(key)
    if (!documents.has(key)) documents.set(key, { ...payload, uid: authenticatedUid })
    return documents.get(key)
  }

  window.__tradeBoundary = {
    addTrade(payload) {
      bridgeCalls.push({ payload, uid: authenticatedUid })
      if (payload.tradeId === 'pro_deferred-close') {
        idempotentWrite(payload)
        return new Promise(resolve => deferred.push(() => resolve(documents.get(`${authenticatedUid}:${payload.tradeId}`))))
      }
      if (payload.tradeId === 'pro_retry-close') {
        idempotentWrite(payload)
        return Promise.resolve(idempotentWrite(payload))
      }
      return Promise.resolve(idempotentWrite(payload))
    },
  }

  const host = document.getElementById('root')
  host.innerHTML = '<div id="bridge-host"></div>'
  const root = createRoot(host.firstElementChild)
  root.render(<BridgeProbe />)
  await delay(30)
  if (bridgeCalls.length !== 0) throw new Error('persisted-count baseline changed')

  const deferredTrade = closedTrade('deferred-close')
  useTradingStore.setState({ trades: [baseline, deferredTrade] })
  useTradingStore.setState({ currentPrice: 111 })
  if (bridgeCalls.length !== 1) throw new Error('count did not advance before asynchronous write completion')

  const multiOne = closedTrade('multi-one', { side: 'sell', closeReason: 'partial' })
  const multiTwo = closedTrade('multi-two', { closeReason: 'take_profit' })
  useTradingStore.setState({ trades: [baseline, deferredTrade, multiOne, multiTwo] })
  if (bridgeCalls.length !== 3) throw new Error('multi-append processing changed')

  useTradingStore.setState({ trades: [] })
  const retryTrade = closedTrade('retry-close', { closeReason: 'liquidation' })
  useTradingStore.setState({ trades: [retryTrade] })
  await delay(20)
  if (bridgeCalls.length !== 4) throw new Error('reset baseline handling changed')
  deferred.forEach(release => release())
  await delay(20)

  const mapped = bridgeCalls[0]
  if (mapped.payload.tradeId !== 'pro_deferred-close' || mapped.payload.source !== 'pro_trading' || mapped.payload.type !== 'long' || mapped.payload.quantity !== '2' || mapped.payload.notes !== 'Auto-saved from Pro Trading. Reason: manual') throw new Error('bridge mapping changed')
  if (!bridgeCalls.every(call => call.uid === authenticatedUid)) throw new Error('authenticated UID boundary changed')
  const retryKey = `${authenticatedUid}:pro_retry-close`
  if (attempts.filter(key => key === retryKey).length !== 2 || !documents.has(retryKey)) throw new Error('idempotent retry boundary observation changed')
  if (documents.size !== 4) throw new Error('exactly-once document identity observation changed')

  root.unmount()
  const callCountAtUnmount = bridgeCalls.length
  useTradingStore.setState({ trades: [retryTrade, closedTrade('after-unmount')] })
  await delay(20)
  if (bridgeCalls.length !== callCountAtUnmount) throw new Error('bridge subscription cleanup changed')

  return {
    baselineSkipped: true,
    bridgeCalls: bridgeCalls.length,
    appendedTradeIds: bridgeCalls.map(call => call.payload.tradeId),
    deterministicIds: bridgeCalls.every(call => call.payload.tradeId === `pro_${call.payload.tradeId.slice(4)}`),
    source: [...new Set(bridgeCalls.map(call => call.payload.source))],
    authenticatedUid,
    countAdvancedBeforeAsyncSettlement: true,
    multiAppendCount: 2,
    resetHandled: true,
    retryAttemptsForSameIdentity: attempts.filter(key => key === retryKey).length,
    idempotentDocuments: documents.size,
    subscriptionCleaned: true,
  }
}

window.__preservationFixture = {
  ready: true,
  characterizePaperTrading,
  characterizeBinanceLifecycle,
  characterizeChart,
  characterizeTradeBridge,
}
