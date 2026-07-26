/**
 * DraggableLines - HTML overlay for drag-and-drop SL/TP/Order line modification
 * Sits on top of the chart and handles mouse drag to modify price levels
 * When user drags a line, it updates the store which re-renders the chart price lines
 */
import React, { useState, useCallback, useEffect, useRef } from 'react'
import useTradingStore from '../stores/tradingStore'
import useChartStore from '../stores/chartStore'
import { OrderSide, formatPrice, calculateRisk, calculateRiskPercent, calculateReward, calculateRewardPercent } from '../types'

function DraggableLines() {
  const positions = useTradingStore(s => s.positions)
  const pendingOrders = useTradingStore(s => s.pendingOrders)
  const currentPrice = useTradingStore(s => s.currentPrice)
  const modifyStopLoss = useTradingStore(s => s.modifyStopLoss)
  const modifyTakeProfit = useTradingStore(s => s.modifyTakeProfit)
  const modifyOrder = useTradingStore(s => s.modifyOrder)
  const cancelOrder = useTradingStore(s => s.cancelOrder)
  const closePosition = useTradingStore(s => s.closePosition)

  const [dragging, setDragging] = useState(null) // { type: 'sl'|'tp'|'order', id, startY, startPrice }
  const [dragPrice, setDragPrice] = useState(null)
  const containerRef = useRef(null)

  // Convert Y position to price using chart coordinate system
  const yToPrice = useCallback((y) => {
    const chart = useChartStore.getState().chartRef
    const series = useChartStore.getState().seriesRef
    if (!chart || !series) return null

    const coordinate = series.coordinateToPrice(y)
    return coordinate
  }, [])

  // Convert price to Y position
  const priceToY = useCallback((price) => {
    const series = useChartStore.getState().seriesRef
    if (!series) return null

    const y = series.priceToCoordinate(price)
    return y
  }, [])

  // Mouse handlers for dragging
  const handleMouseDown = useCallback((e, type, id, price) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging({ type, id, startY: e.clientY, startPrice: price })
    setDragPrice(price)
  }, [])

  const handleMouseMove = useCallback((e) => {
    if (!dragging) return
    
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const y = e.clientY - rect.top
    const newPrice = yToPrice(y)

    if (newPrice && newPrice > 0) {
      setDragPrice(newPrice)
    }
  }, [dragging, yToPrice])

  const handleMouseUp = useCallback(() => {
    if (!dragging || !dragPrice) {
      setDragging(null)
      setDragPrice(null)
      return
    }

    // Apply the new price
    if (dragging.type === 'sl') {
      modifyStopLoss(dragging.id, dragPrice)
    } else if (dragging.type === 'tp') {
      modifyTakeProfit(dragging.id, dragPrice)
    } else if (dragging.type === 'order') {
      modifyOrder(dragging.id, dragPrice)
    }

    setDragging(null)
    setDragPrice(null)
  }, [dragging, dragPrice, modifyStopLoss, modifyTakeProfit, modifyOrder])

  // Global mouse event listeners for drag
  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [dragging, handleMouseMove, handleMouseUp])

  // Render line labels with drag handles
  const renderPositionLabels = () => {
    return positions.map(pos => {
      const entryY = priceToY(pos.entryPrice)
      const slY = pos.stopLoss ? priceToY(dragging?.type === 'sl' && dragging?.id === pos.id ? dragPrice : pos.stopLoss) : null
      const tpY = pos.takeProfit ? priceToY(dragging?.type === 'tp' && dragging?.id === pos.id ? dragPrice : pos.takeProfit) : null
      const liqY = pos.liquidationPrice ? priceToY(pos.liquidationPrice) : null

      const displaySL = dragging?.type === 'sl' && dragging?.id === pos.id ? dragPrice : pos.stopLoss
      const displayTP = dragging?.type === 'tp' && dragging?.id === pos.id ? dragPrice : pos.takeProfit

      const risk = displaySL ? calculateRisk(pos.side, pos.entryPrice, displaySL, pos.qty, pos.leverage) : 0
      const riskPct = calculateRiskPercent(risk, pos.margin)
      const reward = displayTP ? calculateReward(pos.side, pos.entryPrice, displayTP, pos.qty, pos.leverage) : 0
      const rewardPct = calculateRewardPercent(reward, pos.margin)

      return (
        <React.Fragment key={pos.id}>
          {/* Entry Line Label */}
          {entryY != null && entryY > 0 && (
            <div
              className="absolute left-0 right-0 flex items-center pointer-events-none"
              style={{ top: `${entryY}px`, transform: 'translateY(-50%)' }}
            >
              <div className={`flex items-center gap-1 px-2 py-0.5 rounded-r text-[10px] font-medium pointer-events-auto ${
                pos.side === OrderSide.BUY ? 'bg-[#26a69a]/20 border-l-2 border-[#26a69a]' : 'bg-[#ef5350]/20 border-l-2 border-[#ef5350]'
              }`}>
                <span className={pos.side === OrderSide.BUY ? 'text-[#26a69a]' : 'text-[#ef5350]'}>
                  {pos.side === OrderSide.BUY ? '▲ BUY' : '▼ SELL'}
                </span>
                <span className="text-gray-300">{pos.qty} × {pos.leverage}x</span>
                <span className="text-gray-400">| M: ${pos.margin.toFixed(2)}</span>
                <span className="text-gray-500 text-[9px]">{new Date(pos.openedAt).toLocaleTimeString()}</span>
                <button
                  onClick={() => closePosition(pos.id)}
                  className="ml-1 text-red-400 hover:text-red-300 pointer-events-auto"
                  title="Close Position"
                >✕</button>
              </div>
            </div>
          )}

          {/* Stop Loss Label - Draggable */}
          {slY != null && slY > 0 && (
            <div
              className="absolute left-0 right-0 flex items-center group"
              style={{ top: `${slY}px`, transform: 'translateY(-50%)', cursor: 'ns-resize' }}
              onMouseDown={(e) => handleMouseDown(e, 'sl', pos.id, pos.stopLoss)}
            >
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-r text-[10px] font-medium bg-[#ff4976]/15 border-l-2 border-[#ff4976] pointer-events-auto cursor-ns-resize">
                <span className="text-[#ff4976]">◆ SL</span>
                <span className="text-gray-300">${formatPrice(displaySL)}</span>
                <span className="text-[#ff4976]">-${risk.toFixed(2)} ({riskPct.toFixed(1)}%)</span>
                <span className="text-gray-500 text-[9px] opacity-0 group-hover:opacity-100">⇕ drag</span>
              </div>
            </div>
          )}

          {/* Take Profit Label - Draggable */}
          {tpY != null && tpY > 0 && (
            <div
              className="absolute left-0 right-0 flex items-center group"
              style={{ top: `${tpY}px`, transform: 'translateY(-50%)', cursor: 'ns-resize' }}
              onMouseDown={(e) => handleMouseDown(e, 'tp', pos.id, pos.takeProfit)}
            >
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-r text-[10px] font-medium bg-[#4caf50]/15 border-l-2 border-[#4caf50] pointer-events-auto cursor-ns-resize">
                <span className="text-[#4caf50]">★ TP</span>
                <span className="text-gray-300">${formatPrice(displayTP)}</span>
                <span className="text-[#4caf50]">+${reward.toFixed(2)} ({rewardPct.toFixed(1)}%)</span>
                <span className="text-gray-500 text-[9px] opacity-0 group-hover:opacity-100">⇕ drag</span>
              </div>
            </div>
          )}

          {/* Liquidation Label */}
          {liqY != null && liqY > 0 && (
            <div
              className="absolute left-0 right-0 flex items-center pointer-events-none"
              style={{ top: `${liqY}px`, transform: 'translateY(-50%)' }}
            >
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-r text-[10px] font-medium bg-[#9c27b0]/15 border-l-2 border-[#9c27b0]">
                <span className="text-[#9c27b0]">⚠ LIQ</span>
                <span className="text-gray-300">${formatPrice(pos.liquidationPrice)}</span>
              </div>
            </div>
          )}
        </React.Fragment>
      )
    })
  }

  // Render pending order labels
  const renderOrderLabels = () => {
    return pendingOrders.map(order => {
      const displayPrice = dragging?.type === 'order' && dragging?.id === order.id ? dragPrice : order.price
      const y = priceToY(displayPrice)
      if (y == null || y <= 0) return null

      const isBuy = order.side === OrderSide.BUY
      const color = isBuy ? '#ffab00' : '#ff6d00'

      return (
        <div
          key={order.id}
          className="absolute left-0 right-0 flex items-center group"
          style={{ top: `${y}px`, transform: 'translateY(-50%)', cursor: 'ns-resize' }}
          onMouseDown={(e) => handleMouseDown(e, 'order', order.id, order.price)}
        >
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-r text-[10px] font-medium pointer-events-auto cursor-ns-resize`}
            style={{ backgroundColor: `${color}15`, borderLeft: `2px solid ${color}` }}>
            <span style={{ color }}>
              {order.type.toUpperCase()} {order.side.toUpperCase()}
            </span>
            <span className="text-gray-300">{order.qty} @ ${formatPrice(displayPrice)}</span>
            <span className="text-gray-400">({order.leverage}x)</span>
            <span className="text-yellow-400/70 text-[9px]">[PENDING]</span>
            <button
              onClick={(e) => { e.stopPropagation(); cancelOrder(order.id) }}
              className="ml-1 text-red-400 hover:text-red-300"
              title="Cancel Order"
            >✕</button>
            <span className="text-gray-500 text-[9px] opacity-0 group-hover:opacity-100">⇕ drag</span>
          </div>
        </div>
      )
    })
  }

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 z-10 overflow-hidden ${dragging ? 'cursor-ns-resize' : 'pointer-events-none'}`}
      style={{ pointerEvents: dragging ? 'auto' : 'none' }}
    >
      {renderPositionLabels()}
      {renderOrderLabels()}

      {/* Drag indicator line */}
      {dragging && dragPrice && (
        <div
          className="absolute left-0 right-0 border-t border-dashed pointer-events-none"
          style={{
            top: `${priceToY(dragPrice)}px`,
            borderColor: dragging.type === 'sl' ? '#ff4976' : dragging.type === 'tp' ? '#4caf50' : '#ffab00',
            opacity: 0.8,
          }}
        >
          <span className="absolute right-2 -top-3 text-[10px] text-white bg-[#1a1a2e] px-1 rounded">
            ${formatPrice(dragPrice)}
          </span>
        </div>
      )}
    </div>
  )
}

export default DraggableLines
