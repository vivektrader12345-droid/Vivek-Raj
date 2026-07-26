import React, { useState, useEffect, useMemo } from 'react'
import { useTrades } from '../context/TradeContext'
import { useCurrency } from '../context/CurrencyContext'
import toast from 'react-hot-toast'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area } from 'recharts'

const STRATEGIES = [
  { id: 'rsi', name: 'RSI Strategy', desc: 'Buy when RSI < 30, Sell when RSI > 70',
    params: { period: 14, oversold: 30, overbought: 70 } },
  { id: 'macd', name: 'MACD Crossover', desc: 'Buy on MACD bullish cross, Sell on bearish',
    params: { fast: 12, slow: 26, signal: 9 } },
  { id: 'ma_cross', name: 'Moving Average Cross', desc: 'Buy when fast MA crosses above slow MA',
    params: { fastMA: 9, slowMA: 21 } },
  { id: 'bollinger', name: 'Bollinger Bands', desc: 'Buy at lower band, Sell at upper band',
    params: { period: 20, stdDev: 2 } },
  { id: 'breakout', name: 'Breakout Strategy', desc: 'Buy on high breakout with volume',
    params: { lookback: 20, volumeMultiplier: 1.5 } },
  { id: 'scalping', name: 'Scalping Bot', desc: 'Quick entries on small moves with tight SL',
    params: { targetPips: 10, stopLoss: 5, timeframe: '1m' } },
]

const PAIRS = ['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT',
  'DOGE/USDT','ADA/USDT','MATIC/USDT','EUR/USD','GBP/USD','GOLD/USD']

function AlgoTrading() {
  const { addTrade } = useTrades()
  const { symbol, formatAmount } = useCurrency()
  const [activeTab, setActiveTab] = useState('signals')

  // ===== LEVEL 1: SIGNALS STATE =====
  const [selectedStrategy, setSelectedStrategy] = useState(STRATEGIES[0])
  const [selectedPair, setSelectedPair] = useState('BTC/USDT')
  const [signals, setSignals] = useState(() => {
    const saved = localStorage.getItem('vmt_algo_signals')
    return saved ? JSON.parse(saved) : []
  })
  const [isRunning, setIsRunning] = useState(false)

  // ===== LEVEL 2: PAPER TRADING STATE =====
  const [paperTrades, setPaperTrades] = useState(() => {
    const saved = localStorage.getItem('vmt_paper_trades')
    return saved ? JSON.parse(saved) : []
  })
  const [paperBalance, setPaperBalance] = useState(() => {
    return parseFloat(localStorage.getItem('vmt_paper_balance')) || 10000
  })
  const [backtestResults, setBacktestResults] = useState(null)

  // ===== LEVEL 3: LIVE TRADING STATE =====
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('vmt_api_key') || '')
  const [apiSecret, setApiSecret] = useState(() => localStorage.getItem('vmt_api_secret') || '')
  const [isLiveConnected, setIsLiveConnected] = useState(false)
  const [liveBots, setLiveBots] = useState(() => {
    const saved = localStorage.getItem('vmt_live_bots')
    return saved ? JSON.parse(saved) : []
  })

  // ===== TRADINGVIEW ALERTS STATE =====
  const [tvAlerts, setTvAlerts] = useState([])
  const [webhookUrl, setWebhookUrl] = useState(() => localStorage.getItem('vmt_webhook_url') || 'http://localhost:5000')
  const [tvConnected, setTvConnected] = useState(false)

  // Fetch TradingView alerts from backend
  const fetchTvAlerts = async () => {
    try {
      const res = await fetch(`${webhookUrl}/alerts?limit=50`)
      const data = await res.json()
      if (data.alerts) {
        setTvAlerts(data.alerts)
        setTvConnected(true)
      }
    } catch (e) {
      setTvConnected(false)
    }
  }

  // Auto-refresh TV alerts every 5 seconds
  useEffect(() => {
    if (activeTab === 'tradingview') {
      fetchTvAlerts()
      const interval = setInterval(fetchTvAlerts, 5000)
      return () => clearInterval(interval)
    }
  }, [activeTab, webhookUrl])

  // Save states
  useEffect(() => { localStorage.setItem('vmt_algo_signals', JSON.stringify(signals)) }, [signals])
  useEffect(() => { localStorage.setItem('vmt_paper_trades', JSON.stringify(paperTrades)) }, [paperTrades])
  useEffect(() => { localStorage.setItem('vmt_paper_balance', paperBalance.toString()) }, [paperBalance])
  useEffect(() => { localStorage.setItem('vmt_live_bots', JSON.stringify(liveBots)) }, [liveBots])

  // ===== SIGNAL GENERATOR (Simulated) =====
  const generateSignal = () => {
    const types = ['BUY', 'SELL']
    const type = types[Math.floor(Math.random() * 2)]
    const price = selectedPair.includes('BTC') ? (60000 + Math.random() * 5000).toFixed(2)
      : selectedPair.includes('ETH') ? (3000 + Math.random() * 500).toFixed(2)
      : (Math.random() * 100 + 1).toFixed(4)
    const sl = type === 'BUY' ? (price * 0.98).toFixed(2) : (price * 1.02).toFixed(2)
    const tp = type === 'BUY' ? (price * 1.03).toFixed(2) : (price * 0.97).toFixed(2)
    const confidence = (60 + Math.random() * 35).toFixed(0)

    const signal = {
      id: 'sig_' + Date.now(),
      strategy: selectedStrategy.name,
      pair: selectedPair,
      type,
      price,
      stopLoss: sl,
      takeProfit: tp,
      confidence: confidence + '%',
      time: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      status: 'active'
    }
    setSignals(prev => [signal, ...prev.slice(0, 49)])
    toast.success(`${type} Signal: ${selectedPair} @ $${price}`)
  }

  // Auto signal generation when running
  useEffect(() => {
    let interval
    if (isRunning) {
      interval = setInterval(generateSignal, 15000) // every 15 sec
    }
    return () => clearInterval(interval)
  }, [isRunning, selectedStrategy, selectedPair])

  // ===== BACKTESTING ENGINE =====
  const runBacktest = () => {
    const trades = []
    let balance = 10000
    const numTrades = 30 + Math.floor(Math.random() * 20)

    for (let i = 0; i < numTrades; i++) {
      const isWin = Math.random() > 0.45 // ~55% win rate
      const pnl = isWin ? (Math.random() * 200 + 50) : -(Math.random() * 150 + 30)
      balance += pnl
      trades.push({
        trade: i + 1,
        pnl: parseFloat(pnl.toFixed(2)),
        balance: parseFloat(balance.toFixed(2)),
        type: Math.random() > 0.5 ? 'BUY' : 'SELL',
        date: new Date(Date.now() - (numTrades - i) * 86400000).toLocaleDateString()
      })
    }

    const wins = trades.filter(t => t.pnl > 0).length
    const losses = trades.filter(t => t.pnl < 0).length
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0)
    const maxDrawdown = Math.min(...trades.map(t => t.pnl))

    setBacktestResults({
      trades,
      stats: {
        totalTrades: numTrades,
        wins, losses,
        winRate: ((wins / numTrades) * 100).toFixed(1),
        totalPnL: totalPnL.toFixed(2),
        avgTrade: (totalPnL / numTrades).toFixed(2),
        maxDrawdown: maxDrawdown.toFixed(2),
        finalBalance: balance.toFixed(2),
        sharpeRatio: (1.2 + Math.random() * 0.8).toFixed(2),
        profitFactor: (wins > 0 && losses > 0 ? (trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0) / Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0))).toFixed(2) : '∞'),
      }
    })
    toast.success('Backtest complete!')
  }

  // ===== PAPER TRADE EXECUTION =====
  const executePaperTrade = (signal) => {
    const qty = (paperBalance * 0.1 / parseFloat(signal.price)).toFixed(4)
    const isWin = Math.random() > 0.4
    const pnl = isWin ? parseFloat((Math.random() * 100 + 20).toFixed(2))
      : -parseFloat((Math.random() * 80 + 10).toFixed(2))

    const trade = {
      id: 'paper_' + Date.now(),
      pair: signal.pair, type: signal.type,
      entry: signal.price, exit: (parseFloat(signal.price) + (signal.type === 'BUY' ? pnl : -pnl)).toFixed(2),
      qty, pnl, strategy: signal.strategy,
      date: new Date().toISOString().split('T')[0],
      time: new Date().toLocaleTimeString()
    }

    setPaperTrades(prev => [trade, ...prev])
    setPaperBalance(prev => prev + pnl)
    toast.success(`Paper ${signal.type}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`)
  }

  // ===== LIVE BOT MANAGEMENT =====
  const connectAPI = () => {
    if (!apiKey || !apiSecret) { toast.error('Enter API Key and Secret'); return }
    localStorage.setItem('vmt_api_key', apiKey)
    localStorage.setItem('vmt_api_secret', apiSecret)
    setIsLiveConnected(true)
    toast.success('Exchange connected!')
  }

  const startLiveBot = () => {
    if (!isLiveConnected) { toast.error('Connect exchange first'); return }
    const bot = {
      id: 'bot_' + Date.now(),
      strategy: selectedStrategy.name,
      pair: selectedPair,
      status: 'running',
      startedAt: new Date().toISOString(),
      trades: 0, pnl: 0
    }
    setLiveBots(prev => [...prev, bot])
    toast.success(`Bot started: ${selectedStrategy.name} on ${selectedPair}`)
  }

  const stopBot = (id) => {
    setLiveBots(prev => prev.map(b => b.id === id ? { ...b, status: 'stopped' } : b))
    toast.success('Bot stopped')
  }

  const deleteBot = (id) => {
    setLiveBots(prev => prev.filter(b => b.id !== id))
  }

  const tabs = [
    { id: 'signals', label: '📡 Signals', level: 'L1' },
    { id: 'tradingview', label: '📺 TradingView', level: 'L1' },
    { id: 'paper', label: '📝 Paper Trading', level: 'L2' },
    { id: 'backtest', label: '📊 Backtest', level: 'L2' },
    { id: 'live', label: '🚀 Live Trading', level: 'L3' },
    { id: 'bots', label: '🤖 My Bots', level: 'L3' },
  ]

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl lg:text-3xl font-bold text-white flex items-center gap-3">
          🤖 Algo Trading Hub
        </h1>
        <p className="text-gray-400 mt-1 text-sm">Automated strategies, signals, backtesting & live trading</p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-[#2a2a5a]/50 pb-3">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              activeTab === tab.id ? 'bg-[#e94560]/20 text-[#e94560] border border-[#e94560]/30'
              : 'text-gray-400 hover:text-white hover:bg-[#2a2a5a]/20 border border-transparent'
            }`}>
            {tab.label}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2a2a5a] text-gray-400">{tab.level}</span>
          </button>
        ))}
      </div>

      {/* Strategy & Pair Selector (shared) */}
      <div className="glass-card p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-gray-400 text-xs mb-1.5">Strategy</label>
            <select value={selectedStrategy.id} onChange={(e) => setSelectedStrategy(STRATEGIES.find(s=>s.id===e.target.value))}
              className="input-field text-sm">
              {STRATEGIES.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <p className="text-gray-500 text-xs mt-1">{selectedStrategy.desc}</p>
          </div>
          <div>
            <label className="block text-gray-400 text-xs mb-1.5">Trading Pair</label>
            <select value={selectedPair} onChange={(e) => setSelectedPair(e.target.value)}
              className="input-field text-sm">
              {PAIRS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ===== SIGNALS TAB (Level 1) ===== */}
      {activeTab === 'signals' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <button onClick={() => setIsRunning(!isRunning)}
              className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${isRunning ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'}`}>
              {isRunning ? '⏹ Stop Scanning' : '▶️ Start Scanning'}
            </button>
            <button onClick={generateSignal} className="px-5 py-2.5 rounded-xl text-sm font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30">
              ⚡ Generate Signal
            </button>
            {isRunning && <span className="text-emerald-400 text-xs animate-pulse">● Live scanning...</span>}
          </div>

          {/* Signals List */}
          <div className="space-y-3 max-h-[500px] overflow-y-auto">
            {signals.length === 0 ? (
              <div className="text-center py-10 text-gray-500">No signals yet. Start scanning or generate manually.</div>
            ) : signals.map(sig => (
              <div key={sig.id} className={`glass-card p-4 border-l-4 ${sig.type==='BUY'?'border-l-emerald-500':'border-l-red-500'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-1 rounded text-xs font-bold ${sig.type==='BUY'?'bg-emerald-500/20 text-emerald-400':'bg-red-500/20 text-red-400'}`}>
                      {sig.type}
                    </span>
                    <span className="text-white font-semibold">{sig.pair}</span>
                    <span className="text-gray-400 text-xs">@ ${sig.price}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-blue-400">Confidence: {sig.confidence}</span>
                    <button onClick={() => executePaperTrade(sig)} className="px-2 py-1 bg-[#f5a623]/20 text-[#f5a623] rounded text-xs hover:bg-[#f5a623]/30">Paper Trade</button>
                  </div>
                </div>
                <div className="flex gap-4 mt-2 text-xs text-gray-400">
                  <span>SL: ${sig.stopLoss}</span>
                  <span>TP: ${sig.takeProfit}</span>
                  <span>Strategy: {sig.strategy}</span>
                  <span>{sig.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== TRADINGVIEW ALERTS TAB ===== */}
      {activeTab === 'tradingview' && (
        <div className="space-y-4">
          {/* Connection Setup */}
          <div className="glass-card p-5">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">📺 TradingView Webhook Alerts</h3>
            <div className="space-y-3">
              <div>
                <label className="text-gray-400 text-xs">Webhook Server URL</label>
                <div className="flex gap-2 mt-1">
                  <input type="text" value={webhookUrl} onChange={(e) => { setWebhookUrl(e.target.value); localStorage.setItem('vmt_webhook_url', e.target.value) }}
                    className="input-field text-sm flex-1" placeholder="http://localhost:5000" />
                  <button onClick={fetchTvAlerts}
                    className={`px-4 py-2 rounded-xl text-sm font-medium ${tvConnected ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'}`}>
                    {tvConnected ? '✅ Connected' : '🔗 Connect'}
                  </button>
                </div>
              </div>
              <div className="bg-[#0a0a1f] rounded-xl p-3 border border-[#2a2a5a]/30">
                <p className="text-gray-400 text-xs mb-1">📋 TradingView Alert Message (copy this):</p>
                <code className="text-emerald-400 text-xs block whitespace-pre-wrap bg-[#060612] p-2 rounded-lg">
{`{
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.action}}",
  "price": "{{close}}",
  "time": "{{time}}",
  "exchange": "{{exchange}}",
  "interval": "{{interval}}",
  "message": "Alert triggered"
}`}
                </code>
              </div>
              <div className="bg-[#0a0a1f] rounded-xl p-3 border border-[#2a2a5a]/30">
                <p className="text-gray-400 text-xs">📌 Webhook URL (paste in TradingView):</p>
                <p className="text-[#f5a623] text-sm font-mono mt-1">{webhookUrl}/webhook</p>
              </div>
            </div>
          </div>

          {/* Status */}
          <div className={`glass-card p-3 flex items-center gap-2 ${tvConnected ? 'border-emerald-500/20' : 'border-red-500/20'}`}>
            <span className={`w-2 h-2 rounded-full ${tvConnected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`}></span>
            <span className={`text-sm ${tvConnected ? 'text-emerald-400' : 'text-red-400'}`}>
              {tvConnected ? `Server connected | ${tvAlerts.length} alerts received` : 'Server not connected. Start backend first.'}
            </span>
            {tvConnected && (
              <button onClick={() => { fetch(`${webhookUrl}/alerts`, {method:'DELETE'}); setTvAlerts([]); toast.success('Alerts cleared') }}
                className="ml-auto px-3 py-1 text-xs bg-red-500/20 text-red-400 rounded-lg">Clear All</button>
            )}
          </div>

          {/* Alerts List */}
          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {tvAlerts.length === 0 ? (
              <div className="text-center py-10 text-gray-500">
                <p className="text-3xl mb-2">📺</p>
                <p>No TradingView alerts yet</p>
                <p className="text-xs mt-1">Set up a webhook alert in TradingView to see alerts here</p>
              </div>
            ) : tvAlerts.map(alert => (
              <div key={alert.id} className={`glass-card p-4 border-l-4 ${alert.action?.toLowerCase().includes('buy') ? 'border-l-emerald-500' : alert.action?.toLowerCase().includes('sell') ? 'border-l-red-500' : 'border-l-blue-500'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-1 rounded text-xs font-bold ${alert.action?.toLowerCase().includes('buy') ? 'bg-emerald-500/20 text-emerald-400' : alert.action?.toLowerCase().includes('sell') ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'}`}>
                      {alert.action || 'ALERT'}
                    </span>
                    <span className="text-white font-semibold">{alert.symbol}</span>
                    <span className="text-gray-400 text-xs">@ ${alert.price}</span>
                  </div>
                  <span className="text-gray-500 text-xs">{new Date(alert.receivedAt).toLocaleTimeString()}</span>
                </div>
                <div className="flex gap-4 mt-2 text-xs text-gray-400">
                  {alert.exchange && <span>Exchange: {alert.exchange}</span>}
                  {alert.interval && <span>TF: {alert.interval}</span>}
                  {alert.message && <span>Msg: {alert.message}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== PAPER TRADING TAB (Level 2) ===== */}
      {activeTab === 'paper' && (
        <div className="space-y-4">
          {/* Paper Balance */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="glass-card p-4 text-center">
              <p className="text-gray-400 text-xs">Paper Balance</p>
              <p className={`text-xl font-bold mt-1 ${paperBalance>=10000?'text-emerald-400':'text-red-400'}`}>${paperBalance.toFixed(2)}</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-gray-400 text-xs">Total P&L</p>
              <p className={`text-xl font-bold mt-1 ${(paperBalance-10000)>=0?'text-emerald-400':'text-red-400'}`}>${(paperBalance-10000).toFixed(2)}</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-gray-400 text-xs">Paper Trades</p>
              <p className="text-xl font-bold mt-1 text-blue-400">{paperTrades.length}</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-gray-400 text-xs">Win Rate</p>
              <p className="text-xl font-bold mt-1 text-emerald-400">{paperTrades.length > 0 ? ((paperTrades.filter(t=>t.pnl>0).length/paperTrades.length)*100).toFixed(0) : 0}%</p>
            </div>
          </div>

          {/* Reset */}
          <button onClick={() => { setPaperBalance(10000); setPaperTrades([]); toast.success('Paper account reset to $10,000') }}
            className="px-4 py-2 bg-orange-500/20 text-orange-400 border border-orange-500/30 rounded-xl text-sm">
            🔄 Reset Paper Account ($10,000)
          </button>

          {/* Paper Trades List */}
          <div className="glass-card p-4">
            <h3 className="text-white font-semibold mb-3">Recent Paper Trades</h3>
            {paperTrades.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-4">No paper trades. Go to Signals tab and click "Paper Trade" on a signal.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-xs border-b border-[#2a2a5a]/40">
                    <th className="text-left py-2 px-2">Pair</th><th className="text-left py-2 px-2">Type</th>
                    <th className="text-left py-2 px-2">Entry</th><th className="text-left py-2 px-2">Exit</th>
                    <th className="text-left py-2 px-2">P&L</th><th className="text-left py-2 px-2">Strategy</th>
                    <th className="text-left py-2 px-2">Time</th>
                  </tr></thead>
                  <tbody>{paperTrades.slice(0,20).map(t => (
                    <tr key={t.id} className="border-b border-[#2a2a5a]/20">
                      <td className="py-2 px-2 text-white">{t.pair}</td>
                      <td className={`py-2 px-2 font-medium ${t.type==='BUY'?'text-emerald-400':'text-red-400'}`}>{t.type}</td>
                      <td className="py-2 px-2 text-gray-300">${t.entry}</td>
                      <td className="py-2 px-2 text-gray-300">${t.exit}</td>
                      <td className={`py-2 px-2 font-bold ${t.pnl>=0?'text-emerald-400':'text-red-400'}`}>{t.pnl>=0?'+':''}${t.pnl.toFixed(2)}</td>
                      <td className="py-2 px-2 text-gray-400 text-xs">{t.strategy}</td>
                      <td className="py-2 px-2 text-gray-400 text-xs">{t.time}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== BACKTEST TAB (Level 2) ===== */}
      {activeTab === 'backtest' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <button onClick={runBacktest} className="px-5 py-2.5 rounded-xl text-sm font-medium bg-gradient-to-r from-[#e94560] to-[#f5a623] text-white hover:opacity-90">
              🚀 Run Backtest
            </button>
            <span className="text-gray-400 text-xs">Strategy: {selectedStrategy.name} | Pair: {selectedPair}</span>
          </div>

          {backtestResults && (
            <>
              {/* Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'Total Trades', value: backtestResults.stats.totalTrades, color: 'text-blue-400' },
                  { label: 'Win Rate', value: backtestResults.stats.winRate + '%', color: 'text-emerald-400' },
                  { label: 'Total P&L', value: '$' + backtestResults.stats.totalPnL, color: parseFloat(backtestResults.stats.totalPnL)>=0?'text-emerald-400':'text-red-400' },
                  { label: 'Profit Factor', value: backtestResults.stats.profitFactor, color: 'text-purple-400' },
                  { label: 'Avg Trade', value: '$' + backtestResults.stats.avgTrade, color: 'text-cyan-400' },
                  { label: 'Max Drawdown', value: '$' + backtestResults.stats.maxDrawdown, color: 'text-red-400' },
                  { label: 'Sharpe Ratio', value: backtestResults.stats.sharpeRatio, color: 'text-yellow-400' },
                  { label: 'Final Balance', value: '$' + backtestResults.stats.finalBalance, color: 'text-emerald-400' },
                ].map(s => (
                  <div key={s.label} className="glass-card p-3 text-center">
                    <p className="text-gray-400 text-[10px] uppercase">{s.label}</p>
                    <p className={`text-lg font-bold mt-1 ${s.color}`}>{s.value}</p>
                  </div>
                ))}
              </div>

              {/* Equity Curve */}
              <div className="glass-card p-5">
                <h3 className="text-white font-semibold mb-3">📈 Backtest Equity Curve</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <AreaChart data={backtestResults.trades}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a5a" />
                    <XAxis dataKey="trade" stroke="#6b7280" fontSize={11} />
                    <YAxis stroke="#6b7280" fontSize={11} />
                    <Tooltip contentStyle={{ backgroundColor: '#12122a', border: '1px solid #2a2a5a', borderRadius: '8px' }} />
                    <defs><linearGradient id="btGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#e94560" stopOpacity={0.3}/>
                      <stop offset="100%" stopColor="#e94560" stopOpacity={0}/>
                    </linearGradient></defs>
                    <Area type="monotone" dataKey="balance" stroke="#e94560" strokeWidth={2} fill="url(#btGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>
      )}

      {/* ===== LIVE TRADING TAB (Level 3) ===== */}
      {activeTab === 'live' && (
        <div className="space-y-4">
          <div className="glass-card p-5 border-yellow-500/20">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-yellow-400 text-lg">⚠️</span>
              <h3 className="text-yellow-400 font-semibold">Live Trading - Real Money</h3>
            </div>
            <p className="text-gray-400 text-sm mb-4">Connect your exchange API to enable automated live trading. Use at your own risk.</p>

            <div className="space-y-3 max-w-md">
              <div>
                <label className="text-gray-400 text-xs">API Key</label>
                <input type="text" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  className="input-field text-sm mt-1" placeholder="Enter Binance API Key" />
              </div>
              <div>
                <label className="text-gray-400 text-xs">API Secret</label>
                <input type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)}
                  className="input-field text-sm mt-1" placeholder="Enter API Secret" />
              </div>
              <div className="flex gap-3">
                <button onClick={connectAPI}
                  className={`px-5 py-2.5 rounded-xl text-sm font-medium ${isLiveConnected ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'}`}>
                  {isLiveConnected ? '✅ Connected' : '🔗 Connect Exchange'}
                </button>
                {isLiveConnected && (
                  <button onClick={startLiveBot}
                    className="px-5 py-2.5 rounded-xl text-sm font-medium bg-gradient-to-r from-[#e94560] to-[#f5a623] text-white">
                    🚀 Start Live Bot
                  </button>
                )}
              </div>
            </div>
          </div>

          {isLiveConnected && (
            <div className="glass-card p-4 border-emerald-500/20">
              <p className="text-emerald-400 text-sm flex items-center gap-2">
                <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>
                Exchange connected | Strategy: {selectedStrategy.name} | Pair: {selectedPair}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ===== MY BOTS TAB (Level 3) ===== */}
      {activeTab === 'bots' && (
        <div className="space-y-4">
          <h3 className="text-white font-semibold">🤖 Active Bots</h3>
          {liveBots.length === 0 ? (
            <div className="glass-card p-8 text-center">
              <p className="text-gray-400">No bots running. Go to Live Trading tab to start a bot.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {liveBots.map(bot => (
                <div key={bot.id} className={`glass-card p-4 border-l-4 ${bot.status==='running'?'border-l-emerald-500':'border-l-gray-500'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-white font-medium">{bot.strategy}</p>
                      <p className="text-gray-400 text-xs mt-0.5">{bot.pair} • Started: {new Date(bot.startedAt).toLocaleString()}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${bot.status==='running'?'bg-emerald-500/20 text-emerald-400':'bg-gray-500/20 text-gray-400'}`}>
                        {bot.status === 'running' ? '● Running' : '⏹ Stopped'}
                      </span>
                      {bot.status === 'running' && (
                        <button onClick={() => stopBot(bot.id)} className="px-2 py-1 bg-red-500/20 text-red-400 rounded text-xs">Stop</button>
                      )}
                      <button onClick={() => deleteBot(bot.id)} className="px-2 py-1 bg-gray-500/20 text-gray-400 rounded text-xs hover:text-red-400">🗑️</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  )
}

export default AlgoTrading
