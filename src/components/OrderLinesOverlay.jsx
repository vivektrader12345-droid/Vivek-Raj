import React, { useState, useEffect } from 'react'

/**
 * Shows pending limit/stop orders on chart as horizontal price lines
 * Similar to PositionsOverlay but for unfilled orders
 */
function OrderLinesOverlay({ currentPrice = 0, chartHeight = 600 }) {
  const [pendingOrders, setPendingOrders] = useState([])

  useEffect(() => {
    const update = () => {
      const saved = localStorage.getItem('vmt_demo_pending_orders')
      setPendingOrders(saved ? JSON.parse(saved) : [])
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [])

  const cancelOrder = (orderId) => {
    const saved = JSON.parse(localStorage.getItem('vmt_demo_pending_orders') || '[]')
    const updated = saved.filter(o => o.id !== orderId)
    localStorage.setItem('vmt_demo_pending_orders', JSON.stringify(updated))
    setPendingOrders(updated)
  }

  if (pendingOrders.length === 0 || !currentPrice) return null

  // Calculate price range for positioning (same logic as PositionsOverlay)
  const priceRange = currentPrice * 0.01 // 1% total range visible
  const topPrice = currentPrice + priceRange / 2
  const bottomPrice = currentPrice - priceRange / 2
  const usableHeight = chartHeight - 120

  const priceToY = (price) => {
    const ratio = (topPrice - price) / priceRange
    const y = 60 + ratio * usableHeight
    return Math.max(40, Math.min(chartHeight - 40, y))
  }

  return (
    <div className="absolute inset-0 z-[9] pointer-events-none overflow-hidden">
      {pendingOrders.map((order) => {
        const yPos = priceToY(order.price)
        const isBuy = order.side === 'buy'
        const distancePercent = ((order.price - currentPrice) / currentPrice * 100).toFixed(2)

        return (
          <div key={order.id} className="absolute left-0 right-0" style={{ top: `${yPos}px` }}>
            {/* Dotted line at order price */}
            <div className={`w-full border-t-[1.5px] border-dotted ${isBuy ? 'border-emerald-400/70' : 'border-red-400/70'}`}></div>

            {/* Order info badge on left */}
            <div className="absolute left-[40px] -top-[12px] pointer-events-auto flex items-center">
              {/* Order type icon */}
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[8px] font-bold text-white shadow-md ${isBuy ? 'bg-emerald-500' : 'bg-red-500'}`}>
                {order.orderType === 'limit' ? 'L' : 'S'}
              </div>

              {/* Info box */}
              <div className={`flex items-center gap-1.5 px-2 py-1 text-[10px] rounded-r-md border-y border-r shadow-md ${
                isBuy ? 'bg-[#0a1f14]/95 border-emerald-500/40' : 'bg-[#1f0a0a]/95 border-red-500/40'
              }`}>
                <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${isBuy ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                  {order.side.toUpperCase()} {order.orderType.toUpperCase()}
                </span>
                <span className="text-gray-300">{order.qty} × ${order.price.toFixed(2)}</span>
                <span className="text-gray-500">({order.leverage}x)</span>
                <span className={`text-[9px] ${parseFloat(distancePercent) >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                  {distancePercent > 0 ? '+' : ''}{distancePercent}%
                </span>
                <button onClick={() => cancelOrder(order.id)}
                  className="text-gray-400 hover:text-red-400 cursor-pointer ml-0.5 text-xs">✕</button>
              </div>
            </div>

            {/* Price label on right side */}
            <div className={`absolute right-0 -top-[10px] px-1.5 py-0.5 text-[9px] font-bold rounded-l ${isBuy ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white'}`}>
              {order.price.toFixed(2)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default OrderLinesOverlay
