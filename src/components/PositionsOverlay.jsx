import React, { useState, useEffect } from 'react'

/**
 * Shows open positions on chart at their entry price level
 * Calculates Y position based on price relative to current price
 */
function PositionsOverlay({ currentPrice = 0, chartHeight = 600 }) {
  const [positions, setPositions] = useState([])

  useEffect(() => {
    const update = () => {
      const saved = localStorage.getItem('vmt_demo_positions')
      setPositions(saved ? JSON.parse(saved) : [])
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [])

  const closePosition = (pos, pnl) => {
    const saved = JSON.parse(localStorage.getItem('vmt_demo_positions') || '[]')
    const updated = saved.filter(p => p.id !== pos.id)
    localStorage.setItem('vmt_demo_positions', JSON.stringify(updated))

    const history = JSON.parse(localStorage.getItem('vmt_demo_history') || '[]')
    history.unshift({ ...pos, exitPrice: currentPrice, pnl: parseFloat(pnl.toFixed(2)), closedAt: new Date().toISOString() })
    localStorage.setItem('vmt_demo_history', JSON.stringify(history))

    const balance = parseFloat(localStorage.getItem('vmt_demo_balance') || '100000')
    localStorage.setItem('vmt_demo_balance', (balance + (pos.margin || 0) + pnl).toString())
    setPositions(updated)
  }

  if (positions.length === 0 || !currentPrice) return null

  // Calculate price range for positioning
  // Current price is at ~middle of chart, each pixel = some price
  // Visible range: assume chart shows ±0.5% from current price
  const priceRange = currentPrice * 0.01 // 1% total range visible
  const topPrice = currentPrice + priceRange / 2
  const bottomPrice = currentPrice - priceRange / 2
  const usableHeight = chartHeight - 120 // minus header/footer

  // Convert price to Y position (0 = top, usableHeight = bottom)
  const priceToY = (price) => {
    const ratio = (topPrice - price) / priceRange
    const y = 60 + ratio * usableHeight // 60px offset from top
    return Math.max(40, Math.min(chartHeight - 40, y))
  }

  return (
    <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
      {positions.map((pos) => {
        const pnl = pos.side === 'buy'
          ? (currentPrice - pos.entryPrice) * pos.qty * (pos.leverage || 1)
          : (pos.entryPrice - currentPrice) * pos.qty * (pos.leverage || 1)
        const isProfit = pnl >= 0
        const pnlPercent = pos.entryPrice > 0
          ? ((pos.side === 'buy' ? (currentPrice - pos.entryPrice) : (pos.entryPrice - currentPrice)) / pos.entryPrice * 100 * (pos.leverage || 1)).toFixed(2)
          : '0'

        const yPos = priceToY(pos.entryPrice)

        return (
          <div key={pos.id} className="absolute left-0 right-0" style={{ top: `${yPos}px` }}>
            {/* Dashed line at entry price */}
            <div className={`w-full border-t-[1.5px] border-dashed ${isProfit ? 'border-blue-400/60' : 'border-orange-400/60'}`}></div>

            {/* P&L Badge positioned on left side */}
            <div className="absolute left-[40px] -top-[12px] pointer-events-auto flex items-center">
              {/* Qty circle */}
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white shadow-md ${isProfit ? 'bg-blue-500' : 'bg-orange-500'}`}>
                {pos.qty >= 1 ? pos.qty : pos.qty.toFixed(2)}
              </div>

              {/* Info box */}
              <div className={`flex items-center gap-1.5 px-2 py-1 text-[10px] rounded-r-md border-y border-r shadow-md ${
                isProfit ? 'bg-[#0a1628]/95 border-blue-500/40' : 'bg-[#28100a]/95 border-orange-500/40'
              }`}>
                <span className="text-gray-400">Entry: ${pos.entryPrice.toFixed(2)}</span>
                <span className={`font-bold ${isProfit ? 'text-blue-400' : 'text-orange-400'}`}>
                  {isProfit ? '+' : ''}{pnl.toFixed(2)} USD
                </span>
                <span className={`${isProfit ? 'text-blue-400/70' : 'text-orange-400/70'}`}>
                  ({isProfit ? '+' : ''}{pnlPercent}%)
                </span>
                <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${pos.side === 'buy' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                  {pos.side.toUpperCase()}
                </span>
                <button onClick={() => closePosition(pos, pnl)}
                  className="text-gray-400 hover:text-red-400 cursor-pointer ml-0.5">×</button>
              </div>
            </div>

            {/* Price label on right side */}
            <div className={`absolute right-0 -top-[10px] px-1.5 py-0.5 text-[9px] font-bold rounded-l ${isProfit ? 'bg-blue-500 text-white' : 'bg-orange-500 text-white'}`}>
              {pos.entryPrice.toFixed(2)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default PositionsOverlay
