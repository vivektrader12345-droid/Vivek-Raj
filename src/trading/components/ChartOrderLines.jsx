/**
 * ChartOrderLines - Renders price lines on the lightweight-charts for:
 * - Open position entry lines (green BUY / red SELL)
 * - Stop Loss lines (red dashed, draggable)
 * - Take Profit lines (green dashed, draggable)
 * - Liquidation lines (purple dotted)
 * - Pending limit/stop order lines (yellow dashed)
 * - Current price line
 *
 * Uses lightweight-charts createPriceLine API on the candle series.
 * Lines are updated reactively via Zustand subscriptions.
 */
import { useEffect, useRef, useCallback } from 'react'
import { LineStyle } from 'lightweight-charts'
import useChartStore from '../stores/chartStore'
import useTradingStore from '../stores/tradingStore'
import useSettingsStore from '../stores/settingsStore'
import { OrderSide, formatPrice } from '../types'

// Line color constants
const LINE_COLORS = {
  entryBuy: '#26a69a',
  entrySell: '#ef5350',
  stopLoss: '#ff4976',
  takeProfit: '#4caf50',
  liquidation: '#9c27b0',
  limitBuy: '#ffab00',
  limitSell: '#ff6d00',
  currentPrice: '#2196f3',
}

function ChartOrderLines() {
  const priceLinesRef = useRef(new Map()) // Map<id, priceLine>
  const dragStateRef = useRef(null)

  const { seriesRef: series } = useChartStore.getState()
  const { showOrderLines, showPositionLines, showLiquidationLine } = useSettingsStore()

  // Get the candle series from the chart store
  const getSeries = () => useChartStore.getState().seriesRef

  /**
   * Remove all existing price lines
   */
  const clearAllLines = useCallback(() => {
    const candleSeries = getSeries()
    if (!candleSeries) return
    
    priceLinesRef.current.forEach((line, key) => {
      try {
        candleSeries.removePriceLine(line)
      } catch (e) {
        // Line may already be removed
      }
    })
    priceLinesRef.current.clear()
  }, [])

  /**
   * Create or update a price line
   */
  const upsertLine = useCallback((id, options) => {
    const candleSeries = getSeries()
    if (!candleSeries) return

    // Remove existing line with this id
    if (priceLinesRef.current.has(id)) {
      try {
        candleSeries.removePriceLine(priceLinesRef.current.get(id))
      } catch (e) {}
    }

    // Create new line
    const line = candleSeries.createPriceLine({
      price: options.price,
      color: options.color,
      lineWidth: options.lineWidth || 1,
      lineStyle: options.lineStyle || LineStyle.Solid,
      axisLabelVisible: true,
      title: options.title || '',
      lineVisible: true,
      axisLabelColor: options.color,
      axisLabelTextColor: '#ffffff',
    })

    priceLinesRef.current.set(id, line)
    return line
  }, [])

  /**
   * Remove a specific line
   */
  const removeLine = useCallback((id) => {
    const candleSeries = getSeries()
    if (!candleSeries || !priceLinesRef.current.has(id)) return

    try {
      candleSeries.removePriceLine(priceLinesRef.current.get(id))
    } catch (e) {}
    priceLinesRef.current.delete(id)
  }, [])

  /**
   * Render all position lines (entry, SL, TP, liquidation)
   */
  const renderPositionLines = useCallback(() => {
    const { positions } = useTradingStore.getState()
    
    if (!showPositionLines) return

    positions.forEach((pos) => {
      // Entry line
      const entryColor = pos.side === OrderSide.BUY ? LINE_COLORS.entryBuy : LINE_COLORS.entrySell
      const sideLabel = pos.side === OrderSide.BUY ? 'BUY' : 'SELL'
      
      upsertLine(`entry_${pos.id}`, {
        price: pos.entryPrice,
        color: entryColor,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        title: `${sideLabel} ${pos.qty} × ${pos.leverage}x | Entry $${formatPrice(pos.entryPrice)}`,
      })

      // Stop Loss line
      if (pos.stopLoss) {
        upsertLine(`sl_${pos.id}`, {
          price: pos.stopLoss,
          color: LINE_COLORS.stopLoss,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: `SL $${formatPrice(pos.stopLoss)}`,
        })
      }

      // Take Profit line
      if (pos.takeProfit) {
        upsertLine(`tp_${pos.id}`, {
          price: pos.takeProfit,
          color: LINE_COLORS.takeProfit,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: `TP $${formatPrice(pos.takeProfit)}`,
        })
      }

      // Liquidation line
      if (pos.liquidationPrice && showLiquidationLine) {
        upsertLine(`liq_${pos.id}`, {
          price: pos.liquidationPrice,
          color: LINE_COLORS.liquidation,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          title: `LIQ $${formatPrice(pos.liquidationPrice)}`,
        })
      }
    })
  }, [showPositionLines, showLiquidationLine, upsertLine])

  /**
   * Render pending order lines (limit/stop)
   */
  const renderOrderLines = useCallback(() => {
    const { pendingOrders } = useTradingStore.getState()
    
    if (!showOrderLines) return

    pendingOrders.forEach((order) => {
      const color = order.side === OrderSide.BUY ? LINE_COLORS.limitBuy : LINE_COLORS.limitSell
      const typeLabel = order.type.toUpperCase()
      const sideLabel = order.side.toUpperCase()

      upsertLine(`order_${order.id}`, {
        price: order.price,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        title: `${typeLabel} ${sideLabel} ${order.qty} @ $${formatPrice(order.price)} (${order.leverage}x) [PENDING]`,
      })
    })
  }, [showOrderLines, upsertLine])

  /**
   * Full re-render of all lines
   */
  const renderAllLines = useCallback(() => {
    clearAllLines()
    renderPositionLines()
    renderOrderLines()
  }, [clearAllLines, renderPositionLines, renderOrderLines])

  // Subscribe to trading store changes
  useEffect(() => {
    // Initial render (with a small delay to ensure chart is ready)
    const timer = setTimeout(renderAllLines, 500)

    // Subscribe to store changes
    const unsubTrading = useTradingStore.subscribe(
      (state) => ({ positions: state.positions, pendingOrders: state.pendingOrders }),
      () => {
        // Debounce re-renders slightly
        requestAnimationFrame(renderAllLines)
      },
      { equalityFn: (a, b) => a === b }
    )

    // Full re-subscribe (simpler approach for zustand)
    const unsubTradingFull = useTradingStore.subscribe(() => {
      requestAnimationFrame(renderAllLines)
    })

    return () => {
      clearTimeout(timer)
      unsubTradingFull()
      clearAllLines()
    }
  }, [renderAllLines, clearAllLines])

  // Re-render when settings change
  useEffect(() => {
    renderAllLines()
  }, [showOrderLines, showPositionLines, showLiquidationLine])

  // This component renders nothing to DOM - it only manages chart price lines
  return null
}

export default ChartOrderLines
