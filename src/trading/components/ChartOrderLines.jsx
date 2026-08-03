import { useEffect, useRef } from 'react'
import { LineStyle } from 'lightweight-charts'
import useChartStore from '../stores/chartStore'
import useTradingStore from '../stores/tradingStore'
import useSettingsStore from '../stores/settingsStore'
import { OrderSide, formatPrice } from '../types'

const normalizeSymbol = value => String(value || '').replace('/', '').toUpperCase()

function ChartOrderLines() {
  const series = useChartStore(state => state.seriesRef)
  const symbol = useChartStore(state => state.symbol)
  const pendingOrders = useTradingStore(state => state.pendingOrders)
  const positions = useTradingStore(state => state.positions)
  const showOrderLines = useSettingsStore(state => state.showOrderLines)
  const showLiquidationLine = useSettingsStore(state => state.showLiquidationLine)
  const linesRef = useRef(new Map())

  useEffect(() => {
    if (!series) return undefined
    const wanted = new Map()
    if (showOrderLines) {
      pendingOrders.filter(order => normalizeSymbol(order.symbol) === normalizeSymbol(symbol)).forEach(order => {
        const color = order.side === OrderSide.BUY ? '#ffab00' : '#ff6d00'
        wanted.set(`order_${order.id}`, {
          price: order.price,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          lineVisible: true,
          title: `${order.type.toUpperCase()} ${order.side.toUpperCase()} ${order.qty} @ ${formatPrice(order.price)}`,
          axisLabelColor: color,
          axisLabelTextColor: '#ffffff',
        })
      })
    }
    if (showLiquidationLine) {
      positions.filter(position => normalizeSymbol(position.symbol) === normalizeSymbol(symbol) && position.liquidationPrice).forEach(position => {
        wanted.set(`liq_${position.id}`, {
          price: position.liquidationPrice,
          color: '#9c27b0',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          lineVisible: true,
          title: `LIQ ${formatPrice(position.liquidationPrice)}`,
          axisLabelColor: '#9c27b0',
          axisLabelTextColor: '#ffffff',
        })
      })
    }

    linesRef.current.forEach((line, id) => {
      if (!wanted.has(id)) {
        try { series.removePriceLine(line) } catch {}
        linesRef.current.delete(id)
      }
    })
    wanted.forEach((options, id) => {
      const existing = linesRef.current.get(id)
      if (existing) existing.applyOptions(options)
      else linesRef.current.set(id, series.createPriceLine(options))
    })

    return undefined
  }, [pendingOrders, positions, series, showLiquidationLine, showOrderLines, symbol])

  useEffect(() => () => {
    if (series) linesRef.current.forEach(line => { try { series.removePriceLine(line) } catch {} })
    linesRef.current.clear()
  }, [series])

  return null
}

export default ChartOrderLines
