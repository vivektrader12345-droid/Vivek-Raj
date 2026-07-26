/**
 * Chart Store - Zustand
 * Manages chart state, timeframe, candle data, indicators, and drawing tools
 */
import { create } from 'zustand'
import { TimeFrame, IndicatorType, TIMEFRAME_MS } from '../types'

const useChartStore = create((set, get) => ({
  // ==================== STATE ====================
  symbol: 'BTCUSDT',
  symbolDisplay: 'BTC/USDT',
  timeframe: TimeFrame.M1,
  candles: [],              // Historical candle data
  currentCandle: null,      // Current forming candle
  isLoading: false,
  wsConnected: false,

  // Indicators
  activeIndicators: ['volume'],
  indicatorSettings: {
    ema: { periods: [9, 21, 55] },
    rsi: { period: 14 },
    macd: { fast: 12, slow: 26, signal: 9 },
    bollinger: { period: 20, stdDev: 2 },
    atr: { period: 14 },
    vwap: {},
    supertrend: { period: 10, multiplier: 3 },
    volume: {},
  },

  // Drawing tools
  activeDrawingTool: null,   // null = no tool active
  drawings: [],              // Saved drawings

  // Chart reference (set by component)
  chartRef: null,
  seriesRef: null,
  volumeSeriesRef: null,

  // ==================== ACTIONS ====================

  setSymbol: (symbol) => {
    const display = symbol.replace('USDT', '/USDT')
    set({ symbol, symbolDisplay: display, candles: [], currentCandle: null })
  },

  setTimeframe: (timeframe) => {
    set({ timeframe, candles: [], currentCandle: null })
  },

  setCandles: (candles) => {
    set({ candles, isLoading: false })
  },

  /**
   * Update or append a candle from WebSocket
   */
  updateCandle: (candle) => {
    const state = get()
    const { candles } = state

    if (candles.length === 0) {
      set({ candles: [candle], currentCandle: candle })
      return
    }

    const lastCandle = candles[candles.length - 1]

    if (candle.time === lastCandle.time) {
      // Update existing candle
      const updated = [...candles]
      updated[updated.length - 1] = candle
      set({ candles: updated, currentCandle: candle })
    } else if (candle.time > lastCandle.time) {
      // New candle
      set({ candles: [...candles, candle], currentCandle: candle })
    }
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setWsConnected: (connected) => set({ wsConnected: connected }),

  // Chart refs
  setChartRef: (ref) => set({ chartRef: ref }),
  setSeriesRef: (ref) => set({ seriesRef: ref }),
  setVolumeSeriesRef: (ref) => set({ volumeSeriesRef: ref }),

  // Indicators
  toggleIndicator: (indicator) => {
    set(s => {
      const active = s.activeIndicators.includes(indicator)
        ? s.activeIndicators.filter(i => i !== indicator)
        : [...s.activeIndicators, indicator]
      return { activeIndicators: active }
    })
  },

  updateIndicatorSettings: (indicator, settings) => {
    set(s => ({
      indicatorSettings: {
        ...s.indicatorSettings,
        [indicator]: { ...s.indicatorSettings[indicator], ...settings },
      },
    }))
  },

  // Drawing tools
  setActiveDrawingTool: (tool) => set({ activeDrawingTool: tool }),

  addDrawing: (drawing) => {
    set(s => ({ drawings: [...s.drawings, { ...drawing, id: `draw_${Date.now()}` }] }))
  },

  removeDrawing: (drawingId) => {
    set(s => ({ drawings: s.drawings.filter(d => d.id !== drawingId) }))
  },

  clearDrawings: () => set({ drawings: [] }),

  // Get current candle close time remaining
  getCandleCountdown: () => {
    const { timeframe, currentCandle } = get()
    if (!currentCandle) return '00:00'
    const tfMs = TIMEFRAME_MS[timeframe] || 60000
    const candleStart = currentCandle.time * 1000
    const candleEnd = candleStart + tfMs
    const remaining = candleEnd - Date.now()

    if (remaining <= 0) return '00:00'

    const hours = Math.floor(remaining / 3600000)
    const minutes = Math.floor((remaining % 3600000) / 60000)
    const seconds = Math.floor((remaining % 60000) / 1000)

    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  },
}))

export default useChartStore
