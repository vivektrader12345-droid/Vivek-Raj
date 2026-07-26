import React, { useEffect, useRef, useState } from 'react'
import { createChart } from 'lightweight-charts'

/**
 * Professional Candlestick chart using TradingView Lightweight Charts
 * - Real-time candle updates via Binance WebSocket
 * - Position lines fixed at exact entry price
 * - Live P&L display on the line
 */
function LiveCandleChart({ symbol = 'BTCUSDT', timeframe = '1m', positions = [], currentPrice = 0, height = 500, theme = 'dark' }) {
  const chartContainerRef = useRef(null)
  const chartRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const wsRef = useRef(null)
  const positionLinesRef = useRef([])

  // Create chart
  useEffect(() => {
    if (!chartContainerRef.current) return

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: height,
      layout: {
        background: { type: 'solid', color: theme === 'dark' ? '#060612' : '#ffffff' },
        textColor: theme === 'dark' ? '#9ca3af' : '#1a1a2e',
      },
      grid: {
        vertLines: { color: theme === 'dark' ? '#1a1a3e' : '#f0f0f0' },
        horzLines: { color: theme === 'dark' ? '#1a1a3e' : '#f0f0f0' },
      },
      crosshair: { mode: 0 },
      rightPriceScale: {
        borderColor: theme === 'dark' ? '#2a2a5a' : '#e0e0e0',
      },
      timeScale: {
        borderColor: theme === 'dark' ? '#2a2a5a' : '#e0e0e0',
        timeVisible: true,
        secondsVisible: false,
      },
    })

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00d68f',
      downColor: '#ff3d71',
      borderUpColor: '#00d68f',
      borderDownColor: '#ff3d71',
      wickUpColor: '#00d68f',
      wickDownColor: '#ff3d71',
    })

    chartRef.current = chart
    candleSeriesRef.current = candleSeries

    // Handle resize
    const handleResize = () => {
      chart.applyOptions({ width: chartContainerRef.current.clientWidth })
    }
    window.addEventListener('resize', handleResize)

    // Fetch historical data
    fetchHistoricalCandles()

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
    }
  }, [symbol, theme, height])

  // Fetch historical candles from Binance
  const fetchHistoricalCandles = async () => {
    try {
      const binSymbol = symbol.replace('/', '')
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binSymbol}&interval=${timeframe}&limit=200`)
      const data = await res.json()
      if (Array.isArray(data) && candleSeriesRef.current) {
        const candles = data.map(k => ({
          time: Math.floor(k[0] / 1000),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
        }))
        candleSeriesRef.current.setData(candles)
      }
    } catch (e) {
      console.log('Historical fetch error:', e)
    }
  }

  // WebSocket for real-time updates
  useEffect(() => {
    if (wsRef.current) wsRef.current.close()

    const binSymbol = symbol.replace('/', '').toLowerCase()
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${binSymbol}@kline_${timeframe}`)
    wsRef.current = ws

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.k && candleSeriesRef.current) {
          const k = msg.k
          candleSeriesRef.current.update({
            time: Math.floor(k.t / 1000),
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
          })
        }
      } catch (e) {}
    }

    return () => { if (ws) ws.close() }
  }, [symbol, timeframe])

  // Draw position lines at exact entry prices
  useEffect(() => {
    if (!candleSeriesRef.current) return

    // Remove old lines
    positionLinesRef.current.forEach(line => {
      try { candleSeriesRef.current.removePriceLine(line) } catch(e) {}
    })
    positionLinesRef.current = []

    // Add new lines for each position
    positions.forEach(pos => {
      if (!pos.entryPrice) return
      const pnl = pos.side === 'buy'
        ? (currentPrice - pos.entryPrice) * pos.qty * (pos.leverage || 1)
        : (pos.entryPrice - currentPrice) * pos.qty * (pos.leverage || 1)
      const isProfit = pnl >= 0

      const line = candleSeriesRef.current.createPriceLine({
        price: pos.entryPrice,
        color: isProfit ? '#3b82f6' : '#f97316',
        lineWidth: 2,
        lineStyle: 2, // Dashed
        axisLabelVisible: true,
        title: `${pos.side.toUpperCase()} ${pos.qty} | ${isProfit ? '+' : ''}${pnl.toFixed(2)} USD (${isProfit ? '+' : ''}${((pnl / (pos.entryPrice * pos.qty)) * 100).toFixed(2)}%)`,
      })
      positionLinesRef.current.push(line)
    })
  }, [positions, currentPrice])

  // Refetch when timeframe changes
  useEffect(() => {
    fetchHistoricalCandles()
  }, [timeframe])

  return (
    <div ref={chartContainerRef} className="w-full rounded-xl overflow-hidden" />
  )
}

export default LiveCandleChart
