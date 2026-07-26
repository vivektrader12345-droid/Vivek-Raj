/**
 * TimeframeBar - Chart toolbar with timeframes, indicators, and chart controls
 */
import React, { useState, useEffect } from 'react'
import useChartStore from '../stores/chartStore'
import useTradingStore from '../stores/tradingStore'
import useSettingsStore from '../stores/settingsStore'
import { TimeFrame, formatPrice } from '../types'

const TIMEFRAMES = [
  { label: '1m', value: '1m' },
  { label: '3m', value: '3m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '30m', value: '30m' },
  { label: '1H', value: '1h' },
  { label: '4H', value: '4h' },
  { label: '1D', value: '1d' },
  { label: '1W', value: '1w' },
]

const INDICATORS = [
  { label: 'EMA', value: 'ema' },
  { label: 'RSI', value: 'rsi' },
  { label: 'MACD', value: 'macd' },
  { label: 'BB', value: 'bollinger' },
  { label: 'VWAP', value: 'vwap' },
  { label: 'ATR', value: 'atr' },
  { label: 'ST', value: 'supertrend' },
  { label: 'Vol', value: 'volume' },
]

const DRAWING_TOOLS = [
  { label: '━', value: 'hline', title: 'Horizontal Line' },
  { label: '╲', value: 'trendline', title: 'Trend Line' },
  { label: '│', value: 'vline', title: 'Vertical Line' },
  { label: '▭', value: 'rect', title: 'Rectangle' },
  { label: 'R:R', value: 'rr', title: 'Risk Reward' },
  { label: 'T', value: 'text', title: 'Text' },
  { label: '→', value: 'arrow', title: 'Arrow' },
]

function TimeframeBar() {
  const { timeframe, setTimeframe, symbolDisplay, wsConnected, activeIndicators, toggleIndicator, activeDrawingTool, setActiveDrawingTool } = useChartStore()
  const { currentPrice } = useTradingStore()
  const { showGrid, toggleSetting } = useSettingsStore()
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false)
  const [showDrawingMenu, setShowDrawingMenu] = useState(false)
  const [countdown, setCountdown] = useState('00:00')

  // Countdown timer
  useEffect(() => {
    const tick = () => {
      setCountdown(useChartStore.getState().getCandleCountdown())
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [timeframe])

  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-[#0d0d22] border-b border-[#1e1e3a] select-none">
      {/* Left: Symbol + Price + Change */}
      <div className="flex items-center gap-3">
        <span className="text-white font-semibold text-sm">{symbolDisplay}</span>
        <span className={`text-sm font-bold ${currentPrice > 0 ? 'text-white' : 'text-gray-500'}`}>
          {currentPrice > 0 ? formatPrice(currentPrice) : '—'}
        </span>
        <div className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
          <span className="text-[10px] text-gray-500">{wsConnected ? 'LIVE' : 'OFFLINE'}</span>
        </div>
        <span className="text-xs text-yellow-400/80 font-mono bg-yellow-400/5 px-1.5 py-0.5 rounded">
          {countdown}
        </span>
      </div>

      {/* Center: Timeframes */}
      <div className="flex items-center gap-0.5">
        {TIMEFRAMES.map(tf => (
          <button
            key={tf.value}
            onClick={() => setTimeframe(tf.value)}
            className={`px-2 py-1 rounded text-[11px] font-medium transition-all ${
              timeframe === tf.value
                ? 'bg-[#26a69a]/15 text-[#26a69a] border border-[#26a69a]/30'
                : 'text-gray-400 hover:text-white hover:bg-[#1e1e3a]'
            }`}
          >
            {tf.label}
          </button>
        ))}
      </div>

      {/* Right: Indicators + Drawing + Settings */}
      <div className="flex items-center gap-2">
        {/* Indicators dropdown */}
        <div className="relative">
          <button
            onClick={() => { setShowIndicatorMenu(!showIndicatorMenu); setShowDrawingMenu(false) }}
            className="px-2 py-1 rounded text-[11px] text-gray-400 hover:text-white hover:bg-[#1e1e3a] transition-all"
          >
            📊 Indicators
          </button>
          {showIndicatorMenu && (
            <div className="absolute top-full right-0 mt-1 bg-[#12122a] border border-[#2a2a5a] rounded-lg shadow-xl z-50 min-w-[160px] py-1">
              {INDICATORS.map(ind => (
                <button
                  key={ind.value}
                  onClick={() => toggleIndicator(ind.value)}
                  className={`w-full px-3 py-1.5 text-left text-xs flex items-center justify-between hover:bg-[#1e1e3a] ${
                    activeIndicators.includes(ind.value) ? 'text-[#26a69a]' : 'text-gray-400'
                  }`}
                >
                  <span>{ind.label}</span>
                  {activeIndicators.includes(ind.value) && <span>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Drawing tools dropdown */}
        <div className="relative">
          <button
            onClick={() => { setShowDrawingMenu(!showDrawingMenu); setShowIndicatorMenu(false) }}
            className={`px-2 py-1 rounded text-[11px] transition-all ${
              activeDrawingTool ? 'text-[#26a69a] bg-[#26a69a]/10' : 'text-gray-400 hover:text-white hover:bg-[#1e1e3a]'
            }`}
          >
            ✏️ Draw
          </button>
          {showDrawingMenu && (
            <div className="absolute top-full right-0 mt-1 bg-[#12122a] border border-[#2a2a5a] rounded-lg shadow-xl z-50 min-w-[140px] py-1">
              {DRAWING_TOOLS.map(tool => (
                <button
                  key={tool.value}
                  onClick={() => { setActiveDrawingTool(activeDrawingTool === tool.value ? null : tool.value); setShowDrawingMenu(false) }}
                  className={`w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 hover:bg-[#1e1e3a] ${
                    activeDrawingTool === tool.value ? 'text-[#26a69a]' : 'text-gray-400'
                  }`}
                  title={tool.title}
                >
                  <span className="w-4 text-center">{tool.label}</span>
                  <span>{tool.title}</span>
                </button>
              ))}
              <div className="border-t border-[#2a2a5a] my-1" />
              <button
                onClick={() => { useChartStore.getState().clearDrawings(); setShowDrawingMenu(false) }}
                className="w-full px-3 py-1.5 text-left text-xs text-red-400 hover:bg-[#1e1e3a]"
              >
                🗑️ Clear All
              </button>
            </div>
          )}
        </div>

        {/* Grid toggle */}
        <button
          onClick={() => toggleSetting('showGrid')}
          className={`px-2 py-1 rounded text-[11px] transition-all ${
            showGrid ? 'text-gray-300' : 'text-gray-500'
          } hover:bg-[#1e1e3a]`}
          title="Toggle Grid"
        >
          #
        </button>
      </div>
    </div>
  )
}

export default React.memo(TimeframeBar)
