/**
 * TradeMarkers - Renders buy/sell markers on chart for closed trades
 * Uses lightweight-charts setMarkers API to show trade entry/exit arrows
 */
import { useEffect } from 'react'
import useChartStore from '../stores/chartStore'
import useTradingStore from '../stores/tradingStore'
import useSettingsStore from '../stores/settingsStore'

function TradeMarkers() {
  const trades = useTradingStore(s => s.trades)
  const { showTradeMarkers } = useSettingsStore()

  useEffect(() => {
    const series = useChartStore.getState().seriesRef
    if (!series || !showTradeMarkers) {
      if (series) series.setMarkers([])
      return
    }

    // Build markers from trade history
    const markers = []

    trades.forEach(trade => {
      // Entry marker
      const entryTime = Math.floor(trade.openedAt / 1000)
      markers.push({
        time: entryTime,
        position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: trade.side === 'buy' ? '#26a69a' : '#ef5350',
        shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: `${trade.side.toUpperCase()} $${trade.entryPrice.toFixed(2)}`,
        size: 1,
      })

      // Exit marker
      if (trade.closedAt) {
        const exitTime = Math.floor(trade.closedAt / 1000)
        const isProfit = trade.netPnl >= 0
        markers.push({
          time: exitTime,
          position: trade.side === 'buy' ? 'aboveBar' : 'belowBar',
          color: isProfit ? '#4caf50' : '#ff4976',
          shape: trade.side === 'buy' ? 'arrowDown' : 'arrowUp',
          text: `Close ${isProfit ? '+' : ''}$${trade.netPnl.toFixed(2)}`,
          size: 1,
        })
      }
    })

    // Sort markers by time (required by lightweight-charts)
    markers.sort((a, b) => a.time - b.time)

    try {
      series.setMarkers(markers)
    } catch (e) {
      // Markers may fail if times are outside visible range
    }
  }, [trades, showTradeMarkers])

  return null
}

export default TradeMarkers
