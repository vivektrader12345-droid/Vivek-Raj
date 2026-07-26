/**
 * PnLOverlay - Live PnL display on chart
 * Shows floating PnL box between entry and current price for each open position
 * Updates every tick without lag - uses Zustand subscriptions directly
 */
import React from 'react'
import useTradingStore from '../stores/tradingStore'
import useChartStore from '../stores/chartStore'
import useSettingsStore from '../stores/settingsStore'
import { OrderSide, formatPrice, formatPnL, formatROI, formatDuration } from '../types'

function PnLOverlay() {
  const positions = useTradingStore(s => s.positions)
  const currentPrice = useTradingStore(s => s.currentPrice)
  const { showPnlOverlay, showFloatingPnl } = useSettingsStore()

  if (!showPnlOverlay || positions.length === 0 || !currentPrice) return null

  // Convert price to Y coordinate using chart series
  const priceToY = (price) => {
    const series = useChartStore.getState().seriesRef
    if (!series) return null
    try {
      return series.priceToCoordinate(price)
    } catch {
      return null
    }
  }

  return (
    <div className="absolute inset-0 z-[8] pointer-events-none overflow-hidden">
      {positions.map(pos => {
        const entryY = priceToY(pos.entryPrice)
        const currentY = priceToY(currentPrice)

        if (entryY == null || currentY == null) return null

        const isProfit = pos.unrealizedPnl >= 0
        const topY = Math.min(entryY, currentY)
        const height = Math.abs(currentY - entryY)

        // Don't render if too small
        if (height < 5) return null

        // Position the floating PnL box between entry and current price
        const midY = topY + height / 2

        return (
          <React.Fragment key={pos.id}>
            {/* Shaded area between entry and current price */}
            <div
              className="absolute right-[52px] left-[40px] transition-all duration-75"
              style={{
                top: `${topY}px`,
                height: `${height}px`,
                background: isProfit
                  ? 'linear-gradient(180deg, rgba(38, 166, 154, 0.06) 0%, rgba(38, 166, 154, 0.12) 100%)'
                  : 'linear-gradient(180deg, rgba(239, 83, 80, 0.06) 0%, rgba(239, 83, 80, 0.12) 100%)',
                borderLeft: `1px solid ${isProfit ? 'rgba(38, 166, 154, 0.3)' : 'rgba(239, 83, 80, 0.3)'}`,
                borderRight: `1px solid ${isProfit ? 'rgba(38, 166, 154, 0.3)' : 'rgba(239, 83, 80, 0.3)'}`,
              }}
            />

            {/* Floating PnL Box */}
            {showFloatingPnl && height > 30 && (
              <div
                className="absolute right-[60px] pointer-events-auto transition-all duration-75"
                style={{ top: `${midY - 28}px` }}
              >
                <div className={`px-3 py-1.5 rounded-lg border shadow-lg backdrop-blur-sm ${
                  isProfit
                    ? 'bg-[#0a2420]/90 border-[#26a69a]/40'
                    : 'bg-[#240a0a]/90 border-[#ef5350]/40'
                }`}>
                  {/* PnL Amount */}
                  <div className={`text-sm font-bold ${isProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
                    {formatPnL(pos.unrealizedPnl)}
                  </div>
                  {/* ROI */}
                  <div className={`text-[10px] font-medium ${isProfit ? 'text-[#26a69a]/80' : 'text-[#ef5350]/80'}`}>
                    {formatROI(pos.roi)}
                  </div>
                  {/* Current Price */}
                  <div className="text-[9px] text-gray-400">
                    ${formatPrice(currentPrice)}
                  </div>
                </div>
              </div>
            )}
          </React.Fragment>
        )
      })}

      {/* Aggregate PnL Panel - Top Right Corner */}
      {positions.length > 0 && (
        <LivePnLPanel positions={positions} currentPrice={currentPrice} />
      )}
    </div>
  )
}

/**
 * LivePnLPanel - Shows detailed live PnL for all positions
 * Positioned at the top-right of the chart
 */
function LivePnLPanel({ positions, currentPrice }) {
  const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
  const totalMargin = positions.reduce((sum, p) => sum + p.margin, 0)
  const totalROI = totalMargin > 0 ? (totalUnrealizedPnl / totalMargin) * 100 : 0
  const totalFees = positions.reduce((sum, p) => sum + p.totalFees, 0)
  const totalFunding = positions.reduce((sum, p) => sum + p.fundingFee, 0)
  const isProfit = totalUnrealizedPnl >= 0

  return (
    <div className="absolute top-12 right-2 pointer-events-auto">
      <div className={`px-3 py-2 rounded-lg border backdrop-blur-sm ${
        isProfit ? 'bg-[#0a2420]/80 border-[#26a69a]/30' : 'bg-[#240a0a]/80 border-[#ef5350]/30'
      }`}>
        <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">Unrealized P&L</div>
        <div className={`text-lg font-bold leading-tight ${isProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
          {formatPnL(totalUnrealizedPnl)}
        </div>
        <div className={`text-xs font-medium ${isProfit ? 'text-[#26a69a]/70' : 'text-[#ef5350]/70'}`}>
          {formatROI(totalROI)}
        </div>
        <div className="mt-1 pt-1 border-t border-gray-700/30 space-y-0.5">
          <div className="flex justify-between text-[9px]">
            <span className="text-gray-500">Mark Price</span>
            <span className="text-gray-300">${formatPrice(currentPrice)}</span>
          </div>
          <div className="flex justify-between text-[9px]">
            <span className="text-gray-500">Positions</span>
            <span className="text-gray-300">{positions.length}</span>
          </div>
          <div className="flex justify-between text-[9px]">
            <span className="text-gray-500">Margin Used</span>
            <span className="text-gray-300">${totalMargin.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-[9px]">
            <span className="text-gray-500">Fees</span>
            <span className="text-gray-300">-${totalFees.toFixed(2)}</span>
          </div>
          {totalFunding > 0 && (
            <div className="flex justify-between text-[9px]">
              <span className="text-gray-500">Funding</span>
              <span className="text-gray-300">-${totalFunding.toFixed(4)}</span>
            </div>
          )}
          {positions.map(pos => (
            <div key={pos.id} className="flex justify-between text-[9px] pt-0.5">
              <span className={pos.side === OrderSide.BUY ? 'text-[#26a69a]' : 'text-[#ef5350]'}>
                {pos.side === OrderSide.BUY ? '▲' : '▼'} {pos.qty}×{pos.leverage}x
              </span>
              <span className={pos.unrealizedPnl >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'}>
                {formatPnL(pos.unrealizedPnl)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default PnLOverlay
