import React, { useEffect, useRef, useState } from 'react'

/**
 * Custom Candlestick Chart Component
 * Renders OHLC candles on a canvas for smooth performance
 */
function CandleChart({ data, width = '100%', height = 400, timeframe = '1m', livePrice = null, countdown = '' }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [dimensions, setDimensions] = useState({ w: 800, h: height })

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setDimensions({ w: containerRef.current.offsetWidth, h: height })
      }
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [height])

  useEffect(() => {
    if (!canvasRef.current || !data || data.length === 0) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const { w, h } = dimensions
    canvas.width = w * 2 // Retina
    canvas.height = h * 2
    ctx.scale(2, 2)

    // Clear
    ctx.fillStyle = '#0a0a1f'
    ctx.fillRect(0, 0, w, h)

    const padding = { top: 20, bottom: 40, left: 60, right: 20 }
    const chartW = w - padding.left - padding.right
    const chartH = h - padding.top - padding.bottom

    // Find min/max
    const allHighs = data.map(d => d.high)
    const allLows = data.map(d => d.low)
    const maxPrice = Math.max(...allHighs)
    const minPrice = Math.min(...allLows)
    const priceRange = maxPrice - minPrice || 1

    // Price to Y
    const priceToY = (price) => padding.top + chartH - ((price - minPrice) / priceRange * chartH)

    // Candle width
    const candleWidth = Math.max(2, (chartW / data.length) * 0.7)
    const gap = chartW / data.length

    // Grid lines
    ctx.strokeStyle = '#1a1a3e'
    ctx.lineWidth = 0.5
    const gridLines = 5
    for (let i = 0; i <= gridLines; i++) {
      const y = padding.top + (chartH / gridLines) * i
      ctx.beginPath()
      ctx.moveTo(padding.left, y)
      ctx.lineTo(w - padding.right, y)
      ctx.stroke()

      // Price labels
      const price = maxPrice - (priceRange / gridLines) * i
      ctx.fillStyle = '#6b7280'
      ctx.font = '10px Inter, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(price.toFixed(2), padding.left - 5, y + 3)
    }

    // Draw candles
    data.forEach((candle, i) => {
      const x = padding.left + i * gap + gap / 2
      const isGreen = candle.close >= candle.open
      const color = isGreen ? '#00d68f' : '#ff3d71'

      const openY = priceToY(candle.open)
      const closeY = priceToY(candle.close)
      const highY = priceToY(candle.high)
      const lowY = priceToY(candle.low)

      // Wick (high-low line)
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, highY)
      ctx.lineTo(x, lowY)
      ctx.stroke()

      // Body
      const bodyTop = Math.min(openY, closeY)
      const bodyHeight = Math.max(Math.abs(closeY - openY), 1)
      ctx.fillStyle = color
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight)

      // Time labels (every 10 candles)
      if (i % 10 === 0 && candle.time) {
        ctx.fillStyle = '#6b7280'
        ctx.font = '9px Inter, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(candle.time, x, h - padding.bottom + 15)
      }
    })

    // Current price line
    if (data.length > 0) {
      const lastCandle = data[data.length - 1]
      const displayPrice = livePrice || lastCandle.close
      const currentY = priceToY(displayPrice)
      const isGreen = displayPrice >= lastCandle.open
      const priceColor = isGreen ? '#00d68f' : '#ff3d71'

      // Dashed price line across chart
      ctx.strokeStyle = priceColor
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(padding.left, currentY)
      ctx.lineTo(w - padding.right, currentY)
      ctx.stroke()
      ctx.setLineDash([])

      // Price box (like TradingView)
      const priceText = displayPrice.toFixed(3)
      const boxW = 90
      const boxH = countdown ? 30 : 20
      const boxX = w - padding.right - boxW - 5
      const boxY = currentY - boxH / 2

      // Box background
      ctx.fillStyle = priceColor
      ctx.fillRect(boxX, boxY, boxW, boxH)

      // Price text
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 10px Inter, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(priceText, boxX + boxW / 2, boxY + (countdown ? 12 : 14))

      // Countdown timer below price
      if (countdown) {
        ctx.fillStyle = '#ffffff'
        ctx.font = '9px Inter, sans-serif'
        ctx.fillText(countdown, boxX + boxW / 2, boxY + 24)
      }
    }

  }, [data, dimensions, livePrice, countdown])

  return (
    <div ref={containerRef} style={{ width }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: `${height}px` }} className="rounded-xl" />
    </div>
  )
}

export default CandleChart
