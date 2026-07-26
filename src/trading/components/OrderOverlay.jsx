/**
 * OrderOverlay - Professional TradingView-style order lines on chart
 * Features:
 * - Draggable Entry/TP/SL lines with live P&L
 * - Auto-close on TP/SL hit with animations
 * - Right-axis price labels
 * - Floating order info boxes
 * - Multiple positions support
 * - Buy and Sell support
 */
import React, { useState, useCallback, useEffect, useRef } from 'react'
import useTradingStore from '../stores/tradingStore'
import useChartStore from '../stores/chartStore'
import {
  OrderSide, formatPrice, formatPnL, formatROI,
  calculatePnL, calculateROI, calculateRisk, calculateRiskPercent,
  calculateReward, calculateRewardPercent
} from '../types'

function OrderOverlay() {
  const positions = useTradingStore(s => s.positions)
  const pendingOrders = useTradingStore(s => s.pendingOrders)
  const currentPrice = useTradingStore(s => s.currentPrice)
  const modifyStopLoss = useTradingStore(s => s.modifyStopLoss)
  const modifyTakeProfit = useTradingStore(s => s.modifyTakeProfit)
  const closePosition = useTradingStore(s => s.closePosition)
  const cancelOrder = useTradingStore(s => s.cancelOrder)
  const modifyOrder = useTradingStore(s => s.modifyOrder)

  const [dragging, setDragging] = useState(null)
  const [dragPrice, setDragPrice] = useState(null)
  const [animations, setAnimations] = useState([]) // {id, type: 'tp'|'sl', time}
  const [, forceUpdate] = useState(0)
  const containerRef = useRef(null)

  // Force re-render on chart scroll/zoom/resize so Y coordinates stay accurate
  useEffect(() => {
    const chart = useChartStore.getState().chartRef
    if (!chart) {
      // Chart not ready yet, retry after a moment
      const timer = setTimeout(() => forceUpdate(n => n + 1), 1000)
      return () => clearTimeout(timer)
    }
    const handler = () => forceUpdate(n => n + 1)
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler)
    chart.subscribeCrosshairMove(handler)
    return () => {
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler)
        chart.unsubscribeCrosshairMove(handler)
      } catch {}
    }
  }, [])

  // Also re-render when price changes (every tick)
  useEffect(() => {
    forceUpdate(n => n + 1)
  }, [currentPrice, positions, pendingOrders])

  // Price <-> Y coordinate conversion
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

  // Drag handlers
  const handleMouseDown = useCallback((e, type, id, price) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging({ type, id, startY: e.clientY, startPrice: price })
    setDragPrice(price)
  }, [])

  const handleMouseMove = useCallback((e) => {
    if (!dragging || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    const newPrice = yToPrice(y)
    if (newPrice && newPrice > 0) setDragPrice(newPrice)
  }, [dragging, yToPrice])

  const handleMouseUp = useCallback(() => {
    if (!dragging || !dragPrice) { setDragging(null); setDragPrice(null); return }
    if (dragging.type === 'sl') modifyStopLoss(dragging.id, dragPrice)
    else if (dragging.type === 'tp') modifyTakeProfit(dragging.id, dragPrice)
    else if (dragging.type === 'order') modifyOrder(dragging.id, dragPrice)
    setDragging(null)
    setDragPrice(null)
  }, [dragging, dragPrice, modifyStopLoss, modifyTakeProfit, modifyOrder])

  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      window.addEventListener('touchmove', handleMouseMove)
      window.addEventListener('touchend', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
        window.removeEventListener('touchmove', handleMouseMove)
        window.removeEventListener('touchend', handleMouseUp)
      }
    }
  }, [dragging, handleMouseMove, handleMouseUp])

  // Animation cleanup
  useEffect(() => {
    if (animations.length === 0) return
    const timer = setTimeout(() => {
      setAnimations(prev => prev.filter(a => Date.now() - a.time < 3000))
    }, 3500)
    return () => clearTimeout(timer)
  }, [animations])

  // Show TP/SL hit animation
  const showHitAnimation = useCallback((type) => {
    setAnimations(prev => [...prev, { id: Date.now(), type, time: Date.now() }])
  }, [])

  // Watch for auto-close (TP/SL hit detection is in tradingStore.updatePrice)
  // We just show animations when positions disappear
  const prevPositionsRef = useRef(positions)
  useEffect(() => {
    const prev = prevPositionsRef.current
    if (prev.length > positions.length) {
      // A position was closed — check last trade to determine reason
      const trades = useTradingStore.getState().trades
      const lastTrade = trades[trades.length - 1]
      if (lastTrade) {
        if (lastTrade.closeReason === 'take_profit') showHitAnimation('tp')
        else if (lastTrade.closeReason === 'stop_loss') showHitAnimation('sl')
      }
    }
    prevPositionsRef.current = positions
  }, [positions, showHitAnimation])

  // Render a single position's lines
  const renderPosition = (pos) => {
    const isBuy = pos.side === OrderSide.BUY
    const pnl = calculatePnL(pos.side, pos.entryPrice, currentPrice, pos.qty, pos.leverage)
    const roi = calculateROI(pnl, pos.margin)
    const isProfit = pnl >= 0

    const entryY = priceToY(pos.entryPrice)
    const displaySL = dragging?.type === 'sl' && dragging?.id === pos.id ? dragPrice : pos.stopLoss
    const displayTP = dragging?.type === 'tp' && dragging?.id === pos.id ? dragPrice : pos.takeProfit
    const slY = displaySL ? priceToY(displaySL) : null
    const tpY = displayTP ? priceToY(displayTP) : null

    const risk = displaySL ? calculateRisk(pos.side, pos.entryPrice, displaySL, pos.qty, pos.leverage) : 0
    const riskPct = calculateRiskPercent(risk, pos.margin)
    const reward = displayTP ? calculateReward(pos.side, pos.entryPrice, displayTP, pos.qty, pos.leverage) : 0
    const rewardPct = calculateRewardPercent(reward, pos.margin)
    const rrRatio = risk > 0 ? (reward / risk).toFixed(2) : '—'
    const posSize = pos.entryPrice * pos.qty

    return (
      <React.Fragment key={pos.id}>
        {/* ===== ENTRY LINE (Blue) ===== */}
        {entryY != null && entryY > 0 && entryY < 2000 && (
          <div className="absolute left-0 right-0" style={{ top: `${entryY}px` }}>
            {/* Line */}
            <div className="w-full border-t-[2px] border-solid border-[#2196f3]" />
            {/* Left label box */}
            <div className="absolute left-1 -top-[14px] flex items-center gap-1 pointer-events-auto">
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#2196f3]/15 border border-[#2196f3]/40 backdrop-blur-sm">
                <span className="text-[#2196f3] text-[9px] font-bold">{isBuy ? '▲ BUY' : '▼ SELL'}</span>
                <span className="text-gray-300 text-[9px]">{pos.qty}</span>
                <span className="text-[9px] text-gray-400">|</span>
                <span className={`text-[10px] font-bold ${isProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
                  {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} USD
                </span>
                <span className={`text-[9px] ${isProfit ? 'text-[#26a69a]/70' : 'text-[#ef5350]/70'}`}>
                  ({roi >= 0 ? '+' : ''}{roi.toFixed(2)}%)
                </span>
                <button onClick={() => closePosition(pos.id)}
                  className="ml-1 w-4 h-4 rounded-full bg-[#ef5350]/20 hover:bg-[#ef5350]/40 flex items-center justify-center text-[#ef5350] text-[8px] transition-all">✕</button>
              </div>
            </div>
            {/* Right price tag */}
            <div className="absolute right-0 -top-[10px] px-1.5 py-0.5 rounded-l-md bg-[#2196f3] text-white text-[9px] font-bold">
              {formatPrice(pos.entryPrice)}
            </div>
          </div>
        )}

        {/* ===== TAKE PROFIT LINE (Green) ===== */}
        {tpY != null && tpY > 0 && tpY < 2000 && (
          <div className="absolute left-0 right-0 group"
            style={{ top: `${tpY}px`, cursor: 'ns-resize' }}
            onMouseDown={(e) => handleMouseDown(e, 'tp', pos.id, pos.takeProfit)}>
            {/* Line */}
            <div className="w-full border-t-[2px] border-dashed border-[#4caf50]" />
            {/* Left label */}
            <div className="absolute left-1 -top-[14px] flex items-center gap-1 pointer-events-auto cursor-ns-resize">
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#4caf50]/10 border border-[#4caf50]/30 backdrop-blur-sm">
                <span className="text-[#4caf50] text-[9px] font-bold">★ TP</span>
                <span className="text-gray-300 text-[9px]">{pos.qty}</span>
                <span className="text-[9px] text-gray-400">|</span>
                <span className="text-[#4caf50] text-[10px] font-bold">+{reward.toFixed(2)} USD</span>
                <span className="text-[#4caf50]/70 text-[9px]">(+{rewardPct.toFixed(1)}%)</span>
                <button onClick={(e) => { e.stopPropagation(); modifyTakeProfit(pos.id, null) }}
                  className="ml-1 w-4 h-4 rounded-full bg-[#4caf50]/20 hover:bg-[#4caf50]/40 flex items-center justify-center text-[#4caf50] text-[8px] transition-all">✕</button>
                <span className="text-gray-600 text-[8px] opacity-0 group-hover:opacity-100 transition-opacity">⇕</span>
              </div>
            </div>
            {/* Right price tag */}
            <div className="absolute right-0 -top-[10px] px-1.5 py-0.5 rounded-l-md bg-[#4caf50] text-white text-[9px] font-bold">
              {formatPrice(displayTP)}
            </div>
          </div>
        )}

        {/* ===== STOP LOSS LINE (Red/Orange) ===== */}
        {slY != null && slY > 0 && slY < 2000 && (
          <div className="absolute left-0 right-0 group"
            style={{ top: `${slY}px`, cursor: 'ns-resize' }}
            onMouseDown={(e) => handleMouseDown(e, 'sl', pos.id, pos.stopLoss)}>
            {/* Line */}
            <div className="w-full border-t-[2px] border-dashed border-[#ff6d00]" />
            {/* Left label */}
            <div className="absolute left-1 -top-[14px] flex items-center gap-1 pointer-events-auto cursor-ns-resize">
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#ff6d00]/10 border border-[#ff6d00]/30 backdrop-blur-sm">
                <span className="text-[#ff6d00] text-[9px] font-bold">◆ SL</span>
                <span className="text-gray-300 text-[9px]">{pos.qty}</span>
                <span className="text-[9px] text-gray-400">|</span>
                <span className="text-[#ff6d00] text-[10px] font-bold">-{risk.toFixed(2)} USD</span>
                <span className="text-[#ff6d00]/70 text-[9px]">(-{riskPct.toFixed(1)}%)</span>
                <button onClick={(e) => { e.stopPropagation(); modifyStopLoss(pos.id, null) }}
                  className="ml-1 w-4 h-4 rounded-full bg-[#ff6d00]/20 hover:bg-[#ff6d00]/40 flex items-center justify-center text-[#ff6d00] text-[8px] transition-all">✕</button>
                <span className="text-gray-600 text-[8px] opacity-0 group-hover:opacity-100 transition-opacity">⇕</span>
              </div>
            </div>
            {/* Right price tag */}
            <div className="absolute right-0 -top-[10px] px-1.5 py-0.5 rounded-l-md bg-[#ff6d00] text-white text-[9px] font-bold">
              {formatPrice(displaySL)}
            </div>
          </div>
        )}

        {/* ===== FLOATING ORDER INFO BOX ===== */}
        {entryY != null && entryY > 0 && (
          <div className="absolute right-[60px] pointer-events-none"
            style={{ top: `${Math.max(40, entryY - 70)}px` }}>
            <div className={`px-2.5 py-1.5 rounded-lg border backdrop-blur-sm text-[8px] space-y-0.5 ${
              isProfit ? 'bg-[#0a1f14]/85 border-[#26a69a]/25' : 'bg-[#1f0a0a]/85 border-[#ef5350]/25'
            }`}>
              <div className="flex justify-between gap-4">
                <span className="text-gray-500">Entry</span>
                <span className="text-white">${formatPrice(pos.entryPrice)}</span>
              </div>
              {displayTP && <div className="flex justify-between gap-4">
                <span className="text-gray-500">Target</span>
                <span className="text-[#4caf50]">${formatPrice(displayTP)}</span>
              </div>}
              {displaySL && <div className="flex justify-between gap-4">
                <span className="text-gray-500">Stop</span>
                <span className="text-[#ff6d00]">${formatPrice(displaySL)}</span>
              </div>}
              <div className="flex justify-between gap-4">
                <span className="text-gray-500">Qty</span>
                <span className="text-white">{pos.qty}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-500">Size</span>
                <span className="text-white">${posSize.toFixed(2)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-500">Leverage</span>
                <span className="text-white">{pos.leverage}x</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-500">Margin</span>
                <span className="text-white">${pos.margin.toFixed(2)}</span>
              </div>
              {risk > 0 && <div className="flex justify-between gap-4">
                <span className="text-gray-500">Risk</span>
                <span className="text-[#ff6d00]">-${risk.toFixed(2)}</span>
              </div>}
              {reward > 0 && <div className="flex justify-between gap-4">
                <span className="text-gray-500">Reward</span>
                <span className="text-[#4caf50]">+${reward.toFixed(2)}</span>
              </div>}
              {risk > 0 && reward > 0 && <div className="flex justify-between gap-4">
                <span className="text-gray-500">R:R</span>
                <span className="text-white">1:{rrRatio}</span>
              </div>}
              <div className="flex justify-between gap-4 pt-0.5 border-t border-gray-700/30">
                <span className="text-gray-500">P&L</span>
                <span className={`font-bold ${isProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
                  {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} ({roi >= 0 ? '+' : ''}{roi.toFixed(1)}%)
                </span>
              </div>
            </div>
          </div>
        )}
      </React.Fragment>
    )
  }

  // Render pending order lines
  const renderPendingOrder = (order) => {
    const displayPrice = dragging?.type === 'order' && dragging?.id === order.id ? dragPrice : order.price
    const y = priceToY(displayPrice)
    if (y == null || y <= 0 || y > 2000) return null
    const isBuy = order.side === OrderSide.BUY

    return (
      <div key={order.id} className="absolute left-0 right-0 group"
        style={{ top: `${y}px`, cursor: 'ns-resize' }}
        onMouseDown={(e) => handleMouseDown(e, 'order', order.id, order.price)}>
        <div className={`w-full border-t-[1.5px] border-dashed ${isBuy ? 'border-[#ffab00]' : 'border-[#ff6d00]'}`} />
        <div className="absolute left-1 -top-[14px] flex items-center gap-1 pointer-events-auto cursor-ns-resize">
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md backdrop-blur-sm border ${
            isBuy ? 'bg-[#ffab00]/10 border-[#ffab00]/30' : 'bg-[#ff6d00]/10 border-[#ff6d00]/30'
          }`}>
            <span className={`text-[9px] font-bold ${isBuy ? 'text-[#ffab00]' : 'text-[#ff6d00]'}`}>
              {order.type.toUpperCase()} {order.side.toUpperCase()}
            </span>
            <span className="text-gray-300 text-[9px]">{order.qty} @ ${formatPrice(displayPrice)}</span>
            <span className="text-gray-400 text-[9px]">({order.leverage}x)</span>
            <button onClick={(e) => { e.stopPropagation(); cancelOrder(order.id) }}
              className="ml-1 w-4 h-4 rounded-full bg-red-500/20 hover:bg-red-500/40 flex items-center justify-center text-red-400 text-[8px] transition-all">✕</button>
            <span className="text-gray-600 text-[8px] opacity-0 group-hover:opacity-100">⇕</span>
          </div>
        </div>
        <div className={`absolute right-0 -top-[10px] px-1.5 py-0.5 rounded-l-md text-white text-[9px] font-bold ${isBuy ? 'bg-[#ffab00]' : 'bg-[#ff6d00]'}`}>
          {formatPrice(displayPrice)}
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef}
      className={`absolute inset-0 z-10 overflow-hidden ${dragging ? 'cursor-ns-resize pointer-events-auto' : 'pointer-events-none'}`}>
      {/* Position lines */}
      {positions.map(renderPosition)}

      {/* Pending order lines */}
      {pendingOrders.map(renderPendingOrder)}

      {/* Drag ghost line */}
      {dragging && dragPrice && (() => {
        const y = priceToY(dragPrice)
        if (!y || y <= 0) return null
        const color = dragging.type === 'sl' ? '#ff6d00' : dragging.type === 'tp' ? '#4caf50' : '#ffab00'
        return (
          <div className="absolute left-0 right-0 pointer-events-none" style={{ top: `${y}px` }}>
            <div className="w-full border-t border-dashed" style={{ borderColor: color, opacity: 0.6 }} />
            <div className="absolute right-0 -top-[10px] px-1.5 py-0.5 rounded-l-md text-white text-[9px] font-bold" style={{ backgroundColor: color }}>
              ${formatPrice(dragPrice)}
            </div>
          </div>
        )
      })()}

      {/* ===== TP/SL HIT ANIMATIONS ===== */}
      {animations.map(anim => (
        <div key={anim.id} className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none animate-fade-in-out">
          <div className={`px-6 py-3 rounded-2xl backdrop-blur-md border shadow-2xl ${
            anim.type === 'tp'
              ? 'bg-[#4caf50]/20 border-[#4caf50]/40 shadow-[#4caf50]/20'
              : 'bg-[#ef5350]/20 border-[#ef5350]/40 shadow-[#ef5350]/20'
          }`}>
            <div className={`text-lg font-bold ${anim.type === 'tp' ? 'text-[#4caf50]' : 'text-[#ef5350]'}`}>
              {anim.type === 'tp' ? '✓ Target Hit' : '✕ Stop Loss Hit'}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default OrderOverlay
