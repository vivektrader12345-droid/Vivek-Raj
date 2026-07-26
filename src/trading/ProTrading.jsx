/**
 * ProTrading - Main Professional Trading Page
 * Integrates all trading components into a single cohesive layout:
 * - TimeframeBar (top)
 * - ProChart with overlays (center)
 * - OrderPanel (bottom)
 * - RightSidebar (right)
 * 
 * Handles data initialization, WebSocket lifecycle, and keyboard shortcuts
 */
import React, { useEffect, useCallback, useState } from 'react'
import useChartStore from './stores/chartStore'
import useTradingStore from './stores/tradingStore'
import useSettingsStore from './stores/settingsStore'
import { initializeChartData, disconnectWebSocket } from './utils/binanceWS'

// Components
import ProChart from './components/ProChart'
import TimeframeBar from './components/TimeframeBar'
import OrderPanel from './components/OrderPanel'
import BottomSheet from './components/BottomSheet'
import ProOrderPanel from './components/ProOrderPanel'
import RightSidebar from './components/RightSidebar'
import OrderOverlay from './components/OrderOverlay'
import ChartOrderLines from './components/ChartOrderLines'
import ChartIndicators from './components/ChartIndicators'
import TradeMarkers from './components/TradeMarkers'
import RiskRewardTool from './components/RiskRewardTool'

// Symbol selector pairs
const SYMBOLS = [
  { value: 'BTCUSDT', label: 'BTC/USDT' },
  { value: 'ETHUSDT', label: 'ETH/USDT' },
  { value: 'SOLUSDT', label: 'SOL/USDT' },
  { value: 'BNBUSDT', label: 'BNB/USDT' },
  { value: 'XRPUSDT', label: 'XRP/USDT' },
  { value: 'DOGEUSDT', label: 'DOGE/USDT' },
  { value: 'ADAUSDT', label: 'ADA/USDT' },
  { value: 'DOTUSDT', label: 'DOT/USDT' },
]

function ProTrading() {
  const { symbol, timeframe, setSymbol } = useChartStore()
  const { showSidebar, showOrderPanel } = useSettingsStore()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showOrderSheet, setShowOrderSheet] = useState(false)

  // Initialize chart data on mount and when symbol/timeframe changes
  useEffect(() => {
    initializeChartData(symbol, timeframe)
    return () => disconnectWebSocket()
  }, [symbol, timeframe])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Only if not focused on input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

      // Ctrl+B = Quick Buy
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault()
        const price = useTradingStore.getState().currentPrice
        if (price) {
          useTradingStore.getState().placeOrder({
            symbol: symbol.replace('USDT', '/USDT'),
            side: 'buy', type: 'market',
            qty: useSettingsStore.getState().defaultQty,
            price, leverage: useSettingsStore.getState().defaultLeverage,
          })
        }
      }
      // Ctrl+S = Quick Sell
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault()
        const price = useTradingStore.getState().currentPrice
        if (price) {
          useTradingStore.getState().placeOrder({
            symbol: symbol.replace('USDT', '/USDT'),
            side: 'sell', type: 'market',
            qty: useSettingsStore.getState().defaultQty,
            price, leverage: useSettingsStore.getState().defaultLeverage,
          })
        }
      }
      // Escape = Close all positions
      if (e.key === 'Escape' && e.shiftKey) {
        useTradingStore.getState().closeAllPositions()
      }
      // Escape (no shift) = exit fullscreen
      if (e.key === 'Escape' && !e.shiftKey) {
        setIsFullscreen(false)
      }
      // F11 = toggle fullscreen chart
      if (e.key === 'F11') {
        e.preventDefault()
        setIsFullscreen(prev => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [symbol])

  return (
    <div className="flex flex-col h-screen bg-[#060612] text-white overflow-hidden">
      {/* Top Bar: Symbol Selector + TimeframeBar */}
      <div className={`flex items-center border-b border-[#1e1e3a] shrink-0 ${isFullscreen ? 'hidden' : ''}`}>
        {/* Symbol selector */}
        <div className="flex items-center gap-1 px-2 border-r border-[#1e1e3a]">
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="bg-transparent text-white text-xs font-semibold py-2 px-1 cursor-pointer focus:outline-none appearance-none"
          >
            {SYMBOLS.map(s => (
              <option key={s.value} value={s.value} className="bg-[#0d0d22] text-white">
                {s.label}
              </option>
            ))}
          </select>
        </div>
        {/* Timeframe bar fills remaining space */}
        <div className="flex-1">
          <TimeframeBar />
        </div>
        {/* Fullscreen button */}
        <button
          onClick={() => setIsFullscreen(true)}
          className="px-3 py-1.5 mr-2 rounded text-[10px] font-medium text-gray-400 hover:text-white bg-[#0a0a1f] border border-[#2a2a5a]/30 hover:border-[#26a69a]/30 transition-all"
          title="Fullscreen Chart (F11)"
        >
          ⛶ Full
        </button>
      </div>

      {/* Fullscreen Top Bar - only visible in fullscreen */}
      {isFullscreen && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#0a0a1a] border-b border-[#1e1e3a] shrink-0">
          <div className="flex items-center gap-3">
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="bg-transparent text-white text-xs font-semibold cursor-pointer focus:outline-none appearance-none"
            >
              {SYMBOLS.map(s => (
                <option key={s.value} value={s.value} className="bg-[#0d0d22] text-white">
                  {s.label}
                </option>
              ))}
            </select>
            <TimeframeBar />
          </div>
          <button
            onClick={() => setIsFullscreen(false)}
            className="px-3 py-1.5 rounded text-xs font-bold text-white bg-red-500/80 hover:bg-red-500 border border-red-500/50 transition-all"
          >
            ✕ Exit Fullscreen
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Chart + Order Panel */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Chart Area */}
          <div className="flex-1 relative min-h-0">
            <ProChart height="100%" />
            {/* Overlays rendered inside the chart area */}
            <ChartOrderLines />
            <OrderOverlay />
            <ChartIndicators />
            <TradeMarkers />
            <RiskRewardTool />
          </div>

          {/* Order Panel (bottom) - hidden in fullscreen */}
          {showOrderPanel && !isFullscreen && (
            <div className="shrink-0 border-t border-[#1e1e3a] bg-[#0d0d22]">
              {/* Floating Buy/Sell trigger bar */}
              <div className="flex items-center gap-2 px-3 py-2">
                <button onClick={() => setShowOrderSheet(true)}
                  className="flex-1 py-2.5 rounded-xl bg-[#26a69a] hover:bg-[#2bbd9a] text-white text-xs font-bold shadow-lg shadow-[#26a69a]/20 transition-all active:scale-[0.97]">
                  BUY / LONG
                </button>
                <button onClick={() => setShowOrderSheet(true)}
                  className="flex-1 py-2.5 rounded-xl bg-[#ef5350] hover:bg-[#f44336] text-white text-xs font-bold shadow-lg shadow-[#ef5350]/20 transition-all active:scale-[0.97]">
                  SELL / SHORT
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right Sidebar - hidden in fullscreen */}
        {showSidebar && !isFullscreen && <RightSidebar />}
      </div>

      {/* Bottom Status Bar - hidden in fullscreen */}
      {!isFullscreen && <StatusBar />}

      {/* Order Entry Bottom Sheet */}
      <BottomSheet isOpen={showOrderSheet} onClose={() => setShowOrderSheet(false)} maxHeight="85vh">
        <ProOrderPanel onClose={() => setShowOrderSheet(false)} />
      </BottomSheet>
    </div>
  )
}

/**
 * StatusBar - Bottom status bar with connection, shortcuts, and info
 */
function StatusBar() {
  const wsConnected = useChartStore(s => s.wsConnected)
  const positions = useTradingStore(s => s.positions)
  const account = useTradingStore(s => s.account)
  const { toggleSidebar, toggleOrderPanel } = useSettingsStore()

  return (
    <div className="flex items-center justify-between px-3 py-1 bg-[#0a0a1a] border-t border-[#1e1e3a] text-[9px] shrink-0">
      <div className="flex items-center gap-3">
        <span className={`flex items-center gap-1 ${wsConnected ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-[#26a69a]' : 'bg-[#ef5350]'}`} />
          {wsConnected ? 'Connected' : 'Disconnected'}
        </span>
        <span className="text-gray-500">|</span>
        <span className="text-gray-400">
          Positions: <span className="text-white">{positions.length}</span>
        </span>
        <span className="text-gray-500">|</span>
        <span className="text-gray-400">
          Balance: <span className="text-white">${account.balance.toFixed(2)}</span>
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={toggleOrderPanel} className="text-gray-500 hover:text-gray-300 transition-all">
          Toggle Orders
        </button>
        <button onClick={toggleSidebar} className="text-gray-500 hover:text-gray-300 transition-all">
          Toggle Sidebar
        </button>
        <span className="text-gray-600">Ctrl+B Buy | Ctrl+S Sell | Shift+Esc Close All</span>
      </div>
    </div>
  )
}

export default ProTrading
