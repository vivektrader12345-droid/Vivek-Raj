/**
 * ProOrderPanel - TradingView Mobile-style Order Entry Panel
 * Professional bottom-sheet order panel with all order types,
 * leverage, TP/SL, validation, and live chart integration
 */
import React, { useState, useMemo, useEffect, useCallback } from 'react'
import useTradingStore from '../stores/tradingStore'
import useChartStore from '../stores/chartStore'
import useSettingsStore from '../stores/settingsStore'
import { OrderSide, OrderType, formatPrice, calculateRisk, calculateRiskPercent,
  calculateReward, calculateRewardPercent, calculateLiquidationPrice } from '../types'
import toast from 'react-hot-toast'

const ORDER_TYPES = [
  { id: 'market', label: 'Market' },
  { id: 'limit', label: 'Limit' },
  { id: 'stop', label: 'Stop' },
  { id: 'stop_limit', label: 'Stop Limit' },
  { id: 'trailing', label: 'Trailing' },
  { id: 'oco', label: 'OCO' },
]

const LEVERAGE_PRESETS = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125]
const QTY_PRESETS = [25, 50, 75, 100]

function ProOrderPanel({ onClose, initialSide = 'buy', initialPrice, initialSymbolDisplay, quoteStatus = 'unavailable' }) {
  const currentPrice = useTradingStore(s => s.currentPrice)
  const account = useTradingStore(s => s.account)
  const placeOrder = useTradingStore(s => s.placeOrder)
  const { symbolDisplay } = useChartStore()
  const showConfirmation = useSettingsStore(s => s.showConfirmation)
  const draftPrice = Number.isFinite(Number(initialPrice)) && Number(initialPrice) > 0 ? Number(initialPrice) : null
  const orderSymbolDisplay = initialSymbolDisplay || symbolDisplay

  // Order state
  const [side, setSide] = useState(initialSide)
  const [orderType, setOrderType] = useState('market')
  const [qty, setQty] = useState('1')
  const [qtyMode, setQtyMode] = useState('units') // units, contracts, usdt
  const [leverage, setLeverage] = useState(10)
  const [marginMode, setMarginMode] = useState('cross') // cross, isolated
  const [limitPrice, setLimitPrice] = useState(draftPrice ? String(draftPrice) : '')
  const [stopPrice, setStopPrice] = useState(draftPrice ? String(draftPrice) : '')
  const [trailingDelta, setTrailingDelta] = useState('1')

  // TP/SL state
  const [tpEnabled, setTpEnabled] = useState(false)
  const [slEnabled, setSlEnabled] = useState(true)
  const [tpLevels, setTpLevels] = useState([{ price: '', pct: '' }])
  const [slPrice, setSlPrice] = useState('')
  const [slPct, setSlPct] = useState('')
  const [trailingSL, setTrailingSL] = useState(false)

  // UI state
  const [showAdvanced, setShowAdvanced] = useState(false)

  useEffect(() => {
    setSide(initialSide)
    if (draftPrice) {
      setLimitPrice(String(draftPrice))
      setStopPrice(String(draftPrice))
    }
  }, [draftPrice, initialSide])

  // Auto-set prices when order type or side changes
  useEffect(() => {
    if (currentPrice > 0) {
      if (!limitPrice) setLimitPrice(currentPrice.toFixed(2))
      if (!stopPrice) setStopPrice(currentPrice.toFixed(2))
      if (slEnabled && !slPrice) {
        const sl = side === 'buy'
          ? (currentPrice * 0.99).toFixed(2)
          : (currentPrice * 1.01).toFixed(2)
        setSlPrice(sl)
        setSlPct('1.00')
      }
      if (tpEnabled && tpLevels[0] && !tpLevels[0].price) {
        const tp = side === 'buy'
          ? (currentPrice * 1.02).toFixed(2)
          : (currentPrice * 0.98).toFixed(2)
        setTpLevels([{ price: tp, pct: '2.00' }])
      }
    }
  }, [currentPrice, side, tpEnabled, slEnabled])

  // Computed values
  const computed = useMemo(() => {
    const qtyNum = parseFloat(qty) || 0
    const price = orderType === 'market' ? currentPrice
      : orderType === 'stop_limit' ? (parseFloat(limitPrice) || currentPrice)
      : (parseFloat(limitPrice) || parseFloat(stopPrice) || currentPrice)
    const tradeValue = price * qtyNum
    const margin = tradeValue / leverage
    const feeRate = orderType === 'market' ? 0.0004 : 0.0002
    const fee = tradeValue * feeRate
    const makerFee = tradeValue * 0.0002
    const takerFee = tradeValue * 0.0004
    const liqPrice = calculateLiquidationPrice(price, side, leverage)
    const maxPosition = account.availableMargin * leverage
    const maxQty = price > 0 ? maxPosition / price : 0

    const slNum = parseFloat(slPrice) || 0
    const risk = slNum > 0 ? calculateRisk(side, price, slNum, qtyNum, leverage) : 0
    const riskPct = calculateRiskPercent(risk, margin)

    const tpNum = parseFloat(tpLevels[0]?.price) || 0
    const reward = tpNum > 0 ? calculateReward(side, price, tpNum, qtyNum, leverage) : 0
    const rewardPct = calculateRewardPercent(reward, margin)
    const rrRatio = risk > 0 ? reward / risk : 0

    const spread = currentPrice > 0 ? (currentPrice * 0.0001).toFixed(2) : '0.00'
    const bidPrice = currentPrice > 0 ? (currentPrice - parseFloat(spread)/2).toFixed(2) : '0.00'
    const askPrice = currentPrice > 0 ? (currentPrice + parseFloat(spread)/2).toFixed(2) : '0.00'

    return { qtyNum, price, tradeValue, margin, fee, makerFee, takerFee,
      liqPrice, maxPosition, maxQty, risk, riskPct, reward, rewardPct,
      rrRatio, spread, bidPrice, askPrice }
  }, [qty, leverage, currentPrice, limitPrice, stopPrice, orderType, side, slPrice, tpLevels, account])

  // Validation
  const validation = useMemo(() => {
    const errors = []
    if (computed.qtyNum <= 0) errors.push('Quantity must be greater than 0')
    if (computed.margin > account.availableMargin) errors.push('Insufficient margin')
    if (orderType !== 'market' && (!parseFloat(limitPrice) || parseFloat(limitPrice) <= 0))
      errors.push('Invalid price')
    if (orderType === 'stop' || orderType === 'stop_limit') {
      if (!parseFloat(stopPrice) || parseFloat(stopPrice) <= 0) errors.push('Invalid stop price')
    }
    if (slEnabled && slPrice) {
      const sl = parseFloat(slPrice)
      if (side === 'buy' && sl >= currentPrice) errors.push('SL must be below entry for Long')
      if (side === 'sell' && sl <= currentPrice) errors.push('SL must be above entry for Short')
    }
    if (tpEnabled && tpLevels[0]?.price) {
      const tp = parseFloat(tpLevels[0].price)
      if (side === 'buy' && tp <= currentPrice) errors.push('TP must be above entry for Long')
      if (side === 'sell' && tp >= currentPrice) errors.push('TP must be below entry for Short')
    }
    return { valid: errors.length === 0, errors }
  }, [computed, orderType, limitPrice, stopPrice, side, currentPrice, slEnabled, slPrice, tpEnabled, tpLevels, account])

  // Set qty by margin %
  const setQtyByPct = (pct) => {
    if (!currentPrice) return
    const available = account.availableMargin * (pct / 100)
    const maxQ = (available * leverage) / currentPrice
    setQty(maxQ.toFixed(4))
  }

  // Update SL by percentage
  const updateSlByPct = (pct) => {
    if (!currentPrice) return
    setSlPct(pct)
    const p = parseFloat(pct) / 100
    const sl = side === 'buy' ? currentPrice * (1 - p) : currentPrice * (1 + p)
    setSlPrice(sl.toFixed(2))
  }

  // Update TP by percentage
  const updateTpByPct = (idx, pct) => {
    if (!currentPrice) return
    const p = parseFloat(pct) / 100
    const tp = side === 'buy' ? currentPrice * (1 + p) : currentPrice * (1 - p)
    const updated = [...tpLevels]
    updated[idx] = { price: tp.toFixed(2), pct }
    setTpLevels(updated)
  }

  // Add TP level
  const addTpLevel = () => {
    if (tpLevels.length >= 5) return
    setTpLevels([...tpLevels, { price: '', pct: '' }])
  }

  // Remove TP level
  const removeTpLevel = (idx) => {
    if (tpLevels.length <= 1) return
    setTpLevels(tpLevels.filter((_, i) => i !== idx))
  }

  // Place order
  const handlePlaceOrder = () => {
    if (!validation.valid) {
      toast.error(validation.errors[0])
      return
    }
    if (showConfirmation && !window.confirm(`${side.toUpperCase()} ${qty} ${orderSymbolDisplay} at ${orderType === 'market' ? 'market' : `$${formatPrice(computed.price)}`} with ${leverage}x leverage?`)) return
    const result = placeOrder({
      symbol: orderSymbolDisplay,
      side,
      type: orderType === 'trailing' ? 'stop' : (orderType === 'oco' ? 'limit' : orderType === 'stop_limit' ? 'limit' : orderType),
      qty: computed.qtyNum,
      price: computed.price,
      leverage,
      stopLoss: slEnabled ? parseFloat(slPrice) : null,
      takeProfit: tpEnabled ? parseFloat(tpLevels[0]?.price) : null,
      limitPrice: orderType !== 'market' ? computed.price : null,
    })
    if (result.success) {
      toast.success(`${side.toUpperCase()} ${qty} ${orderSymbolDisplay} @ $${formatPrice(computed.price)} (${leverage}x)`, { duration: 3000 })
      onClose?.()
    } else {
      toast.error(result.error || 'Order failed')
    }
  }

  // Reset form
  const handleReset = () => {
    setQty('1')
    setLeverage(10)
    setLimitPrice('')
    setStopPrice('')
    setSlPrice('')
    setTpLevels([{ price: '', pct: '' }])
    setSlPct('')
  }

  const isBuy = side === 'buy'

  return (
    <div
      className="space-y-3"
      data-paper-order-draft
      data-draft-side={side}
      data-draft-price={draftPrice || ''}
      data-draft-quote-status={quoteStatus}
    >
      <div className="pro-terminal-paper-draft-summary" role="status">
        <strong>Paper trading only</strong>
        <span>{draftPrice ? `Draft quote $${formatPrice(draftPrice)}` : 'Review market price before submitting'} · {quoteStatus}</span>
      </div>
      {/* ===== TOP SECTION: Pair + Live Bid/Ask + Buy/Sell ===== */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-white font-bold text-sm">{orderSymbolDisplay}</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${quoteStatus === 'current' ? 'bg-[#26a69a]/10 text-[#26a69a]' : quoteStatus === 'stale' ? 'bg-amber-400/10 text-amber-300' : 'bg-[#ef5350]/10 text-[#ef5350]'}`}>
              {quoteStatus === 'current' ? '● CURRENT' : quoteStatus === 'stale' ? '◷ STALE' : '○ UNAVAILABLE'}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-[10px] text-gray-400">Bid: <span className="text-[#26a69a]">${computed.bidPrice}</span></span>
            <span className="text-[10px] text-gray-400">Ask: <span className="text-[#ef5350]">${computed.askPrice}</span></span>
            <span className="text-[10px] text-gray-500">Spread: {computed.spread}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-white font-bold text-lg">${formatPrice(currentPrice)}</div>
          <div className="text-[9px] text-gray-500">{marginMode.toUpperCase()} • {leverage}x</div>
        </div>
      </div>

      {/* Large Buy/Sell Buttons */}
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => { setSide('sell'); }}
          className={`py-3 rounded-xl text-sm font-bold transition-all ${
            !isBuy ? 'bg-[#ef5350] text-white shadow-lg shadow-[#ef5350]/20 scale-[1.02]'
              : 'bg-[#ef5350]/10 text-[#ef5350] border border-[#ef5350]/20 hover:bg-[#ef5350]/20'
          }`}>
          SELL <span className="text-[10px] font-normal block">${computed.bidPrice}</span>
        </button>
        <button onClick={() => { setSide('buy'); }}
          className={`py-3 rounded-xl text-sm font-bold transition-all ${
            isBuy ? 'bg-[#26a69a] text-white shadow-lg shadow-[#26a69a]/20 scale-[1.02]'
              : 'bg-[#26a69a]/10 text-[#26a69a] border border-[#26a69a]/20 hover:bg-[#26a69a]/20'
          }`}>
          BUY <span className="text-[10px] font-normal block">${computed.askPrice}</span>
        </button>
      </div>

      {/* ===== ORDER TYPE TABS ===== */}
      <div className="flex gap-1 overflow-x-auto pb-0.5 no-scrollbar">
        {ORDER_TYPES.map(type => (
          <button key={type.id} onClick={() => setOrderType(type.id)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-medium whitespace-nowrap transition-all ${
              orderType === type.id
                ? 'bg-[#1e1e3a] text-white border border-[#3a3a7a]'
                : 'text-gray-500 hover:text-gray-300 hover:bg-[#1e1e3a]/50'
            }`}>
            {type.label}
          </button>
        ))}
      </div>

      {/* ===== PRICE SECTION ===== */}
      {orderType !== 'market' && (
        <div className="space-y-2">
          <label className="text-[9px] text-gray-500 uppercase tracking-wider font-medium">
            {orderType === 'stop' ? 'Stop Price' : orderType === 'stop_limit' ? 'Limit Price' : orderType === 'trailing' ? 'Activation Price' : 'Price'}
          </label>
          <div className="flex items-center gap-1">
            <button onClick={() => setLimitPrice(p => (parseFloat(p) - (currentPrice > 100 ? 1 : 0.01)).toFixed(2))}
              className="w-8 h-8 rounded-lg bg-[#1e1e3a] text-gray-300 hover:text-white hover:bg-[#2a2a5a] flex items-center justify-center text-lg transition-all">−</button>
            <input type="number" aria-label="Paper order price" data-paper-order-price value={limitPrice} onChange={e => setLimitPrice(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg bg-[#12122a] border border-[#2a2a5a] text-white text-sm text-center focus:border-[#26a69a] focus:outline-none transition-colors" step="any" />
            <button onClick={() => setLimitPrice(p => (parseFloat(p) + (currentPrice > 100 ? 1 : 0.01)).toFixed(2))}
              className="w-8 h-8 rounded-lg bg-[#1e1e3a] text-gray-300 hover:text-white hover:bg-[#2a2a5a] flex items-center justify-center text-lg transition-all">+</button>
          </div>
          {/* Bid/Ask quick set */}
          <div className="flex gap-1">
            <button onClick={() => setLimitPrice(computed.bidPrice)} className="flex-1 py-1 text-[9px] rounded bg-[#12122a] text-gray-400 hover:text-[#26a69a] border border-[#1e1e3a] transition-all">Bid</button>
            <button onClick={() => setLimitPrice(currentPrice.toFixed(2))} className="flex-1 py-1 text-[9px] rounded bg-[#12122a] text-gray-400 hover:text-white border border-[#1e1e3a] transition-all">Last</button>
            <button onClick={() => setLimitPrice(computed.askPrice)} className="flex-1 py-1 text-[9px] rounded bg-[#12122a] text-gray-400 hover:text-[#ef5350] border border-[#1e1e3a] transition-all">Ask</button>
          </div>

          {/* Stop price for stop_limit */}
          {(orderType === 'stop' || orderType === 'stop_limit') && (
            <div>
              <label className="text-[9px] text-gray-500 uppercase tracking-wider font-medium">Stop Trigger Price</label>
              <input type="number" value={stopPrice} onChange={e => setStopPrice(e.target.value)}
                className="w-full mt-1 px-3 py-2 rounded-lg bg-[#12122a] border border-[#2a2a5a] text-white text-sm text-center focus:border-[#26a69a] focus:outline-none" step="any" />
            </div>
          )}

          {/* Trailing delta */}
          {orderType === 'trailing' && (
            <div>
              <label className="text-[9px] text-gray-500 uppercase tracking-wider font-medium">Trailing Delta %</label>
              <input type="number" value={trailingDelta} onChange={e => setTrailingDelta(e.target.value)}
                className="w-full mt-1 px-3 py-2 rounded-lg bg-[#12122a] border border-[#2a2a5a] text-white text-sm text-center focus:border-[#26a69a] focus:outline-none" step="0.1" min="0.1" />
            </div>
          )}
        </div>
      )}

      {/* ===== QUANTITY SECTION ===== */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[9px] text-gray-500 uppercase tracking-wider font-medium">Quantity</label>
          <div className="flex gap-1">
            {['units', 'usdt'].map(m => (
              <button key={m} onClick={() => setQtyMode(m)}
                className={`px-2 py-0.5 rounded text-[8px] font-medium transition-all ${
                  qtyMode === m ? 'bg-[#1e1e3a] text-white' : 'text-gray-500 hover:text-gray-300'
                }`}>{m.toUpperCase()}</button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setQty(q => Math.max(0, parseFloat(q) - (currentPrice > 100 ? 0.001 : 1)).toString())}
            className="w-8 h-8 rounded-lg bg-[#1e1e3a] text-gray-300 hover:text-white hover:bg-[#2a2a5a] flex items-center justify-center text-lg transition-all">−</button>
          <input type="number" value={qty} onChange={e => setQty(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg bg-[#12122a] border border-[#2a2a5a] text-white text-sm text-center focus:border-[#26a69a] focus:outline-none" step="any" min="0" />
          <button onClick={() => setQty(q => (parseFloat(q) + (currentPrice > 100 ? 0.001 : 1)).toString())}
            className="w-8 h-8 rounded-lg bg-[#1e1e3a] text-gray-300 hover:text-white hover:bg-[#2a2a5a] flex items-center justify-center text-lg transition-all">+</button>
        </div>
        <div className="flex items-center justify-between text-[9px] text-gray-500">
          <span>≈ ${computed.tradeValue.toFixed(2)} USDT</span>
          <span>Max: {computed.maxQty.toFixed(4)}</span>
        </div>
        {/* Percentage slider */}
        <div className="flex gap-1">
          {QTY_PRESETS.map(pct => (
            <button key={pct} onClick={() => setQtyByPct(pct)}
              className="flex-1 py-1.5 rounded-lg text-[10px] font-medium text-gray-400 hover:text-white bg-[#12122a] border border-[#1e1e3a] hover:border-[#2a2a5a] transition-all">
              {pct}%
            </button>
          ))}
        </div>
      </div>

      {/* ===== LEVERAGE SECTION ===== */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[9px] text-gray-500 uppercase tracking-wider font-medium">Leverage</label>
          <div className="flex items-center gap-2">
            {/* Margin mode toggle */}
            <div className="flex rounded-md overflow-hidden border border-[#2a2a5a]">
              <button onClick={() => setMarginMode('cross')}
                className={`px-2 py-0.5 text-[8px] font-medium transition-all ${marginMode === 'cross' ? 'bg-[#26a69a]/20 text-[#26a69a]' : 'text-gray-500'}`}>Cross</button>
              <button onClick={() => setMarginMode('isolated')}
                className={`px-2 py-0.5 text-[8px] font-medium transition-all ${marginMode === 'isolated' ? 'bg-[#26a69a]/20 text-[#26a69a]' : 'text-gray-500'}`}>Isolated</button>
            </div>
            <span className="text-white text-xs font-bold">{leverage}x</span>
          </div>
        </div>
        <input type="range" min="1" max="125" value={leverage} onChange={e => setLeverage(parseInt(e.target.value))}
          className="w-full h-1.5 bg-[#1e1e3a] rounded-full appearance-none cursor-pointer accent-[#26a69a]" />
        <div className="flex gap-1 flex-wrap">
          {LEVERAGE_PRESETS.map(lev => (
            <button key={lev} onClick={() => setLeverage(lev)}
              className={`px-2 py-1 rounded text-[8px] font-medium transition-all ${
                leverage === lev ? 'bg-[#26a69a]/20 text-[#26a69a] border border-[#26a69a]/30'
                  : 'text-gray-500 hover:text-gray-300 bg-[#12122a] border border-[#1e1e3a]'
              }`}>{lev}x</button>
          ))}
        </div>
        {/* Leverage info */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[9px] p-2 rounded-lg bg-[#0a0a1a]">
          <div className="flex justify-between"><span className="text-gray-500">Liq. Price</span><span className="text-[#9c27b0]">${formatPrice(computed.liqPrice)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Req. Margin</span><span className="text-white">${computed.margin.toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Position Value</span><span className="text-white">${computed.tradeValue.toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Max Position</span><span className="text-white">${computed.maxPosition.toFixed(0)}</span></div>
        </div>
      </div>

      {/* ===== TAKE PROFIT ===== */}
      <div className="space-y-2 p-2.5 rounded-xl border border-[#1e1e3a] bg-[#0a0a1a]/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => setTpEnabled(!tpEnabled)}
              className={`w-9 h-5 rounded-full relative transition-all ${tpEnabled ? 'bg-[#4caf50]' : 'bg-[#1e1e3a]'}`}>
              <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all ${tpEnabled ? 'right-[3px]' : 'left-[3px]'}`} />
            </button>
            <span className="text-[10px] text-gray-300 font-medium">Take Profit</span>
          </div>
          {tpEnabled && tpLevels.length < 5 && (
            <button onClick={addTpLevel} className="text-[9px] text-[#4caf50] hover:underline">+ Add Level</button>
          )}
        </div>
        {tpEnabled && tpLevels.map((tp, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <input type="number" value={tp.price} placeholder="Price"
              onChange={e => { const u = [...tpLevels]; u[idx] = { ...u[idx], price: e.target.value }; setTpLevels(u) }}
              className="flex-1 px-2 py-1.5 rounded-lg bg-[#12122a] border border-[#4caf50]/20 text-[#4caf50] text-[11px] focus:outline-none focus:border-[#4caf50]/50" step="any" />
            <input type="number" value={tp.pct} placeholder="%"
              onChange={e => updateTpByPct(idx, e.target.value)}
              className="w-16 px-2 py-1.5 rounded-lg bg-[#12122a] border border-[#4caf50]/20 text-[#4caf50] text-[11px] focus:outline-none" step="0.1" />
            {tpLevels.length > 1 && (
              <button onClick={() => removeTpLevel(idx)} className="text-gray-500 hover:text-red-400 text-xs">✕</button>
            )}
          </div>
        ))}
        {tpEnabled && computed.reward > 0 && (
          <div className="flex justify-between text-[9px]">
            <span className="text-gray-500">Expected Profit</span>
            <span className="text-[#4caf50]">+${computed.reward.toFixed(2)} ({computed.rewardPct.toFixed(1)}%)</span>
          </div>
        )}
      </div>

      {/* ===== STOP LOSS ===== */}
      <div className="space-y-2 p-2.5 rounded-xl border border-[#1e1e3a] bg-[#0a0a1a]/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => setSlEnabled(!slEnabled)}
              className={`w-9 h-5 rounded-full relative transition-all ${slEnabled ? 'bg-[#ff4976]' : 'bg-[#1e1e3a]'}`}>
              <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all ${slEnabled ? 'right-[3px]' : 'left-[3px]'}`} />
            </button>
            <span className="text-[10px] text-gray-300 font-medium">Stop Loss</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setTrailingSL(!trailingSL)}
              className={`text-[8px] px-1.5 py-0.5 rounded transition-all ${trailingSL ? 'bg-[#ff4976]/20 text-[#ff4976]' : 'text-gray-500 hover:text-gray-300'}`}>
              Trailing
            </button>
          </div>
        </div>
        {slEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <input type="number" value={slPrice} placeholder="SL Price"
                onChange={e => setSlPrice(e.target.value)}
                className="flex-1 px-2 py-1.5 rounded-lg bg-[#12122a] border border-[#ff4976]/20 text-[#ff4976] text-[11px] focus:outline-none focus:border-[#ff4976]/50" step="any" />
              <input type="number" value={slPct} placeholder="%"
                onChange={e => updateSlByPct(e.target.value)}
                className="w-16 px-2 py-1.5 rounded-lg bg-[#12122a] border border-[#ff4976]/20 text-[#ff4976] text-[11px] focus:outline-none" step="0.1" />
            </div>
            {computed.risk > 0 && (
              <div className="flex justify-between text-[9px]">
                <span className="text-gray-500">Max Loss</span>
                <span className="text-[#ff4976]">-${computed.risk.toFixed(2)} ({computed.riskPct.toFixed(1)}%)</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Risk:Reward */}
      {slEnabled && tpEnabled && computed.rrRatio > 0 && (
        <div className="flex items-center justify-center py-1">
          <span className="text-[10px] text-gray-400">Risk/Reward: <span className="text-white font-bold">1:{computed.rrRatio.toFixed(2)}</span></span>
        </div>
      )}

      {/* ===== ORDER INFO ===== */}
      <div className="space-y-1 p-2.5 rounded-xl bg-[#0a0a1a] border border-[#1e1e3a]/50">
        <div className="text-[8px] text-gray-500 uppercase tracking-wider font-medium mb-1">Order Summary</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[9px]">
          <div className="flex justify-between"><span className="text-gray-500">Required Margin</span><span className="text-white">${computed.margin.toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Wallet Balance</span><span className="text-white">${account.balance.toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Available</span><span className="text-white">${account.availableMargin.toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Leverage</span><span className="text-white">{leverage}x {marginMode}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Trade Value</span><span className="text-white">${computed.tradeValue.toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Est. Liq. Price</span><span className="text-[#9c27b0]">${formatPrice(computed.liqPrice)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Maker Fee</span><span className="text-gray-300">${computed.makerFee.toFixed(4)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Taker Fee</span><span className="text-gray-300">${computed.takerFee.toFixed(4)}</span></div>
          {computed.reward > 0 && <div className="flex justify-between"><span className="text-gray-500">Est. Profit</span><span className="text-[#4caf50]">+${computed.reward.toFixed(2)}</span></div>}
          {computed.risk > 0 && <div className="flex justify-between"><span className="text-gray-500">Est. Loss</span><span className="text-[#ff4976]">-${computed.risk.toFixed(2)}</span></div>}
          {computed.rrRatio > 0 && <div className="flex justify-between"><span className="text-gray-500">R:R Ratio</span><span className="text-white">1:{computed.rrRatio.toFixed(2)}</span></div>}
        </div>
      </div>

      {/* ===== VALIDATION MESSAGES ===== */}
      {!validation.valid && (
        <div className="p-2 rounded-lg bg-[#ef5350]/10 border border-[#ef5350]/20">
          {validation.errors.map((err, i) => (
            <div key={i} className="text-[9px] text-[#ef5350]">⚠ {err}</div>
          ))}
        </div>
      )}

      {/* ===== ACTION BUTTONS ===== */}
      <div className="space-y-2 pb-2">
        <button data-paper-order-submit onClick={handlePlaceOrder} disabled={!validation.valid || !currentPrice}
          className={`w-full py-3.5 rounded-xl font-bold text-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed active:scale-[0.98] ${
            isBuy
              ? 'bg-gradient-to-r from-[#26a69a] to-[#2bbd9a] text-white shadow-lg shadow-[#26a69a]/25'
              : 'bg-gradient-to-r from-[#ef5350] to-[#f44336] text-white shadow-lg shadow-[#ef5350]/25'
          }`}>
          {isBuy ? '🟢' : '🔴'} {orderType !== 'market' ? orderType.replace('_', ' ').toUpperCase() + ' ' : ''}
          {isBuy ? 'BUY / LONG' : 'SELL / SHORT'}
        </button>
        <div className="flex gap-2">
          <button onClick={handleReset}
            className="flex-1 py-2 rounded-xl text-[10px] font-medium text-gray-400 border border-[#1e1e3a] hover:bg-[#1e1e3a] hover:text-white transition-all">
            Reset
          </button>
          <button onClick={onClose}
            className="flex-1 py-2 rounded-xl text-[10px] font-medium text-gray-400 border border-[#1e1e3a] hover:bg-[#1e1e3a] hover:text-white transition-all">
            Discard
          </button>
        </div>
      </div>
    </div>
  )
}

export default ProOrderPanel
