import React, { useState, useEffect, useRef } from 'react'
import { useCurrency } from '../context/CurrencyContext'
import { useTheme } from '../context/ThemeContext'
import { LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts'
import CandleChart from '../components/CandleChart'
import TradingViewChart from '../components/TradingViewChart'
import CountdownTimer from '../components/CountdownTimer'
import DemoTrading from '../components/DemoTrading'
import PositionsOverlay from '../components/PositionsOverlay'
import OrderLinesOverlay from '../components/OrderLinesOverlay'
import LiveCandleChart from '../components/LiveCandleChart'
import ReplayBar from '../components/ReplayBar'

const PAIRS = [
  { id: 'bitcoin', symbol: 'BTC/USDT', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'ETH/USDT', name: 'Ethereum' },
  { id: 'solana', symbol: 'SOL/USDT', name: 'Solana' },
  { id: 'binancecoin', symbol: 'BNB/USDT', name: 'BNB' },
  { id: 'ripple', symbol: 'XRP/USDT', name: 'XRP' },
  { id: 'dogecoin', symbol: 'DOGE/USDT', name: 'Dogecoin' },
  { id: 'cardano', symbol: 'ADA/USDT', name: 'Cardano' },
  { id: 'polkadot', symbol: 'DOT/USDT', name: 'Polkadot' },
]

function LiveCharts() {
  const { symbol: currSymbol, currency } = useCurrency()
  const { theme } = useTheme()
  const [selectedPair, setSelectedPair] = useState(PAIRS[0])
  const [tvSymbol, setTvSymbol] = useState('BINANCE:BTCUSDT')
  const [chartMode, setChartMode] = useState('tradingview') // 'tradingview' or 'custom'
  const [priceData, setPriceData] = useState([])
  const [currentPrice, setCurrentPrice] = useState(null)
  const [change24h, setChange24h] = useState(0)
  const [high24h, setHigh24h] = useState(0)
  const [low24h, setLow24h] = useState(0)
  const [volume, setVolume] = useState(0)
  const [loading, setLoading] = useState(true)
  const [allPrices, setAllPrices] = useState({})
  const [candleData, setCandleData] = useState([])
  const [candleTimeframe, setCandleTimeframe] = useState('1m')
  const [tvInterval, setTvInterval] = useState('1')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showOrderPopup, setShowOrderPopup] = useState(false)
  const [orderSide, setOrderSide] = useState('buy')
  const openBuy = () => { setOrderSide('buy'); setShowOrderPopup(true) }
  const openSell = () => { setOrderSide('sell'); setShowOrderPopup(true) }
  const [livePrice, setLivePrice] = useState(null)
  const [priceDirection, setPriceDirection] = useState('up')
  const [countdown, setCountdown] = useState('00:00')
  const wsRef = useRef(null)

  // Fetch live price from CoinGecko (free, no API key)
  const fetchPrice = async () => {
    try {
      const ids = PAIRS.map(p => p.id).join(',')
      const cur = currency.toLowerCase()
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${cur}&include_24hr_change=true&include_24hr_vol=true`
      )
      const data = await res.json()
      setAllPrices(data)

      const pairData = data[selectedPair.id]
      if (pairData) {
        const price = pairData[cur]
        setCurrentPrice(price)
        setChange24h(pairData[`${cur}_24h_change`] || 0)
        setVolume(pairData[`${cur}_24h_vol`] || 0)

        // Add to chart data
        setPriceData(prev => {
          const newPoint = {
            time: new Date().toLocaleTimeString(),
            price: price,
          }
          const updated = [...prev, newPoint].slice(-60) // Keep last 60 points
          return updated
        })
      }
      setLoading(false)
    } catch (e) {
      console.log('Price fetch error:', e)
      setLoading(false)
    }
  }

  // Fetch 1-min candle data from Binance (free, no key needed)
  const fetchCandles = async () => {
    try {
      const binanceSymbol = selectedPair.symbol.replace('/', '')
      const res = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${candleTimeframe}&limit=60`
      )
      const data = await res.json()
      if (Array.isArray(data)) {
        const candles = data.map(k => ({
          time: new Date(k[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }))
        setCandleData(candles)
      }
    } catch (e) {
      console.log('Candle fetch error:', e)
    }
  }

  // Fetch chart history
  const fetchHistory = async () => {
    try {
      const cur = currency.toLowerCase()
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/${selectedPair.id}/market_chart?vs_currency=${cur}&days=1`
      )
      const data = await res.json()
      if (data.prices) {
        const chartData = data.prices.map(([timestamp, price]) => ({
          time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          price: parseFloat(price.toFixed(2))
        }))
        setPriceData(chartData.slice(-60))
        const prices = data.prices.map(p => p[1])
        setHigh24h(Math.max(...prices))
        setLow24h(Math.min(...prices))
      }
    } catch (e) {
      console.log('History fetch error:', e)
    }
  }

  useEffect(() => {
    setPriceData([])
    setLoading(true)
    fetchHistory()
    fetchPrice()
    fetchCandles()
    // Update TradingView symbol
    const binSymbol = 'BINANCE:' + selectedPair.symbol.replace('/', '')
    setTvSymbol(binSymbol)
  }, [selectedPair, currency])

  // Delta Exchange WebSocket - real-time price & candle every second
  useEffect(() => {
    // Close previous connection
    if (wsRef.current) {
      wsRef.current.close()
    }

    const deltaSymbol = selectedPair.symbol.replace('/', '').toUpperCase()
    const wsUrl = 'wss://socket.delta.exchange'

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[Delta WS] Connected')
      // Subscribe to candlestick channel
      ws.send(JSON.stringify({
        "type": "subscribe",
        "payload": {
          "channels": [
            { "name": "candlestick_" + candleTimeframe, "symbols": [deltaSymbol] },
            { "name": "v2/ticker", "symbols": [deltaSymbol] }
          ]
        }
      }))
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)

        // Ticker update (live price)
        if (msg.type === 'v2/ticker' || msg.symbol) {
          const price = parseFloat(msg.mark_price || msg.close || msg.last_price || 0)
          if (price > 0) {
            const prevPrice = livePrice
            setLivePrice(price)
            setPriceDirection(price >= (prevPrice || price) ? 'up' : 'down')
            setCurrentPrice(price)
          }
        }

        // Candlestick update
        if (msg.type && msg.type.includes('candlestick') && msg.candle) {
          const c = msg.candle
          const newCandle = {
            time: new Date(c.time || c.t || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            open: parseFloat(c.open || c.o),
            high: parseFloat(c.high || c.h),
            low: parseFloat(c.low || c.l),
            close: parseFloat(c.close || c.c),
            volume: parseFloat(c.volume || c.v || 0),
          }

          setLivePrice(newCandle.close)
          setPriceDirection(newCandle.close >= newCandle.open ? 'up' : 'down')
          setCurrentPrice(newCandle.close)

          setCandleData(prev => {
            if (prev.length === 0) return [newCandle]
            const updated = [...prev]
            // Replace last candle or add new
            const lastTime = updated[updated.length - 1]?.time
            if (lastTime === newCandle.time) {
              updated[updated.length - 1] = newCandle
            } else {
              if (updated.length >= 60) updated.shift()
              updated.push(newCandle)
            }
            return updated
          })
        }
      } catch (e) {
        // Try Binance format as fallback
        try {
          const msg = JSON.parse(event.data)
          if (msg.k) {
            const kline = msg.k
            const newCandle = {
              time: new Date(kline.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
              open: parseFloat(kline.o),
              high: parseFloat(kline.h),
              low: parseFloat(kline.l),
              close: parseFloat(kline.c),
              volume: parseFloat(kline.v),
            }
            setLivePrice(newCandle.close)
            setPriceDirection(newCandle.close >= newCandle.open ? 'up' : 'down')
            setCurrentPrice(newCandle.close)
            setCandleData(prev => {
              const updated = [...prev]
              if (kline.x) {
                if (updated.length >= 60) updated.shift()
                updated.push(newCandle)
              } else {
                if (updated.length > 0) updated[updated.length - 1] = newCandle
                else updated.push(newCandle)
              }
              return updated
            })
          }
        } catch (e2) {}
      }
    }

    ws.onerror = (err) => {
      console.log('[Delta WS] Error, trying Binance fallback...')
      // Fallback to Binance
      const binanceSymbol = selectedPair.symbol.replace('/', '').toLowerCase()
      const fallbackWs = new WebSocket(`wss://stream.binance.com:9443/ws/${binanceSymbol}@kline_${candleTimeframe}`)
      wsRef.current = fallbackWs
      fallbackWs.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.k) {
            const kline = msg.k
            const price = parseFloat(kline.c)
            const prevPrice = livePrice
            setLivePrice(price)
            setPriceDirection(price >= (prevPrice || price) ? 'up' : 'down')
            setCurrentPrice(price)

            const remaining = kline.T - Date.now()
            if (remaining > 0) {
              const hrs = Math.floor(remaining / 3600000)
              const mins = Math.floor((remaining % 3600000) / 60000)
              const secs = Math.floor((remaining % 60000) / 1000)
              if (hrs > 0) setCountdown(`${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`)
              else setCountdown(`${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`)
            }

            setCandleData(prev => {
              const newCandle = {
                time: new Date(kline.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                open: parseFloat(kline.o), high: parseFloat(kline.h),
                low: parseFloat(kline.l), close: parseFloat(kline.c),
                volume: parseFloat(kline.v),
              }
              const updated = [...prev]
              if (kline.x) { if (updated.length >= 60) updated.shift(); updated.push(newCandle) }
              else { if (updated.length > 0) updated[updated.length - 1] = newCandle; else updated.push(newCandle) }
              return updated
            })
          }
        } catch(e) {}
      }
    }

    return () => {
      if (wsRef.current) wsRef.current.close()
    }
  }, [selectedPair, candleTimeframe])

  // Auto-refresh all prices every 10 seconds
  useEffect(() => {
    const interval = setInterval(fetchPrice, 10000)
    return () => clearInterval(interval)
  }, [selectedPair, currency])

  // Escape key to exit fullscreen
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreen])

  // Fallback countdown timer (works even if WebSocket fails)
  useEffect(() => {
    const getTimeframeMs = (tf) => {
      const map = {
        '1m': 60000, '1': 60000,
        '3m': 180000, '3': 180000,
        '5m': 300000, '5': 300000,
        '15m': 900000, '15': 900000,
        '30m': 1800000, '30': 1800000,
        '1h': 3600000, '60': 3600000,
        '4h': 14400000, '240': 14400000,
        '1d': 86400000, 'D': 86400000, '1D': 86400000,
      }
      return map[tf] || 60000
    }
    // Use tvInterval when in tradingview mode, candleTimeframe when custom
    const activeTf = chartMode === 'tradingview' ? tvInterval : candleTimeframe
    const updateCountdown = () => {
      const tfMs = getTimeframeMs(activeTf)
      const now = Date.now()
      const remaining = tfMs - (now % tfMs)
      const hrs = Math.floor(remaining / 3600000)
      const mins = Math.floor((remaining % 3600000) / 60000)
      const secs = Math.floor((remaining % 60000) / 1000)
      if (hrs > 0) {
        setCountdown(`${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`)
      } else {
        setCountdown(`${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`)
      }
    }
    updateCountdown()
    const interval = setInterval(updateCountdown, 1000)
    return () => clearInterval(interval)
  }, [candleTimeframe, tvInterval, chartMode])

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl lg:text-3xl font-bold text-white flex items-center gap-3">
          📊 Live Price Charts
        </h1>
        <p className="text-gray-400 mt-1 text-sm">Real-time crypto prices (auto-refresh 10s)</p>
      </div>

      {/* LIVE COUNTDOWN BAR - Always Visible */}
      <div className="glass-card p-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="text-white font-semibold text-sm">{selectedPair.symbol}</span>
          {livePrice ? (
            <span className={`text-xl font-bold ${priceDirection === 'up' ? 'text-emerald-400' : 'text-red-400'}`}>
              ${livePrice.toLocaleString()}
            </span>
          ) : currentPrice ? (
            <span className="text-xl font-bold text-white">${currentPrice.toLocaleString()}</span>
          ) : (
            <span className="text-gray-400">Loading...</span>
          )}
          <span className={`text-xs ${priceDirection === 'up' ? 'text-emerald-400' : 'text-red-400'}`}>
            {priceDirection === 'up' ? '▲' : '▼'} {Math.abs(change24h).toFixed(2)}%
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-gray-400 text-xs">Candle closes in:</span>
          <CountdownTimer timeframe={chartMode === 'tradingview' ? tvInterval : candleTimeframe} />
          <span className="text-emerald-400 text-[10px] animate-pulse">● LIVE</span>
        </div>
      </div>

      {/* Pair Selector */}
      <div className="flex flex-wrap gap-2">
        {PAIRS.map(pair => (
          <button key={pair.id} onClick={() => setSelectedPair(pair)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              selectedPair.id === pair.id
                ? 'bg-[#e94560]/20 text-[#e94560] border border-[#e94560]/30'
                : 'bg-[#12122a] text-gray-400 border border-[#2a2a5a] hover:text-white hover:border-[#2a2a5a]'
            }`}>
            {pair.symbol}
          </button>
        ))}
      </div>

      {/* Chart Mode Toggle */}
      <div className="flex items-center gap-2">
        <button onClick={() => setChartMode('tradingview')}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${chartMode === 'tradingview' ? 'bg-[#e94560]/20 text-[#e94560] border border-[#e94560]/30' : 'bg-[#12122a] text-gray-400 border border-[#2a2a5a]'}`}>
          📺 TradingView Chart
        </button>
        <button onClick={() => setChartMode('custom')}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${chartMode === 'custom' ? 'bg-[#e94560]/20 text-[#e94560] border border-[#e94560]/30' : 'bg-[#12122a] text-gray-400 border border-[#2a2a5a]'}`}>
          🕯️ Custom Candle Chart
        </button>
      </div>

      {/* TradingView Embedded Chart + Demo Trading Side Panel */}
      {chartMode === 'tradingview' && (
        <div className={`${isFullscreen ? 'fixed inset-0 z-50 bg-[#060612] flex flex-col' : ''}`}>
          {/* Fullscreen Top Bar */}
          {isFullscreen && (
            <div className="flex items-center justify-between px-4 py-2 border-b border-[#2a2a5a]/30 bg-[#0a0a1f] shrink-0">
              <div className="flex items-center gap-4">
                <span className="text-white text-sm font-medium">📺 {selectedPair.symbol}</span>
                {livePrice ? (
                  <span className={`text-lg font-bold ${priceDirection === 'up' ? 'text-emerald-400' : 'text-red-400'}`}>
                    ${livePrice.toLocaleString()}
                  </span>
                ) : (
                  <span className="text-lg font-bold text-gray-400">Loading...</span>
                )}
                <CountdownTimer timeframe={tvInterval} />
                <span className="text-[10px] text-emerald-400 animate-pulse">● LIVE</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  {[{label:'1m',val:'1'},{label:'5m',val:'5'},{label:'15m',val:'15'},{label:'30m',val:'30'},{label:'1h',val:'60'},{label:'4h',val:'240'},{label:'1D',val:'D'}].map(tf => (
                    <button key={tf.val} onClick={() => setTvInterval(tf.val)}
                      className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${tvInterval === tf.val ? 'bg-[#e94560]/20 text-[#e94560] border border-[#e94560]/30' : 'text-gray-400 hover:text-white bg-[#0a0a1f] border border-[#2a2a5a]/30'}`}>
                      {tf.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => setIsFullscreen(false)}
                  className="px-3 py-1.5 rounded text-xs font-bold text-white bg-red-500/80 hover:bg-red-500 border border-red-500/50 transition-all">
                  ✕ Exit Fullscreen
                </button>
              </div>
            </div>
          )}

          {/* Chart Content */}
          <div className={`${isFullscreen ? 'flex-1 min-h-0' : 'flex gap-4'}`}>
            {/* Chart - Left Side (or full in fullscreen) */}
            <div className={`${isFullscreen ? 'h-full' : 'flex-1'} glass-card overflow-hidden ${isFullscreen ? 'rounded-none border-0' : ''}`}>
              {/* Normal mode header - hidden in fullscreen */}
              {!isFullscreen && (
                <div className="flex items-center justify-between p-3 border-b border-[#2a2a5a]/30">
                  <div className="flex items-center gap-4">
                    <span className="text-white text-sm font-medium">📺 {selectedPair.symbol}</span>
                    {livePrice ? (
                      <span className={`text-lg font-bold ${priceDirection === 'up' ? 'text-emerald-400' : 'text-red-400'}`}>
                        ${livePrice.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-lg font-bold text-gray-400">Loading...</span>
                    )}
                    <CountdownTimer timeframe={tvInterval} />
                    <span className="text-[10px] text-emerald-400 animate-pulse">● LIVE</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      {[{label:'1m',val:'1'},{label:'5m',val:'5'},{label:'15m',val:'15'},{label:'30m',val:'30'},{label:'1h',val:'60'},{label:'4h',val:'240'},{label:'1D',val:'D'}].map(tf => (
                        <button key={tf.val} onClick={() => setTvInterval(tf.val)}
                          className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${tvInterval === tf.val ? 'bg-[#e94560]/20 text-[#e94560] border border-[#e94560]/30' : 'text-gray-400 hover:text-white bg-[#0a0a1f] border border-[#2a2a5a]/30'}`}>
                          {tf.label}
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setIsFullscreen(true)}
                      className="px-3 py-1 rounded text-xs font-medium text-gray-400 hover:text-white bg-[#0a0a1f] border border-[#2a2a5a]/30 hover:border-[#e94560]/30 transition-all">
                      ⛶ Full
                    </button>
                  </div>
                </div>
              )}

              <div className={`relative ${isFullscreen ? 'h-full' : ''}`}>
                {/* Buy/Sell Overlay Buttons - below chart title */}
                <div className="absolute top-[70px] left-[50px] z-10 flex items-center gap-1">
                  <button onClick={openSell}
                    className="px-3 py-1 bg-red-500/90 hover:bg-red-500 text-white text-xs font-bold rounded shadow-lg transition-all">
                    {currentPrice ? currentPrice.toLocaleString() : '...'}<br/><span className="text-[9px] font-normal">SELL</span>
                  </button>
                  <span className="text-gray-400 text-[10px]">0</span>
                  <button onClick={openBuy}
                    className="px-3 py-1 bg-emerald-500/90 hover:bg-emerald-500 text-white text-xs font-bold rounded shadow-lg transition-all">
                    {currentPrice ? currentPrice.toLocaleString() : '...'}<br/><span className="text-[9px] font-normal">BUY</span>
                  </button>
                </div>

                {/* Open Positions P&L Overlay on Chart */}
                <PositionsOverlay currentPrice={livePrice || currentPrice || 0} />

                {/* Pending Orders Lines on Chart */}
                <OrderLinesOverlay currentPrice={livePrice || currentPrice || 0} />

                <TradingViewChart symbol={tvSymbol} theme={theme} fullscreen={isFullscreen} interval={tvInterval} />

                {/* Replay Bar - hidden in fullscreen */}
                {!isFullscreen && (
                  <ReplayBar
                    allCandles={candleData}
                    onReplayUpdate={(candles) => setCandleData(candles)}
                    onBuy={openBuy}
                    onSell={openSell}
                  />
                )}
              </div>
            </div>

            {/* Paper Trading Panel - Right Side (hidden in fullscreen) */}
            {!isFullscreen && (
              <div className="w-[320px] hidden lg:block">
                <DemoTrading symbol={selectedPair.symbol} currentPrice={livePrice || currentPrice || 0} showPopup={showOrderPopup} popupSide={orderSide} onClosePopup={() => setShowOrderPopup(false)} />
              </div>
            )}
          </div>

          {/* Fullscreen: Hidden DemoTrading just for popup functionality */}
          {isFullscreen && showOrderPopup && (
            <div className="fixed inset-0 z-[60]">
              <DemoTrading symbol={selectedPair.symbol} currentPrice={livePrice || currentPrice || 0} showPopup={showOrderPopup} popupSide={orderSide} onClosePopup={() => setShowOrderPopup(false)} />
            </div>
          )}

          {/* Mobile: Paper Trading Below Chart (hidden in fullscreen) */}
          {!isFullscreen && (
            <div className="lg:hidden mt-4">
              <DemoTrading symbol={selectedPair.symbol} currentPrice={livePrice || currentPrice || 0} />
            </div>
          )}
        </div>
      )}

      {/* Price Header */}
      <div className="glass-card p-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="text-white text-lg font-semibold">{selectedPair.name} ({selectedPair.symbol})</h2>
            <div className="flex items-baseline gap-3 mt-1">
              <span className={`text-3xl font-bold transition-colors duration-200 ${priceDirection === 'up' ? 'text-emerald-400' : 'text-red-400'}`}>
                {livePrice ? `${currSymbol}${livePrice.toLocaleString()}` : currentPrice ? `${currSymbol}${currentPrice.toLocaleString()}` : '...'}
              </span>
              <span className={`text-sm font-medium ${change24h >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {change24h >= 0 ? '▲' : '▼'} {Math.abs(change24h).toFixed(2)}%
              </span>
              <span className="text-[10px] text-gray-500 animate-pulse">● LIVE</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-gray-400 text-xs">24h High</p>
              <p className="text-emerald-400 font-semibold text-sm">{currSymbol}{high24h.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-gray-400 text-xs">24h Low</p>
              <p className="text-red-400 font-semibold text-sm">{currSymbol}{low24h.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-gray-400 text-xs">Volume</p>
              <p className="text-blue-400 font-semibold text-sm">{currSymbol}{(volume/1000000).toFixed(1)}M</p>
            </div>
          </div>
        </div>
      </div>

      {/* Candlestick Chart */}
      {chartMode === 'custom' && (
      <div className={`glass-card p-5 ${isFullscreen ? 'fixed inset-0 z-50 rounded-none m-0 p-0 overflow-hidden flex flex-col' : ''}`}>
        <div className={`flex items-center justify-between ${isFullscreen ? 'px-4 py-3 border-b border-[#2a2a5a]/30 bg-[#0a0a1f] shrink-0' : 'mb-3'}`}>
          <div className="flex items-center gap-3">
            <h3 className="text-white font-semibold">🕯️ {selectedPair.symbol}</h3>
            {livePrice && (
              <span className={`text-lg font-bold ${priceDirection === 'up' ? 'text-emerald-400' : 'text-red-400'}`}>
                ${livePrice.toLocaleString()}
              </span>
            )}
            <CountdownTimer timeframe={candleTimeframe} />
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {['1m','3m','5m','15m','1h','4h','1d'].map(tf => (
                <button key={tf} onClick={() => setCandleTimeframe(tf)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${candleTimeframe === tf ? 'bg-[#e94560]/20 text-[#e94560] border border-[#e94560]/30' : 'text-gray-400 hover:text-white bg-[#0a0a1f] border border-[#2a2a5a]/30'}`}>
                  {tf}
                </button>
              ))}
            </div>
            <button onClick={() => setIsFullscreen(!isFullscreen)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${isFullscreen ? 'font-bold text-white bg-red-500/80 hover:bg-red-500 border border-red-500/50' : 'text-gray-400 hover:text-white bg-[#0a0a1f] border border-[#2a2a5a]/30 hover:border-[#e94560]/30'}`}>
              {isFullscreen ? '✕ Exit Fullscreen' : '⛶ Full'}
            </button>
          </div>
        </div>
        <div className={`${isFullscreen ? 'flex-1 min-h-0' : ''}`}>
          <LiveCandleChart
            symbol={selectedPair.symbol}
            timeframe={candleTimeframe}
            positions={JSON.parse(localStorage.getItem('vmt_demo_positions') || '[]')}
            currentPrice={livePrice || currentPrice || 0}
            height={isFullscreen ? window.innerHeight - 60 : 450}
            theme={theme}
          />
        </div>
      </div>
      )}

      {/* Area Chart */}
      <div className="glass-card p-5">
        <h3 className="text-white font-semibold mb-3">Price Chart (24h)</h3>
        {loading ? (
          <div className="h-[300px] flex items-center justify-center text-gray-500">Loading chart...</div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={priceData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a5a" />
              <XAxis dataKey="time" stroke="#6b7280" fontSize={10} />
              <YAxis stroke="#6b7280" fontSize={11} domain={['auto', 'auto']} />
              <Tooltip contentStyle={{ backgroundColor: '#12122a', border: '1px solid #2a2a5a', borderRadius: '8px' }}
                formatter={(v) => [`${currSymbol}${v.toLocaleString()}`, 'Price']} />
              <defs><linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={change24h >= 0 ? '#00d68f' : '#ff3d71'} stopOpacity={0.3}/>
                <stop offset="100%" stopColor={change24h >= 0 ? '#00d68f' : '#ff3d71'} stopOpacity={0}/>
              </linearGradient></defs>
              <Area type="monotone" dataKey="price" stroke={change24h >= 0 ? '#00d68f' : '#ff3d71'}
                strokeWidth={2} fill="url(#priceGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* All Prices Grid */}
      <div className="glass-card p-5">
        <h3 className="text-white font-semibold mb-3">All Prices</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {PAIRS.map(pair => {
            const data = allPrices[pair.id]
            const cur = currency.toLowerCase()
            const price = data?.[cur]
            const change = data?.[`${cur}_24h_change`] || 0
            return (
              <div key={pair.id} onClick={() => setSelectedPair(pair)}
                className={`p-3 rounded-xl border cursor-pointer transition-all hover:scale-[1.02] ${
                  selectedPair.id === pair.id ? 'border-[#e94560]/40 bg-[#e94560]/5' : 'border-[#2a2a5a]/30 bg-[#0a0a1f]/50'
                }`}>
                <p className="text-white text-sm font-medium">{pair.symbol}</p>
                <p className="text-white font-bold mt-1">{price ? `${currSymbol}${price.toLocaleString()}` : '...'}</p>
                <p className={`text-xs mt-0.5 ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default LiveCharts
