import React, { useEffect, useRef, memo } from 'react'

/**
 * TradingView Advanced Chart Widget
 * Embeds the real TradingView chart with all features:
 * - Candlestick, Line, Area charts
 * - Drawing tools (Trendline, Fib, etc.)
 * - Indicators (RSI, MACD, MA, Bollinger, etc.)
 * - Timeframes (1m, 5m, 15m, 1h, 4h, 1D, 1W)
 * - Real-time price updates
 * - Buy/Sell buttons
 * - Watchlist
 */
function TradingViewChart({ symbol = 'BINANCE:BTCUSDT', theme = 'dark', fullscreen = false, interval = '1' }) {
  const containerRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current) return

    // Clear previous widget
    containerRef.current.innerHTML = ''

    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
    script.type = 'text/javascript'
    script.async = true
    script.innerHTML = JSON.stringify({
      "autosize": true,
      "symbol": symbol,
      "interval": interval,
      "timezone": "Asia/Kolkata",
      "theme": theme,
      "style": "1",
      "locale": "en",
      "allow_symbol_change": true,
      "support_host": "https://www.tradingview.com",
      "enable_publishing": false,
      "hide_top_toolbar": false,
      "hide_legend": false,
      "hide_side_toolbar": false,
      "save_image": true,
      "calendar": false,
      "hide_volume": false,
      "withdateranges": true,
      "details": true,
      "hotlist": true,
      "show_popup_button": true,
      "popup_width": "1000",
      "popup_height": "650",
      "backgroundColor": theme === 'dark' ? "rgba(6, 6, 18, 1)" : "rgba(255, 255, 255, 1)",
      "gridColor": theme === 'dark' ? "rgba(42, 42, 90, 0.3)" : "rgba(0, 0, 0, 0.06)",
      "studies": [
        "STD;RSI",
        "STD;MACD"
      ],
      "container_id": containerRef.current.id
    })

    const widgetDiv = document.createElement('div')
    widgetDiv.className = 'tradingview-widget-container__widget'
    widgetDiv.style.height = '100%'
    widgetDiv.style.width = '100%'

    containerRef.current.appendChild(widgetDiv)
    containerRef.current.appendChild(script)

    return () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
      }
    }
  }, [symbol, theme, interval])

  return (
    <div
      ref={containerRef}
      id={`tv_chart_${symbol.replace(/[^a-zA-Z0-9]/g, '_')}`}
      className="tradingview-widget-container"
      style={{ height: fullscreen ? 'calc(100vh - 52px)' : '600px', width: '100%' }}
    />
  )
}

export default memo(TradingViewChart)
