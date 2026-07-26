/**
 * ProChart - Professional Trading Chart Component
 * Built on lightweight-charts with full programmatic control
 * Supports: Candles, Volume, Indicators, Order Lines, Trade Markers
 */
import React, { useEffect, useRef, useCallback, useState } from 'react'
import { createChart, CrosshairMode, LineStyle, PriceScaleMode } from 'lightweight-charts'
import useChartStore from '../stores/chartStore'
import useTradingStore from '../stores/tradingStore'
import useSettingsStore from '../stores/settingsStore'

// Chart color scheme (TradingView dark theme)
const COLORS = {
  bg: '#0a0a1a',
  grid: 'rgba(42, 42, 90, 0.15)',
  text: '#787b86',
  crosshair: '#758696',
  borderColor: '#1e1e3a',
  upColor: '#26a69a',
  downColor: '#ef5350',
  upWick: '#26a69a',
  downWick: '#ef5350',
  volumeUp: 'rgba(38, 166, 154, 0.3)',
  volumeDown: 'rgba(239, 83, 80, 0.3)',
}

function ProChart({ height = 'calc(100vh - 180px)' }) {
  const containerRef = useRef(null)
  const chartInstanceRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const volumeSeriesRef = useRef(null)
  const indicatorSeriesRefs = useRef({})
  const resizeObserverRef = useRef(null)

  const { candles, symbol, timeframe, setChartRef, setSeriesRef, setVolumeSeriesRef } = useChartStore()
  const { currentPrice } = useTradingStore()
  const { showGrid, showVolume, chartStyle } = useSettingsStore()

  // Crosshair data for tooltip
  const [crosshairData, setCrosshairData] = useState(null)

  // Initialize chart
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: {
        background: { type: 'solid', color: COLORS.bg },
        textColor: COLORS.text,
        fontSize: 12,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      },
      grid: {
        vertLines: { color: showGrid ? COLORS.grid : 'transparent' },
        horzLines: { color: showGrid ? COLORS.grid : 'transparent' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: COLORS.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#2a2a5a',
        },
        horzLine: {
          color: COLORS.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#2a2a5a',
        },
      },
      rightPriceScale: {
        borderColor: COLORS.borderColor,
        scaleMargins: { top: 0.1, bottom: 0.2 },
        autoScale: true,
      },
      timeScale: {
        borderColor: COLORS.borderColor,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 8,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    })

    // Candlestick series
    const candleSeries = chart.addCandlestickSeries({
      upColor: COLORS.upColor,
      downColor: COLORS.downColor,
      borderVisible: false,
      wickUpColor: COLORS.upWick,
      wickDownColor: COLORS.downWick,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })

    // Volume series
    const volumeSeries = chart.addHistogramSeries({
      color: COLORS.volumeUp,
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      scaleMargins: { top: 0.8, bottom: 0 },
    })

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    })

    // Store refs
    chartInstanceRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries
    setChartRef(chart)
    setSeriesRef(candleSeries)
    setVolumeSeriesRef(volumeSeries)

    // Crosshair move handler for OHLCV tooltip
    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.seriesData) {
        setCrosshairData(null)
        return
      }
      const candleData = param.seriesData.get(candleSeries)
      const volumeData = param.seriesData.get(volumeSeries)
      if (candleData) {
        setCrosshairData({
          time: param.time,
          open: candleData.open,
          high: candleData.high,
          low: candleData.low,
          close: candleData.close,
          volume: volumeData?.value || 0,
          isUp: candleData.close >= candleData.open,
        })
      }
    })

    // Resize observer
    resizeObserverRef.current = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        chart.applyOptions({ width, height })
      }
    })
    resizeObserverRef.current.observe(containerRef.current)

    return () => {
      resizeObserverRef.current?.disconnect()
      chart.remove()
      chartInstanceRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
    }
  }, []) // Only run once on mount

  // Update grid visibility
  useEffect(() => {
    if (!chartInstanceRef.current) return
    chartInstanceRef.current.applyOptions({
      grid: {
        vertLines: { color: showGrid ? COLORS.grid : 'transparent' },
        horzLines: { color: showGrid ? COLORS.grid : 'transparent' },
      },
    })
  }, [showGrid])

  // Update candle data
  useEffect(() => {
    if (!candleSeriesRef.current || candles.length === 0) return

    const candleData = candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }))

    const volumeData = candles.map(c => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? COLORS.volumeUp : COLORS.volumeDown,
    }))

    candleSeriesRef.current.setData(candleData)
    if (showVolume && volumeSeriesRef.current) {
      volumeSeriesRef.current.setData(volumeData)
    }
  }, [candles, showVolume])

  // Real-time candle update (single candle update, no re-render)
  useEffect(() => {
    if (!candleSeriesRef.current || !currentPrice || candles.length === 0) return

    const lastCandle = candles[candles.length - 1]
    if (!lastCandle) return

    // Update the last candle's close to current price
    candleSeriesRef.current.update({
      time: lastCandle.time,
      open: lastCandle.open,
      high: Math.max(lastCandle.high, currentPrice),
      low: Math.min(lastCandle.low, currentPrice),
      close: currentPrice,
    })
  }, [currentPrice])

  return (
    <div className="relative w-full" style={{ height }}>
      {/* OHLCV Legend Overlay */}
      <div className="absolute top-2 left-3 z-10 flex items-center gap-3 text-xs pointer-events-none">
        <span className="text-gray-400 font-medium">{useChartStore.getState().symbolDisplay}</span>
        <span className="text-gray-500">{timeframe.toUpperCase()}</span>
        {crosshairData ? (
          <>
            <span className="text-gray-400">O <span className={crosshairData.isUp ? 'text-[#26a69a]' : 'text-[#ef5350]'}>{crosshairData.open?.toFixed(2)}</span></span>
            <span className="text-gray-400">H <span className={crosshairData.isUp ? 'text-[#26a69a]' : 'text-[#ef5350]'}>{crosshairData.high?.toFixed(2)}</span></span>
            <span className="text-gray-400">L <span className={crosshairData.isUp ? 'text-[#26a69a]' : 'text-[#ef5350]'}>{crosshairData.low?.toFixed(2)}</span></span>
            <span className="text-gray-400">C <span className={crosshairData.isUp ? 'text-[#26a69a]' : 'text-[#ef5350]'}>{crosshairData.close?.toFixed(2)}</span></span>
            <span className="text-gray-400">V <span className="text-gray-300">{(crosshairData.volume || 0).toFixed(0)}</span></span>
          </>
        ) : candles.length > 0 ? (
          <>
            <span className="text-gray-400">O <span className="text-gray-300">{candles[candles.length-1]?.open?.toFixed(2)}</span></span>
            <span className="text-gray-400">H <span className="text-gray-300">{candles[candles.length-1]?.high?.toFixed(2)}</span></span>
            <span className="text-gray-400">L <span className="text-gray-300">{candles[candles.length-1]?.low?.toFixed(2)}</span></span>
            <span className="text-gray-400">C <span className="text-gray-300">{candles[candles.length-1]?.close?.toFixed(2)}</span></span>
          </>
        ) : null}
      </div>

      {/* Chart Container */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Loading Overlay */}
      {candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a1a]/80">
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-2 border-[#26a69a] border-t-transparent rounded-full animate-spin" />
            <span className="text-gray-400 text-sm">Loading chart data...</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default React.memo(ProChart)
