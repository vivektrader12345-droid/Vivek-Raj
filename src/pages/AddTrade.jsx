import React, { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTrades } from '../context/TradeContext'
import { PlusCircle, Save, ArrowLeft, Calculator } from 'lucide-react'
import ClockPicker from '../components/ClockPicker'
import CustomSelect from '../components/CustomSelect'
import toast from 'react-hot-toast'

const PAIRS = [
  'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT',
  'DOGE/USDT', 'ADA/USDT', 'AVAX/USDT', 'DOT/USDT', 'MATIC/USDT',
  'LINK/USDT', 'UNI/USDT', 'ATOM/USDT', 'LTC/USDT', 'FIL/USDT',
  'APT/USDT', 'ARB/USDT', 'OP/USDT', 'NEAR/USDT', 'INJ/USDT',
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF',
  'USD/CAD', 'NZD/USD', 'GBP/JPY', 'EUR/GBP', 'EUR/JPY',
]

const STRATEGIES = [
  'Scalping', 'Day Trade', 'Swing Trade', 'Position Trade',
  'Breakout', 'Breakdown', 'Support/Resistance', 'Trend Following',
  'Mean Reversion', 'Fibonacci', 'Supply & Demand', 'Order Block',
  'News Trading', 'Gap Trading', 'Momentum', 'VWAP', 'Other'
]

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M']

const TRADE_SESSIONS = ['London', 'New York', 'Tokyo', 'Sydney', 'Overlap (London/NY)', 'Pre-Market', 'After Hours']

const EMOTIONS = [
  { value: 'confident', label: '😎 Confident', color: 'text-green-400' },
  { value: 'calm', label: '😌 Calm', color: 'text-blue-400' },
  { value: 'anxious', label: '😰 Anxious', color: 'text-yellow-400' },
  { value: 'fearful', label: '😨 Fearful', color: 'text-orange-400' },
  { value: 'greedy', label: '🤑 Greedy', color: 'text-red-400' },
  { value: 'fomo', label: '😤 FOMO', color: 'text-purple-400' },
  { value: 'revenge', label: '😡 Revenge', color: 'text-red-500' },
  { value: 'neutral', label: '😐 Neutral', color: 'text-gray-400' },
]

function AddTrade() {
  const { addTrade, updateTrade, getTradeById } = useTrades()
  const navigate = useNavigate()
  const { id } = useParams()
  const isEditing = Boolean(id)

  const [showCustomStrategy, setShowCustomStrategy] = useState(false)
  const [customStrategies, setCustomStrategies] = useState(() => {
    const saved = localStorage.getItem('vmt_custom_strategies')
    return saved ? JSON.parse(saved) : []
  })

  const [form, setForm] = useState({
    pair: '',
    type: 'long',
    entryPrice: '',
    exitPrice: '',
    quantity: '',
    leverage: '1',
    stopLoss: '',
    takeProfit: '',
    fees: '',
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().slice(0, 5),
    strategy: '',
    timeframe: '',
    emotion: '',
    rating: 3,
    notes: '',
    tags: '',
    screenshot: '',
    session: '',
    week: '',
    riskReward: '',
    reaction: '',
    slHit: 'No',
    trailSL: 'No',
    reEntry: 'No',
    reTarget: 'No',
    highBreakOut: 'No',
    result: '',
    entryTime: new Date().toTimeString().slice(0, 5),
    exitTime: '',
    exitTimeHour: '',
    exitTimeMin: '',
    exitTimeAmPm: 'AM',
    volume: '',
    holdTime: '',
    slPercent: '',
    targetPercent: '',
    capturePercent: '',
    pnlAmount: '',
    entryMargin: '',
    exitMargin: '',
    reasonToBuy: '',
    prepared: 'Yes',
    tradeImage: '',
    tradeImageName: '',
    status: 'closed',
  })

  useEffect(() => {
    if (isEditing) {
      const trade = getTradeById(id)
      if (trade) {
        setForm({
          pair: trade.pair || '',
          type: trade.type || 'long',
          entryPrice: trade.entryPrice || '',
          exitPrice: trade.exitPrice || '',
          quantity: trade.quantity || '',
          leverage: trade.leverage || '1',
          stopLoss: trade.stopLoss || '',
          takeProfit: trade.takeProfit || '',
          fees: trade.fees || '',
          date: trade.date || '',
          time: trade.time || '',
          strategy: trade.strategy || '',
          timeframe: trade.timeframe || '',
          emotion: trade.emotion || '',
          rating: trade.rating || 3,
          notes: trade.notes || '',
          tags: trade.tags || '',
          screenshot: trade.screenshot || '',
          session: trade.session || '',
          status: trade.status || 'closed',
        })
      }
    }
  }, [id, isEditing])

  const handleChange = (e) => {
    const { name, value } = e.target
    setForm(prev => ({ ...prev, [name]: value }))
  }

  // Calculate live P&L preview
  const calculatePreviewPnL = () => {
    const entry = parseFloat(form.entryPrice) || 0
    const exit = parseFloat(form.exitPrice) || 0
    const qty = parseFloat(form.quantity) || 0
    const leverage = parseFloat(form.leverage) || 1
    const fees = parseFloat(form.fees) || 0

    if (!entry || !exit || !qty) return null

    let pnl = 0
    if (form.type === 'long') {
      pnl = (exit - entry) * qty * leverage
    } else {
      pnl = (entry - exit) * qty * leverage
    }
    pnl -= fees
    return parseFloat(pnl.toFixed(2))
  }

  const previewPnL = calculatePreviewPnL()

  const handleSubmit = (e) => {
    e.preventDefault()

    if (!form.pair) {
      toast.error('Please select a trading pair')
      return
    }
    if (!form.entryPrice || parseFloat(form.entryPrice) <= 0) {
      toast.error('Please enter a valid entry price')
      return
    }
    if (!form.exitPrice || parseFloat(form.exitPrice) <= 0) {
      toast.error('Please enter a valid exit price')
      return
    }
    if (!form.quantity || parseFloat(form.quantity) <= 0) {
      toast.error('Please enter a valid quantity')
      return
    }

    if (isEditing) {
      updateTrade(id, form)
      toast.success('Trade updated successfully!')
    } else {
      addTrade(form)
      toast.success('Trade added successfully! 🎉')
    }

    navigate('/history')
  }

  const handleReset = () => {
    setForm({
      pair: '', type: 'long', entryPrice: '', exitPrice: '', quantity: '',
      leverage: '1', stopLoss: '', takeProfit: '', fees: '',
      date: new Date().toISOString().split('T')[0], time: new Date().toTimeString().slice(0, 5),
      strategy: '', timeframe: '', emotion: '', rating: 3, notes: '', tags: '', screenshot: '', session: '', week: '', riskReward: '', reaction: '', slHit: 'No', trailSL: 'No', reEntry: 'No', reTarget: 'No', highBreakOut: 'No', result: '', entryTime: new Date().toTimeString().slice(0, 5), exitTime: '', exitTimeHour: '', exitTimeMin: '', exitTimeAmPm: 'AM', volume: '', holdTime: '', slPercent: '', targetPercent: '', capturePercent: '', pnlAmount: '', entryMargin: '', exitMargin: '', reasonToBuy: '', prepared: 'Yes', tradeImage: '', tradeImageName: '', status: 'closed',
    })
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button onClick={() => navigate(-1)} className="p-2 rounded-lg bg-[#1a1a2e] border border-[#0f3460] hover:border-[#e94560] transition-colors">
          <ArrowLeft size={20} className="text-gray-400" />
        </button>
        <div>
          <h1 className="text-2xl lg:text-3xl font-bold text-white flex items-center gap-3">
            {isEditing ? <Save className="text-blue-400" /> : <PlusCircle className="text-[#e94560]" />}
            {isEditing ? 'Edit Trade' : 'Add New Trade'}
          </h1>
          <p className="text-gray-400 mt-1 text-sm">{isEditing ? 'Update your trade details' : 'Log your latest trade details'}</p>
        </div>
      </div>

      {/* P&L Preview */}
      {previewPnL !== null && (
        <div className={`glass-card p-4 mb-6 flex items-center justify-between ${previewPnL >= 0 ? 'border-emerald-500/30' : 'border-red-500/30'}`}>
          <div className="flex items-center gap-2">
            <Calculator size={18} className="text-gray-400" />
            <span className="text-gray-400 text-sm">Estimated P&L:</span>
          </div>
          <span className={`text-xl font-bold ${previewPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {previewPnL >= 0 ? '+' : ''}${previewPnL}
          </span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Section 1: Basic Trade Info */}
        <div className="glass-card p-6">
          <h2 className="text-white font-semibold mb-4 text-sm uppercase tracking-wider">Trade Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Pair */}
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Trading Pair *</label>
              <CustomSelect name="pair" value={form.pair} onChange={handleChange}
                options={PAIRS} placeholder="Select pair" storageKey="vmt_custom_pairs" />
            </div>

            {/* Type */}
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Direction *</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setForm(prev => ({ ...prev, type: 'long' }))}
                  className={`flex-1 py-3 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2 ${form.type === 'long' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 shadow-lg shadow-emerald-500/10' : 'bg-[#0a0a1a] border border-[#0f3460] text-gray-400 hover:border-emerald-500/30'}`}>
                  📈 Long
                </button>
                <button type="button" onClick={() => setForm(prev => ({ ...prev, type: 'short' }))}
                  className={`flex-1 py-3 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2 ${form.type === 'short' ? 'bg-red-500/20 text-red-400 border border-red-500/50 shadow-lg shadow-red-500/10' : 'bg-[#0a0a1a] border border-[#0f3460] text-gray-400 hover:border-red-500/30'}`}>
                  📉 Short
                </button>
              </div>
            </div>

            {/* Status */}
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Status</label>
              <CustomSelect name="status" value={form.status} onChange={handleChange}
                options={[{value:'closed',label:'Closed'},{value:'open',label:'Open (Running)'},{value:'cancelled',label:'Cancelled'}]}
                placeholder="Select status" storageKey="vmt_custom_statuses" />
            </div>
          </div>
        </div>

        {/* Section 2: Price & Size */}
        <div className="glass-card p-6">
          <h2 className="text-white font-semibold mb-4 text-sm uppercase tracking-wider">Price & Size</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Entry Price *</label>
              <input type="number" name="entryPrice" value={form.entryPrice} onChange={handleChange} step="any" className="input-field" placeholder="0.00" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Exit Price *</label>
              <input type="number" name="exitPrice" value={form.exitPrice} onChange={handleChange} step="any" className="input-field" placeholder="0.00" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Quantity *</label>
              <input type="number" name="quantity" value={form.quantity} onChange={handleChange} step="any" className="input-field" placeholder="Amount" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Leverage</label>
              <input type="number" name="leverage" value={form.leverage} onChange={handleChange} step="1" min="1" className="input-field" placeholder="1x" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Stop Loss</label>
              <input type="number" name="stopLoss" value={form.stopLoss} onChange={handleChange} step="any" className="input-field" placeholder="SL price" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Take Profit</label>
              <input type="number" name="takeProfit" value={form.takeProfit} onChange={handleChange} step="any" className="input-field" placeholder="TP price" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Fees / Commission</label>
              <input type="number" name="fees" value={form.fees} onChange={handleChange} step="any" className="input-field" placeholder="0.00" />
            </div>
          </div>
        </div>

        {/* Section 3: Timing & Strategy / Trade Execution - Tabbed */}
        <div className="glass-card p-6">
          {/* Tab Headers */}
          <div className="flex mb-5 border-b border-[#0f3460]/50">
            <button type="button" onClick={() => setForm(p => ({ ...p, _activeTab: 'timing' }))}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-all ${(!form._activeTab || form._activeTab === 'timing') ? 'border-[#e94560] text-[#e94560]' : 'border-transparent text-gray-400 hover:text-white'}`}>
              ⏱️ Timing & Strategy
            </button>
            <button type="button" onClick={() => setForm(p => ({ ...p, _activeTab: 'execution' }))}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-all ${form._activeTab === 'execution' ? 'border-[#e94560] text-[#e94560]' : 'border-transparent text-gray-400 hover:text-white'}`}>
              🎯 Trade Execution
            </button>
            <button type="button" onClick={() => setForm(p => ({ ...p, _activeTab: 'margins' }))}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-all ${form._activeTab === 'margins' ? 'border-[#e94560] text-[#e94560]' : 'border-transparent text-gray-400 hover:text-white'}`}>
              💰 Margins & P&L
            </button>
          </div>

          {/* Timing & Strategy Content */}
          {(!form._activeTab || form._activeTab === 'timing') && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Date</label>
              <input type="date" name="date" value={form.date} onChange={handleChange} className="input-field" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Time</label>
              <input type="time" name="time" value={form.time} onChange={handleChange} className="input-field" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Timeframe</label>
              <CustomSelect name="timeframe" value={form.timeframe} onChange={handleChange}
                options={TIMEFRAMES} placeholder="Select timeframe" storageKey="vmt_custom_timeframes" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Strategy</label>
              {showCustomStrategy ? (
                <div className="flex gap-2">
                  <input type="text" placeholder="Enter custom strategy" className="input-field flex-1"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        const val = e.target.value.trim()
                        if (val) {
                          const updated = [...customStrategies, val]
                          setCustomStrategies(updated)
                          localStorage.setItem('vmt_custom_strategies', JSON.stringify(updated))
                          setForm(prev => ({ ...prev, strategy: val }))
                          setShowCustomStrategy(false)
                        }
                      }
                    }}
                  />
                  <button type="button" onClick={() => setShowCustomStrategy(false)}
                    className="px-3 py-2 border border-[#0f3460] rounded-lg text-gray-400 hover:text-white text-sm">Cancel</button>
                </div>
              ) : (
                <select name="strategy" value={form.strategy} onChange={(e) => {
                  if (e.target.value === '__custom__') { setShowCustomStrategy(true) }
                  else { setForm(prev => ({ ...prev, strategy: e.target.value })) }
                }} className="input-field">
                  <option value="">Select strategy</option>
                  {STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
                  {customStrategies.map(s => <option key={`c-${s}`} value={s}>⭐ {s}</option>)}
                  <option value="__custom__">➕ Add Custom...</option>
                </select>
              )}
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Trading Session</label>
              <CustomSelect name="session" value={form.session} onChange={handleChange}
                options={TRADE_SESSIONS} placeholder="Select session" storageKey="vmt_custom_sessions" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Tags (comma separated)</label>
              <input type="text" name="tags" value={form.tags} onChange={handleChange} className="input-field" placeholder="e.g., breakout, crypto" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Week</label>
              <CustomSelect name="week" value={form.week} onChange={handleChange}
                options={['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']}
                placeholder="Select day" storageKey="vmt_custom_weeks" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Risk Reward Ratio</label>
              <CustomSelect name="riskReward" value={form.riskReward} onChange={handleChange}
                options={['1:1','1:2','1:3','1:4','1:5','1:6','1:8','1:10','2:1','3:1']}
                placeholder="Select R:R" storageKey="vmt_custom_rr" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Reaction</label>
              <CustomSelect name="reaction" value={form.reaction} onChange={handleChange}
                options={[
                  {value:'followed_plan',label:'✅ Followed Plan'},{value:'broke_rules',label:'❌ Broke Rules'},
                  {value:'fomo_entry',label:'😤 FOMO Entry'},{value:'revenge_trade',label:'😡 Revenge Trade'},
                  {value:'overtraded',label:'⚠️ Overtraded'},{value:'early_exit',label:'🏃 Early Exit'},
                  {value:'late_entry',label:'⏰ Late Entry'},{value:'perfect_execution',label:'🎯 Perfect Execution'},
                  {value:'lucky_trade',label:'🍀 Lucky Trade'},{value:'held_too_long',label:'⏳ Held Too Long'}
                ]}
                placeholder="Select reaction" storageKey="vmt_custom_reactions" />
            </div>
          </div>
          )}

          {/* Trade Execution Content */}
          {form._activeTab === 'execution' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">SL Hit</label>
              <CustomSelect name="slHit" value={form.slHit} onChange={handleChange}
                options={['No','Yes']} placeholder="Select" storageKey="vmt_custom_slhit" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Trail/SL</label>
              <CustomSelect name="trailSL" value={form.trailSL} onChange={handleChange}
                options={['No','Yes']} placeholder="Select" storageKey="vmt_custom_trailsl" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Re Entry</label>
              <CustomSelect name="reEntry" value={form.reEntry} onChange={handleChange}
                options={['No','Yes']} placeholder="Select" storageKey="vmt_custom_reentry" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Re Target</label>
              <CustomSelect name="reTarget" value={form.reTarget} onChange={handleChange}
                options={['No','Yes']} placeholder="Select" storageKey="vmt_custom_retarget" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">High Break Out</label>
              <CustomSelect name="highBreakOut" value={form.highBreakOut} onChange={handleChange}
                options={['No','Yes']} placeholder="Select" storageKey="vmt_custom_breakout" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Result</label>
              <CustomSelect name="result" value={form.result} onChange={handleChange}
                options={[{value:'Profit',label:'Profit ✅'},{value:'Loss',label:'Loss ❌'},{value:'Breakeven',label:'Breakeven ➖'}]}
                placeholder="Select result" storageKey="vmt_custom_results" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Entry Time</label>
              <input type="time" name="entryTime" value={form.entryTime} onChange={handleChange} className="input-field" />
            </div>
            <ClockPicker
              label="Exit Time"
              value={form.exitTime}
              onChange={(val) => setForm(prev => ({ ...prev, exitTime: val }))}
            />
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Volume</label>
              <CustomSelect name="volume" value={form.volume} onChange={handleChange}
                options={['High','Medium','Low']}
                placeholder="Select volume" storageKey="vmt_custom_volumes" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Hold Time</label>
              <CustomSelect name="holdTime" value={form.holdTime} onChange={handleChange}
                options={['1 min','2 min','3 min','5 min','10 min','15 min','20 min','30 min','45 min','1 hr','1 hr 30 min','2 hr','3 hr','4 hr','5 hr','6 hr','8 hr','12 hr','1 day','2 days','3 days','1 week','2 weeks','1 month']}
                placeholder="Select" storageKey="vmt_custom_holdtimes" />
            </div>
          </div>
          )}

          {/* Margins & P&L Content */}
          {form._activeTab === 'margins' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">SL%</label>
              <input type="text" name="slPercent" value={form.slPercent} onChange={handleChange} className="input-field" placeholder="e.g. 0.27%" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Target%</label>
              <input type="text" name="targetPercent" value={form.targetPercent} onChange={handleChange} className="input-field" placeholder="e.g. 0.75%" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Capture%</label>
              <input type="text" name="capturePercent" value={form.capturePercent} onChange={handleChange} className="input-field" placeholder="e.g. 0.56%" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Profit/Loss Amount ($)</label>
              <input type="number" name="pnlAmount" value={form.pnlAmount} onChange={handleChange} step="any" className="input-field" placeholder="264.49" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Entry Margin ($)</label>
              <input type="number" name="entryMargin" value={form.entryMargin} onChange={handleChange} step="any" className="input-field" placeholder="Entry margin" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Exit Margin ($)</label>
              <input type="number" name="exitMargin" value={form.exitMargin} onChange={handleChange} step="any" className="input-field" placeholder="Exit margin" />
            </div>
          </div>
          )}
        </div>

        {/* Section 5: Psychology */}
        {/* Section 5: Psychology & Trade Reason - Tabbed */}
        <div className="glass-card p-6">
          {/* Tab Headers */}
          <div className="flex mb-5 border-b border-[#0f3460]/50">
            <button type="button" onClick={() => setForm(p => ({ ...p, _psychTab: 'psychology' }))}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-all ${(!form._psychTab || form._psychTab === 'psychology') ? 'border-[#e94560] text-[#e94560]' : 'border-transparent text-gray-400 hover:text-white'}`}>
              🧠 Psychology & Notes
            </button>
            <button type="button" onClick={() => setForm(p => ({ ...p, _psychTab: 'reason' }))}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-all ${form._psychTab === 'reason' ? 'border-[#e94560] text-[#e94560]' : 'border-transparent text-gray-400 hover:text-white'}`}>
              📝 Reason & Image
            </button>
          </div>

          {/* Psychology Content */}
          {(!form._psychTab || form._psychTab === 'psychology') && (
          <div>
          {/* Emotion */}
          <div className="mb-4">
            <label className="block text-gray-400 text-sm mb-2">How were you feeling?</label>
            <div className="flex flex-wrap gap-2">
              {EMOTIONS.map(em => (
                <button key={em.value} type="button" onClick={() => setForm(prev => ({ ...prev, emotion: em.value }))}
                  className={`px-3 py-2 rounded-lg text-sm transition-all ${form.emotion === em.value ? `${em.color} bg-white/5 border border-current` : 'text-gray-400 bg-[#0a0a1a] border border-[#0f3460] hover:border-gray-400'}`}>
                  {em.label}
                </button>
              ))}
            </div>
          </div>

          {/* Rating */}
          <div className="mb-4">
            <label className="block text-gray-400 text-sm mb-2">Trade Quality Rating</label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map(star => (
                <button key={star} type="button" onClick={() => setForm(prev => ({ ...prev, rating: star }))}
                  className={`text-2xl transition-transform hover:scale-125 ${star <= form.rating ? 'opacity-100' : 'opacity-30'}`}>
                  ⭐
                </button>
              ))}
              <span className="text-gray-400 text-sm ml-2 self-center">{form.rating}/5</span>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-gray-400 text-sm mb-1.5">Notes / Lesson Learned</label>
            <textarea name="notes" value={form.notes} onChange={handleChange} rows="4"
              className="input-field resize-none" placeholder="What did you learn from this trade? What went well? What would you do differently?" />
          </div>

          {/* Screenshot URL */}
          <div className="mt-4">
            <label className="block text-gray-400 text-sm mb-1.5">Screenshot URL (optional)</label>
            <input type="url" name="screenshot" value={form.screenshot} onChange={handleChange} className="input-field" placeholder="https://..." />
          </div>
          </div>
          )}

          {/* Reason & Image Content */}
          {form._psychTab === 'reason' && (
          <div className="space-y-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Reason to Buy/Sell</label>
              <input type="text" name="reasonToBuy" value={form.reasonToBuy} onChange={handleChange} className="input-field" placeholder="e.g. Support bounce, FVG fill, Break of structure" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Are You Prepared For This Trade?</label>
              <CustomSelect name="prepared" value={form.prepared} onChange={handleChange}
                options={[{value:'Yes',label:'Yes ✅'},{value:'No',label:'No ❌'}]}
                placeholder="Select" storageKey="vmt_custom_prepared" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Trade Image / PDF</label>
              <input type="file" accept="image/*,.pdf" onChange={(e) => {
                const file = e.target.files[0]
                if (file) {
                  const reader = new FileReader()
                  reader.onload = (ev) => setForm(prev => ({ ...prev, tradeImage: ev.target.result, tradeImageName: file.name }))
                  reader.readAsDataURL(file)
                }
              }} className="block w-full text-sm text-gray-400 file:mr-4 file:py-2.5 file:px-4 file:rounded-lg file:border file:border-[#0f3460] file:text-sm file:font-medium file:bg-[#0a0a1a] file:text-white hover:file:bg-[#0f3460] file:cursor-pointer file:transition-all" />
              {form.tradeImageName && (
                <p className="text-emerald-400 text-xs mt-2">📎 {form.tradeImageName}</p>
              )}
              {form.tradeImage && form.tradeImage.startsWith('data:image') && (
                <img src={form.tradeImage} alt="Trade" className="mt-3 rounded-lg max-h-48 object-cover border border-[#0f3460]" />
              )}
            </div>
          </div>
          )}
        </div>

        {/* Buttons */}
        <div className="flex gap-4">
          <button type="button" onClick={handleReset} className="flex-1 py-3 rounded-xl border border-[#0f3460] text-gray-400 hover:text-white hover:border-gray-400 transition-all font-medium">
            Reset Form
          </button>
          <button type="submit" className="flex-[2] btn-primary">
            {isEditing ? '💾 Update Trade' : '✅ Save Trade'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default AddTrade
