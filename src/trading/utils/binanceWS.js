/**
 * Binance WebSocket & REST API utilities
 * Handles real-time candle streaming and historical data fetching
 */
import useChartStore from '../stores/chartStore'
import useTradingStore from '../stores/tradingStore'
import { TIMEFRAME_TO_BINANCE } from '../types'

let wsInstance = null
let reconnectTimer = null
const BINANCE_REST = 'https://api.binance.com/api/v3'
const BINANCE_WS = 'wss://stream.binance.com:9443/ws'

/**
 * Fetch historical candles from Binance REST API
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @param {string} interval - e.g. '1m', '5m', '1h'
 * @param {number} [limit=1000] - max 1000
 * @returns {Promise<Array>}
 */
export async function fetchCandles(symbol, interval, limit = 1000) {
  try {
    useChartStore.getState().setLoading(true)
    const url = `${BINANCE_REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    const res = await fetch(url)
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    
    const data = await res.json()
    
    const candles = data.map(k => ({
      time: Math.floor(k[0] / 1000), // Convert to seconds for lightweight-charts
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }))

    useChartStore.getState().setCandles(candles)
    
    // Set initial price
    if (candles.length > 0) {
      useTradingStore.getState().updatePrice(candles[candles.length - 1].close)
    }

    return candles
  } catch (error) {
    console.error('[Binance REST] Fetch candles error:', error)
    useChartStore.getState().setLoading(false)
    return []
  }
}

/**
 * Connect to Binance WebSocket for real-time kline data
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @param {string} interval - e.g. '1m'
 */
export function connectWebSocket(symbol, interval) {
  disconnectWebSocket()

  const wsSymbol = symbol.toLowerCase()
  const wsUrl = `${BINANCE_WS}/${wsSymbol}@kline_${interval}`

  console.log(`[WS] Connecting to ${wsUrl}`)
  
  const ws = new WebSocket(wsUrl)
  wsInstance = ws

  ws.onopen = () => {
    console.log('[WS] Connected')
    useChartStore.getState().setWsConnected(true)
    clearTimeout(reconnectTimer)
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      
      if (msg.e === 'kline') {
        const k = msg.k
        const candle = {
          time: Math.floor(k.t / 1000), // Start time in seconds
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
        }

        // Update chart candle
        useChartStore.getState().updateCandle(candle)
        
        // Update price in trading store (triggers PnL calculation)
        useTradingStore.getState().updatePrice(candle.close)
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  ws.onerror = (error) => {
    console.error('[WS] Error:', error)
    useChartStore.getState().setWsConnected(false)
  }

  ws.onclose = () => {
    console.log('[WS] Disconnected')
    useChartStore.getState().setWsConnected(false)
    
    // Auto-reconnect after 3 seconds
    reconnectTimer = setTimeout(() => {
      const { symbol: currentSymbol, timeframe } = useChartStore.getState()
      connectWebSocket(currentSymbol, timeframe)
    }, 3000)
  }

  return ws
}

/**
 * Disconnect WebSocket
 */
export function disconnectWebSocket() {
  clearTimeout(reconnectTimer)
  if (wsInstance) {
    wsInstance.onclose = null // Prevent auto-reconnect
    wsInstance.close()
    wsInstance = null
  }
  useChartStore.getState().setWsConnected(false)
}

/**
 * Fetch 24h ticker data for a symbol
 * @param {string} symbol
 * @returns {Promise<object>}
 */
export async function fetch24hTicker(symbol) {
  try {
    const res = await fetch(`${BINANCE_REST}/ticker/24hr?symbol=${symbol}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (error) {
    console.error('[Binance] Ticker fetch error:', error)
    return null
  }
}

/**
 * Initialize chart data - fetch history then connect WS
 * @param {string} symbol
 * @param {string} timeframe
 */
export async function initializeChartData(symbol, timeframe) {
  // Fetch historical candles
  await fetchCandles(symbol, timeframe, 1000)
  
  // Connect WebSocket for live updates
  connectWebSocket(symbol, timeframe)
}
