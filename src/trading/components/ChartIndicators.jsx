/**
 * ChartIndicators - Renders technical indicators on the lightweight-chart
 * Manages indicator line series and pane series (RSI, MACD)
 * Recomputes only when candles or indicator settings change
 */
import { useEffect, useRef } from 'react'
import { LineStyle } from 'lightweight-charts'
import useChartStore from '../stores/chartStore'
import { calcEMA, calcVWAP, calcRSI, calcMACD, calcBollinger, calcATR, calcSupertrend } from '../utils/indicators'

// Indicator color palette
const COLORS = {
  ema9: '#f7931a',
  ema21: '#2962ff',
  ema55: '#e040fb',
  vwap: '#ffeb3b',
  rsi: '#b39ddb',
  macdLine: '#2196f3',
  macdSignal: '#ff9800',
  bollUpper: 'rgba(33, 150, 243, 0.5)',
  bollMiddle: 'rgba(33, 150, 243, 0.8)',
  bollLower: 'rgba(33, 150, 243, 0.5)',
  atr: '#26c6da',
  supertrendUp: '#26a69a',
  supertrendDown: '#ef5350',
}

function ChartIndicators() {
  const seriesRefs = useRef({}) // Store created series for cleanup
  const candles = useChartStore(s => s.candles)
  const activeIndicators = useChartStore(s => s.activeIndicators)
  const indicatorSettings = useChartStore(s => s.indicatorSettings)

  useEffect(() => {
    const chart = useChartStore.getState().chartRef
    const mainSeries = useChartStore.getState().seriesRef
    if (!chart || !mainSeries || candles.length < 2) return

    // Remove old indicator series
    Object.values(seriesRefs.current).forEach(series => {
      try {
        if (Array.isArray(series)) {
          series.forEach(s => chart.removeSeries(s))
        } else {
          chart.removeSeries(series)
        }
      } catch (e) {}
    })
    seriesRefs.current = {}

    // ===== EMA =====
    if (activeIndicators.includes('ema')) {
      const periods = indicatorSettings.ema?.periods || [9, 21, 55]
      const colors = [COLORS.ema9, COLORS.ema21, COLORS.ema55]
      const emaSeries = []

      periods.forEach((period, idx) => {
        const data = calcEMA(candles, period)
        if (data.length === 0) return

        const series = chart.addLineSeries({
          color: colors[idx] || COLORS.ema9,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          title: `EMA ${period}`,
        })
        series.setData(data)
        emaSeries.push(series)
      })

      seriesRefs.current.ema = emaSeries
    }

    // ===== VWAP =====
    if (activeIndicators.includes('vwap')) {
      const data = calcVWAP(candles)
      if (data.length > 0) {
        const series = chart.addLineSeries({
          color: COLORS.vwap,
          lineWidth: 2,
          lineStyle: LineStyle.Dotted,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'VWAP',
        })
        series.setData(data)
        seriesRefs.current.vwap = series
      }
    }

    // ===== RSI =====
    if (activeIndicators.includes('rsi')) {
      const period = indicatorSettings.rsi?.period || 14
      const data = calcRSI(candles, period)
      if (data.length > 0) {
        const series = chart.addLineSeries({
          color: COLORS.rsi,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          title: `RSI ${period}`,
          priceScaleId: 'rsi',
        })

        chart.priceScale('rsi').applyOptions({
          scaleMargins: { top: 0.75, bottom: 0.02 },
          borderVisible: false,
        })

        series.setData(data)
        seriesRefs.current.rsi = series
      }
    }

    // ===== MACD =====
    if (activeIndicators.includes('macd')) {
      const { fast, slow, signal } = indicatorSettings.macd || { fast: 12, slow: 26, signal: 9 }
      const { macdLine, signalLine, histogram } = calcMACD(candles, fast, slow, signal)

      if (macdLine.length > 0) {
        const macdSeries = chart.addLineSeries({
          color: COLORS.macdLine,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          title: 'MACD',
          priceScaleId: 'macd',
        })
        const signalSeries = chart.addLineSeries({
          color: COLORS.macdSignal,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          title: 'Signal',
          priceScaleId: 'macd',
        })
        const histSeries = chart.addHistogramSeries({
          priceLineVisible: false,
          lastValueVisible: false,
          priceScaleId: 'macd',
        })

        chart.priceScale('macd').applyOptions({
          scaleMargins: { top: 0.85, bottom: 0.02 },
          borderVisible: false,
        })

        macdSeries.setData(macdLine)
        signalSeries.setData(signalLine)
        histSeries.setData(histogram)
        seriesRefs.current.macd = [macdSeries, signalSeries, histSeries]
      }
    }

    // ===== Bollinger Bands =====
    if (activeIndicators.includes('bollinger')) {
      const { period, stdDev } = indicatorSettings.bollinger || { period: 20, stdDev: 2 }
      const { upper, middle, lower } = calcBollinger(candles, period, stdDev)

      if (upper.length > 0) {
        const upperSeries = chart.addLineSeries({
          color: COLORS.bollUpper,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
          title: `BB ${period}`,
        })
        const middleSeries = chart.addLineSeries({
          color: COLORS.bollMiddle,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        })
        const lowerSeries = chart.addLineSeries({
          color: COLORS.bollLower,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        })

        upperSeries.setData(upper)
        middleSeries.setData(middle)
        lowerSeries.setData(lower)
        seriesRefs.current.bollinger = [upperSeries, middleSeries, lowerSeries]
      }
    }

    // ===== ATR =====
    if (activeIndicators.includes('atr')) {
      const period = indicatorSettings.atr?.period || 14
      const data = calcATR(candles, period)
      if (data.length > 0) {
        const series = chart.addLineSeries({
          color: COLORS.atr,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          title: `ATR ${period}`,
          priceScaleId: 'atr',
        })

        chart.priceScale('atr').applyOptions({
          scaleMargins: { top: 0.9, bottom: 0.02 },
          borderVisible: false,
        })

        series.setData(data)
        seriesRefs.current.atr = series
      }
    }

    // ===== Supertrend =====
    if (activeIndicators.includes('supertrend')) {
      const { period, multiplier } = indicatorSettings.supertrend || { period: 10, multiplier: 3 }
      const data = calcSupertrend(candles, period, multiplier)
      if (data.length > 0) {
        // Split into green and red segments for coloring
        // Use two line series - one for up, one for down
        const upData = []
        const downData = []
        
        data.forEach((point, idx) => {
          if (point.color === '#26a69a') {
            upData.push({ time: point.time, value: point.value })
            // Bridge: add NaN-like gap to down series
            downData.push({ time: point.time, value: point.value })
          } else {
            downData.push({ time: point.time, value: point.value })
            upData.push({ time: point.time, value: point.value })
          }
        })

        // Single line with color change per segment (use the last color for simplicity)
        // lightweight-charts doesn't support per-point colors on line series
        // So we overlay both and use createLineSeries with different data segments
        const stSeries = chart.addLineSeries({
          color: COLORS.supertrendUp,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          title: `ST ${period}/${multiplier}`,
        })
        
        // Set all data (single color - use the dominant trend color of last point)
        const lastColor = data[data.length - 1]?.color || COLORS.supertrendUp
        stSeries.applyOptions({ color: lastColor })
        stSeries.setData(data.map(d => ({ time: d.time, value: d.value })))
        
        seriesRefs.current.supertrend = stSeries
      }
    }

    // Cleanup on unmount
    return () => {
      Object.values(seriesRefs.current).forEach(series => {
        try {
          if (Array.isArray(series)) {
            series.forEach(s => chart.removeSeries(s))
          } else {
            chart.removeSeries(series)
          }
        } catch (e) {}
      })
      seriesRefs.current = {}
    }
  }, [candles, activeIndicators, indicatorSettings])

  // This component renders nothing - it only manages chart series
  return null
}

export default ChartIndicators
