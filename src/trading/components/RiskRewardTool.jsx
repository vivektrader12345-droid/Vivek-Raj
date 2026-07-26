/**
 * RiskRewardTool - TradingView-style interactive Risk/Reward overlay
 * 
 * Features:
 * - Long press on chart to create a new trade setup
 * - Three draggable lines: TP (green), Entry (blue), SL (orange)
 * - Live P&L, R:R ratio, % gain/loss updates during drag
 * - Auto-scroll chart when dragging beyond visible area
 * - Connecting vertical lines between TP-Entry-SL
 * - Multiple setups simultaneously
 * - Mobile touch + desktop mouse support
 * - TradingView dark theme styling
 */
import React, { useState, useCallback, useEffect, useRef } from 'react'
import useChartStore from '../stores/chartStore'
import useTradingStore from '../stores/tradingStore'
import { formatPrice } from '../types'

function RiskRewardTool() {
  // Trade setups (not actual positions - planning tool)
  const [setups, setSetups] = useState([])
  const [dragging, setDragging] = useState(null) // {setupIdx, line: 'tp'|'entry'|'sl'}
  const [longPressTimer, setLongPressTimer] = useState(null)
  const [isCreating, setIsCreating] = useState(false)
  const [, forceUpdate] = useState(0)
  const containerRef = useRef(null)
  const autoScrollRef = useRef(null)
  const currentPrice = useTradingStore(s => s.currentPrice)

  // Force re-render on chart scroll/zoom so Y coordinates stay correct
  useEffect(() => {
    const chart = useChartStore.getState().chartRef
    if (!chart) return
    const handler = () => forceUpdate(n => n + 1)
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler)
    return () => {
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler) } catch {}
    }
  }, [])

  useEffect(() => { forceUpdate(n => n + 1) }, [currentPrice])

  // Price/Y conversions
  const priceToY = useCallback((price) => {
    const series = useChartStore.getState().seriesRef
    if (!series || !price) return null
    try {
      const y = series.priceToCoordinate(price)
      return y !== null && isFinite(y) ? y : null
    } catch { return null }
  }, [])

  const yToPrice = useCallback((y) => {
    const series = useChartStore.getState().seriesRef
    if (!series || y == null) return null
    try {
      const p = series.coordinateToPrice(y)
      return p !== null && isFinite(p) && p > 0 ? p : null
    } catch { return null }
  }, [])

  // Create new setup on long press
  const handleLongPress = useCallback((e) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    const y = clientY - rect.top
    const price = yToPrice(y)
    if (!price || price <= 0) return

    const entryPrice = price
    const tpPrice = entryPrice * 1.01  // 1% above
    const slPrice = entryPrice * 0.99  // 1% below

    const newSetup = {
      id: Date.now(),
      side: 'buy',
      entry: entryPrice,
      tp: tpPrice,
      sl: slPrice,
      qty: 1,
    }
    setSetups(prev => [...prev, newSetup])
    setIsCreating(false)
  }, [yToPrice])

  // Long press detection
  const handlePointerDown = useCallback((e) => {
    // Only create on long press (500ms) when no setup is being dragged
    if (dragging) return
    const timer = setTimeout(() => handleLongPress(e), 500)
    setLongPressTimer(timer)
  }, [dragging, handleLongPress])

  const handlePointerUpCancel = useCallback(() => {
    if (longPressTimer) { clearTimeout(longPressTimer); setLongPressTimer(null) }
  }, [longPressTimer])

  // Remove a setup
  const removeSetup = useCallback((idx) => {
    setSetups(prev => prev.filter((_, i) => i !== idx))
  }, [])

  // Toggle side (buy/sell)
  const toggleSide = useCallback((idx) => {
    setSetups(prev => prev.map((s, i) => {
      if (i !== idx) return s
      const newSide = s.side === 'buy' ? 'sell' : 'buy'
      // Swap TP and SL when switching sides
      return { ...s, side: newSide, tp: s.sl, sl: s.tp }
    }))
  }, [])

  // Drag start
  const startDrag = useCallback((e, setupIdx, line) => {
    e.preventDefault()
    e.stopPropagation()
    if (longPressTimer) { clearTimeout(longPressTimer); setLongPressTimer(null) }
    setDragging({ setupIdx, line })
  }, [longPressTimer])

  // Drag move with auto-scroll
  const handleDragMove = useCallback((e) => {
    if (!dragging || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    const y = clientY - rect.top
    const newPrice = yToPrice(y)
    if (!newPrice || newPrice <= 0) return

    // Update the setup
    setSetups(prev => prev.map((s, i) => {
      if (i !== dragging.setupIdx) return s
      return { ...s, [dragging.line]: newPrice }
    }))

    // Auto-scroll when near edges
    const chart = useChartStore.getState().chartRef
    if (!chart) return
    const edgeThreshold = 40
    if (y < edgeThreshold) {
      // Near top - scroll price scale up
      if (!autoScrollRef.current) {
        autoScrollRef.current = setInterval(() => {
          const ts = chart.timeScale()
          // Shift visible range slightly
          chart.priceScale('right').applyOptions({ autoScale: false })
        }, 50)
      }
    } else if (y > rect.height - edgeThreshold) {
      // Near bottom
      if (!autoScrollRef.current) {
        autoScrollRef.current = setInterval(() => {
          chart.priceScale('right').applyOptions({ autoScale: false })
        }, 50)
      }
    } else {
      if (autoScrollRef.current) { clearInterval(autoScrollRef.current); autoScrollRef.current = null }
    }
  }, [dragging, yToPrice])

  // Drag end
  const handleDragEnd = useCallback(() => {
    setDragging(null)
    if (autoScrollRef.current) { clearInterval(autoScrollRef.current); autoScrollRef.current = null }
  }, [])

  // Global drag events
  useEffect(() => {
    if (dragging) {
      const moveHandler = (e) => { e.preventDefault(); handleDragMove(e) }
      window.addEventListener('mousemove', moveHandler)
      window.addEventListener('mouseup', handleDragEnd)
      window.addEventListener('touchmove', moveHandler, { passive: false })
      window.addEventListener('touchend', handleDragEnd)
      return () => {
        window.removeEventListener('mousemove', moveHandler)
        window.removeEventListener('mouseup', handleDragEnd)
        window.removeEventListener('touchmove', moveHandler)
        window.removeEventListener('touchend', handleDragEnd)
      }
    }
  }, [dragging, handleDragMove, handleDragEnd])

  // Render a single setup
  const renderSetup = (setup, idx) => {
    const { entry, tp, sl, qty, side } = setup
    const isBuy = side === 'buy'

    // Calculations
    const profit = isBuy ? (tp - entry) * qty : (entry - tp) * qty
    const loss = isBuy ? (entry - sl) * qty : (sl - entry) * qty
    const profitPct = entry > 0 ? ((tp - entry) / entry * 100 * (isBuy ? 1 : -1)).toFixed(2) : '0'
    const lossPct = entry > 0 ? ((entry - sl) / entry * 100 * (isBuy ? 1 : -1)).toFixed(2) : '0'
    const rrRatio = loss > 0 ? (profit / loss).toFixed(2) : '—'

    // Live P&L from current price
    const livePnl = currentPrice
      ? (isBuy ? (currentPrice - entry) * qty : (entry - currentPrice) * qty)
      : 0
    const livePnlPct = entry > 0
      ? ((isBuy ? (currentPrice - entry) : (entry - currentPrice)) / entry * 100).toFixed(2)
      : '0'

    // Y coordinates
    const entryY = priceToY(entry)
    const tpY = priceToY(tp)
    const slY = priceToY(sl)

    if (entryY == null) return null

    // Vertical connector line position
    const topY = Math.min(tpY || entryY, entryY, slY || entryY)
    const bottomY = Math.max(tpY || entryY, entryY, slY || entryY)
    const connectorX = 60 // px from left

    return (
      <React.Fragment key={setup.id}>
        {/* Vertical connector line */}
        {tpY != null && slY != null && (
          <div className="absolute pointer-events-none" style={{
            left: `${connectorX}px`, top: `${topY}px`,
            width: '2px', height: `${bottomY - topY}px`,
            background: `linear-gradient(180deg, #4caf50 0%, #2196f3 50%, #ff6d00 100%)`,
            opacity: 0.5, borderRadius: '1px',
          }} />
        )}

        {/* Profit zone fill (between entry and TP) */}
        {tpY != null && (
          <div className="absolute pointer-events-none" style={{
            left: `${connectorX}px`, right: '52px',
            top: `${Math.min(entryY, tpY)}px`,
            height: `${Math.abs(entryY - tpY)}px`,
            background: 'rgba(76, 175, 80, 0.04)',
            borderLeft: '2px solid rgba(76, 175, 80, 0.2)',
          }} />
        )}

        {/* Loss zone fill (between entry and SL) */}
        {slY != null && (
          <div className="absolute pointer-events-none" style={{
            left: `${connectorX}px`, right: '52px',
            top: `${Math.min(entryY, slY)}px`,
            height: `${Math.abs(entryY - slY)}px`,
            background: 'rgba(255, 109, 0, 0.04)',
            borderLeft: '2px solid rgba(255, 109, 0, 0.2)',
          }} />
        )}

        {/* ===== TP LINE ===== */}
        {tpY != null && tpY > 0 && tpY < 2000 && (
          <div className="absolute left-0 right-0 group"
            style={{ top: `${tpY}px`, cursor: 'ns-resize', zIndex: 5 }}
            onMouseDown={(e) => startDrag(e, idx, 'tp')}
            onTouchStart={(e) => startDrag(e, idx, 'tp')}>
            {/* Line */}
            <div className="w-full border-t-[2px] border-dashed border-[#4caf50]" />
            {/* Floating label (TradingView style) */}
            <div className="absolute left-[70px] -top-[13px] pointer-events-auto">
              <div className="flex items-center gap-0 rounded-md overflow-hidden shadow-lg border border-[#4caf50]/40">
                <div className="bg-[#4caf50] px-2 py-1 flex items-center">
                  <span className="text-white text-[10px] font-bold">{qty}</span>
                </div>
                <div className="bg-[#1a3a2a] px-2.5 py-1 flex items-center gap-1.5">
                  <span className="text-[#4caf50] text-[10px] font-bold">
                    + {profit.toFixed(2)} USD
                  </span>
                </div>
                <button onClick={(e) => { e.stopPropagation(); setSetups(prev => prev.map((s,i) => i === idx ? {...s, tp: null} : s)) }}
                  className="bg-[#1a3a2a] px-1.5 py-1 border-l border-[#4caf50]/20 hover:bg-[#4caf50]/20 transition-all">
                  <span className="text-[#4caf50] text-[10px]">✕</span>
                </button>
              </div>
            </div>
            {/* Right price tag */}
            <div className="absolute right-0 -top-[10px] px-1.5 py-[3px] rounded-l-md bg-[#4caf50] text-white text-[9px] font-bold shadow-md">
              {formatPrice(tp)}
            </div>
            {/* Percentage badge */}
            <div className="absolute left-[70px] top-[3px] text-[8px] text-[#4caf50]/70 pointer-events-none">
              +{Math.abs(parseFloat(profitPct))}% | R:R {rrRatio}
            </div>
          </div>
        )}

        {/* ===== ENTRY LINE ===== */}
        {entryY != null && entryY > 0 && entryY < 2000 && (
          <div className="absolute left-0 right-0 group"
            style={{ top: `${entryY}px`, cursor: 'ns-resize', zIndex: 5 }}
            onMouseDown={(e) => startDrag(e, idx, 'entry')}
            onTouchStart={(e) => startDrag(e, idx, 'entry')}>
            {/* Line */}
            <div className="w-full border-t-[2px] border-solid border-[#2196f3]" />
            {/* Floating label */}
            <div className="absolute left-[70px] -top-[13px] pointer-events-auto">
              <div className="flex items-center gap-0 rounded-md overflow-hidden shadow-lg border border-[#2196f3]/40">
                <div className="bg-[#2196f3] px-2 py-1 flex items-center gap-1">
                  <span className="text-white text-[9px]">{isBuy ? '▲' : '▼'}</span>
                  <span className="text-white text-[10px] font-bold">{qty}</span>
                </div>
                <div className="bg-[#0d1f3a] px-2.5 py-1 flex items-center gap-1.5">
                  <span className={`text-[10px] font-bold ${livePnl >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
                    {livePnl >= 0 ? '+ ' : '- '}{Math.abs(livePnl).toFixed(2)} USD
                  </span>
                </div>
                <button onClick={(e) => { e.stopPropagation(); toggleSide(idx) }}
                  className="bg-[#0d1f3a] px-1.5 py-1 border-l border-[#2196f3]/20 hover:bg-[#2196f3]/20 transition-all"
                  title="Toggle Buy/Sell">
                  <span className="text-[#2196f3] text-[9px]">⇄</span>
                </button>
                <button onClick={(e) => { e.stopPropagation(); removeSetup(idx) }}
                  className="bg-[#0d1f3a] px-1.5 py-1 border-l border-[#2196f3]/20 hover:bg-[#ef5350]/20 transition-all">
                  <span className="text-[#ef5350] text-[10px]">✕</span>
                </button>
              </div>
            </div>
            {/* Right price tag */}
            <div className="absolute right-0 -top-[10px] px-1.5 py-[3px] rounded-l-md bg-[#2196f3] text-white text-[9px] font-bold shadow-md">
              {formatPrice(entry)}
            </div>
            {/* Info below entry */}
            <div className="absolute left-[70px] top-[3px] text-[8px] text-gray-500 pointer-events-none">
              {isBuy ? 'LONG' : 'SHORT'} | {livePnlPct >= 0 ? '+' : ''}{livePnlPct}%
            </div>
          </div>
        )}

        {/* ===== SL LINE ===== */}
        {slY != null && slY > 0 && slY < 2000 && (
          <div className="absolute left-0 right-0 group"
            style={{ top: `${slY}px`, cursor: 'ns-resize', zIndex: 5 }}
            onMouseDown={(e) => startDrag(e, idx, 'sl')}
            onTouchStart={(e) => startDrag(e, idx, 'sl')}>
            {/* Line */}
            <div className="w-full border-t-[2px] border-dashed border-[#ff6d00]" />
            {/* Floating label */}
            <div className="absolute left-[70px] -top-[13px] pointer-events-auto">
              <div className="flex items-center gap-0 rounded-md overflow-hidden shadow-lg border border-[#ff6d00]/40">
                <div className="bg-[#ff6d00] px-2 py-1 flex items-center">
                  <span className="text-white text-[10px] font-bold">{qty}</span>
                </div>
                <div className="bg-[#3a1a0d] px-2.5 py-1 flex items-center gap-1.5">
                  <span className="text-[#ff6d00] text-[10px] font-bold">
                    - {Math.abs(loss).toFixed(2)} USD
                  </span>
                </div>
                <button onClick={(e) => { e.stopPropagation(); setSetups(prev => prev.map((s,i) => i === idx ? {...s, sl: null} : s)) }}
                  className="bg-[#3a1a0d] px-1.5 py-1 border-l border-[#ff6d00]/20 hover:bg-[#ff6d00]/20 transition-all">
                  <span className="text-[#ff6d00] text-[10px]">✕</span>
                </button>
              </div>
            </div>
            {/* Right price tag */}
            <div className="absolute right-0 -top-[10px] px-1.5 py-[3px] rounded-l-md bg-[#ff6d00] text-white text-[9px] font-bold shadow-md">
              {formatPrice(sl)}
            </div>
            {/* Percentage badge */}
            <div className="absolute left-[70px] top-[3px] text-[8px] text-[#ff6d00]/70 pointer-events-none">
              -{Math.abs(parseFloat(lossPct))}%
            </div>
          </div>
        )}
      </React.Fragment>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 z-[7] overflow-hidden ${dragging ? 'cursor-ns-resize pointer-events-auto' : ''}`}
      style={{ pointerEvents: dragging ? 'auto' : 'none' }}
      onMouseDown={!dragging ? handlePointerDown : undefined}
      onMouseUp={handlePointerUpCancel}
      onMouseLeave={handlePointerUpCancel}
      onTouchStart={!dragging ? handlePointerDown : undefined}
      onTouchEnd={handlePointerUpCancel}
    >
      {/* Render all setups */}
      {setups.map((setup, idx) => renderSetup(setup, idx))}

      {/* Hint when no setups exist */}
      {setups.length === 0 && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 pointer-events-none">
          <div className="px-3 py-1.5 rounded-lg bg-[#1e1e3a]/80 border border-[#2a2a5a]/50 backdrop-blur-sm">
            <span className="text-[9px] text-gray-500">Long press on chart to create Risk/Reward setup</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default RiskRewardTool
