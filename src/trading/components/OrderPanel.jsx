/**
 * OrderPanel - Professional order entry panel
 * Supports: Market, Limit, Stop orders
 * Features: Leverage slider, SL/TP inputs, margin display, quick qty buttons
 * Actions: Place order, modify, cancel, close, reverse, partial close
 */
import React, { useState, useMemo, useEffect } from 'react'
import useTradingStore from '../stores/tradingStore'
import useChartStore from '../stores/chartStore'
import useSettingsStore from '../stores/settingsStore'
import { OrderType, OrderSide, formatPrice, calculateRisk, calculateRiskPercent, calculateReward, calculateRewardPercent } from '../types'
import toast from 'react-hot-toast'

const LEVERAGE_PRESETS = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100]
const QTY_PRESETS_PCT = [10, 25, 50, 75, 100] // % of available margin

function OrderPanel() {
  const currentPrice = useTradingStore(s => s.currentPrice)
  const account = useTradingStore(s => s.account)
  const placeOrder = useTradingStore(s => s.placeOrder)
  const { symbolDisplay, symbol } = useChartStore()
  const { defaultLeverage, defaultQty } = useSettingsStore()

  const [orderType, setOrderType] = useState('market')
  const [side, setSide] = useState('buy')
  const [qty, setQty] = useState(defaultQty.toString())
  const [leverage, setLeverage] = useState(defaultLeverage)
  const [limitPrice, setLimitPrice] = useState('')
  const [slEnabled, setSlEnabled] = useState(true)
  const [tpEnabled, setTpEnabled] = useState(false)
  const [slPrice, setSlPrice] = useState('')
  const [tpPrice, setTpPrice] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)

  // Auto-set SL/TP when price changes
  useEffect(() => {
    if (currentPrice > 0 && !slPrice) {
      const sl = side === 'buy'
        ? (currentPrice * (1 - 0.01)).toFixed(2)
        : (currentPrice * (1 + 0.01)).toFixed(2)
      setSlPrice(sl)
    }
    if (currentPrice > 0 && !tpPrice) {
      const tp = side === 'buy'
        ? (currentPrice * (1 + 0.02)).toFixed(2)
        : (currentPrice * (1 - 0.02)).toFixed(2)
      setTpPrice(tp)
    }
  }, [currentPrice, side])

  // Update limit price when switching to limit order
  useEffect(() => {
    if (orderType !== 'market' && currentPrice > 0 && !limitPrice) {
      setLimitPrice(currentPrice.toFixed(2))
    }
  }, [orderType, currentPrice])

  // Computed values
  const computedValues = useMemo(() => {
    const qtyNum = parseFloat(qty) || 0
    const price = orderType === 'market' ? currentPrice : (parseFloat(limitPrice) || currentPrice)
    const tradeValue = price * qtyNum
    const margin = tradeValue / leverage
    const feeRate = 0.0004
    const fee = tradeValue * feeRate
    const risk = slEnabled && slPrice ? calculateRisk(side, price, parseFloat(slPrice), qtyNum, leverage) : 0
    const riskPct = calculateRiskPercent(risk, margin)
    const reward = tpEnabled && tpPrice ? calculateReward(side, price, parseFloat(tpPrice), qtyNum, leverage) : 0
    const rewardPct = calculateRewardPercent(reward, margin)
    const rrRatio = risk > 0 ? reward / risk : 0

    return { tradeValue, margin, fee, risk, riskPct, reward, rewardPct, rrRatio, price }
  }, [qty, leverage, currentPrice, limitPrice, orderType, side, slEnabled, slPrice, tpEnabled, tpPrice])

  // Quick qty by margin %
  const setQtyByMarginPct = (pct) => {
    if (!currentPrice) return
    const availableForTrade = account.availableMargin * (pct / 100)
    const maxQty = (availableForTrade * leverage) / currentPrice
    setQty(maxQty.toFixed(4))
  }

  // Place order handler
  const handlePlaceOrder = () => {
    const result = placeOrder({
      symbol: symbol.replace('USDT', '/USDT'),
      side,
      type: orderType,
      qty: parseFloat(qty),
      price: computedValues.price,
      leverage,
      stopLoss: slEnabled ? parseFloat(slPrice) : null,
      takeProfit: tpEnabled ? parseFloat(tpPrice) : null,
      limitPrice: orderType !== 'market' ? parseFloat(limitPrice) : null,
    })

    if (result.success) {
      toast.success(
        `${side.toUpperCase()} ${qty} ${symbol} @ $${formatPrice(computedValues.price)} (${leverage}x)`,
        { duration: 3000 }
      )
      // Reset qty
      setQty(defaultQty.toString())
    } else {
      toast.error(result.error || 'Order failed')
    }
  }

  const isBuy = side === 'buy'

  return (
    <div className="bg-[#0d0d22] border-t border-[#1e1e3a] p-3 space-y-2.5">
      {/* Symbol + Balance Row */}
      <div className="flex items-center justify-between">
        <span className="text-white text-xs font-semibold">{symbolDisplay}</span>
        <span className="text-gray-400 text-[10px]">
          Avail: <span className="text-white">${account.availableMargin.toFixed(2)}</span>
        </span>
      </div>

      {/* Buy/Sell Toggle */}
      <div className="flex rounded-lg overflow-hidden border border-[#1e1e3a]">
        <button
          onClick={() => setSide('buy')}
          className={`flex-1 py-2 text-xs font-bold transition-all ${
            isBuy ? 'bg-[#26a69a] text-white' : 'bg-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          BUY / LONG
        </button>
        <button
          onClick={() => setSide('sell')}
          className={`flex-1 py-2 text-xs font-bold transition-all ${
            !isBuy ? 'bg-[#ef5350] text-white' : 'bg-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          SELL / SHORT
        </button>
      </div>

      {/* Order Type Tabs */}
      <div className="flex gap-1">
        {['market', 'limit', 'stop'].map(type => (
          <button
            key={type}
            onClick={() => setOrderType(type)}
            className={`flex-1 py-1.5 rounded text-[10px] font-medium transition-all capitalize ${
              orderType === type
                ? 'bg-[#1e1e3a] text-white border border-[#2a2a5a]'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {/* Limit/Stop Price Input */}
      {orderType !== 'market' && (
        <div>
          <label className="text-[9px] text-gray-500 uppercase tracking-wider">
            {orderType === 'limit' ? 'Limit' : 'Stop'} Price
          </label>
          <input
            type="number"
            value={limitPrice}
            onChange={e => setLimitPrice(e.target.value)}
            className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-[#12122a] border border-[#2a2a5a] text-white text-xs focus:border-[#26a69a] focus:outline-none"
            step="any"
          />
        </div>
      )}

      {/* Quantity */}
      <div>
        <div className="flex items-center justify-between">
          <label className="text-[9px] text-gray-500 uppercase tracking-wider">Quantity</label>
          <span className="text-[9px] text-gray-500">${computedValues.tradeValue.toFixed(2)}</span>
        </div>
        <input
          type="number"
          value={qty}
          onChange={e => setQty(e.target.value)}
          className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-[#12122a] border border-[#2a2a5a] text-white text-xs focus:border-[#26a69a] focus:outline-none"
          step="any"
          min="0"
        />
        {/* Quick qty presets */}
        <div className="flex gap-1 mt-1">
          {QTY_PRESETS_PCT.map(pct => (
            <button
              key={pct}
              onClick={() => setQtyByMarginPct(pct)}
              className="flex-1 py-0.5 rounded text-[9px] text-gray-400 hover:text-white bg-[#12122a] border border-[#1e1e3a] hover:border-[#2a2a5a] transition-all"
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>

      {/* Leverage */}
      <div>
        <div className="flex items-center justify-between">
          <label className="text-[9px] text-gray-500 uppercase tracking-wider">Leverage</label>
          <span className="text-xs text-white font-bold">{leverage}x</span>
        </div>
        <input
          type="range"
          min="1"
          max="100"
          value={leverage}
          onChange={e => setLeverage(parseInt(e.target.value))}
          className="w-full h-1 mt-1 bg-[#1e1e3a] rounded-full appearance-none cursor-pointer accent-[#26a69a]"
        />
        <div className="flex gap-1 mt-1">
          {LEVERAGE_PRESETS.map(lev => (
            <button
              key={lev}
              onClick={() => setLeverage(lev)}
              className={`flex-1 py-0.5 rounded text-[8px] transition-all ${
                leverage === lev
                  ? 'bg-[#26a69a]/20 text-[#26a69a] border border-[#26a69a]/30'
                  : 'text-gray-500 hover:text-gray-300 bg-[#12122a] border border-[#1e1e3a]'
              }`}
            >
              {lev}x
            </button>
          ))}
        </div>
      </div>

      {/* Stop Loss / Take Profit */}
      <div className="space-y-1.5 pt-1 border-t border-[#1e1e3a]/50">
        {/* Stop Loss */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSlEnabled(!slEnabled)}
            className={`w-8 h-4 rounded-full relative transition-all ${slEnabled ? 'bg-[#ff4976]' : 'bg-[#1e1e3a]'}`}
          >
            <div className={`w-3 h-3 bg-white rounded-full absolute top-0.5 transition-all ${slEnabled ? 'right-0.5' : 'left-0.5'}`} />
          </button>
          <span className="text-[9px] text-gray-400 w-6">SL</span>
          {slEnabled && (
            <input
              type="number"
              value={slPrice}
              onChange={e => setSlPrice(e.target.value)}
              className="flex-1 px-2 py-1 rounded bg-[#12122a] border border-[#ff4976]/30 text-[#ff4976] text-[10px] focus:outline-none"
              step="any"
            />
          )}
          {slEnabled && computedValues.risk > 0 && (
            <span className="text-[9px] text-[#ff4976]">-${computedValues.risk.toFixed(0)} ({computedValues.riskPct.toFixed(1)}%)</span>
          )}
        </div>

        {/* Take Profit */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTpEnabled(!tpEnabled)}
            className={`w-8 h-4 rounded-full relative transition-all ${tpEnabled ? 'bg-[#4caf50]' : 'bg-[#1e1e3a]'}`}
          >
            <div className={`w-3 h-3 bg-white rounded-full absolute top-0.5 transition-all ${tpEnabled ? 'right-0.5' : 'left-0.5'}`} />
          </button>
          <span className="text-[9px] text-gray-400 w-6">TP</span>
          {tpEnabled && (
            <input
              type="number"
              value={tpPrice}
              onChange={e => setTpPrice(e.target.value)}
              className="flex-1 px-2 py-1 rounded bg-[#12122a] border border-[#4caf50]/30 text-[#4caf50] text-[10px] focus:outline-none"
              step="any"
            />
          )}
          {tpEnabled && computedValues.reward > 0 && (
            <span className="text-[9px] text-[#4caf50]">+${computedValues.reward.toFixed(0)} ({computedValues.rewardPct.toFixed(1)}%)</span>
          )}
        </div>

        {/* Risk:Reward ratio */}
        {slEnabled && tpEnabled && computedValues.rrRatio > 0 && (
          <div className="text-center text-[9px] text-gray-400">
            R:R = <span className="text-white font-medium">1:{computedValues.rrRatio.toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* Order Summary */}
      <div className="p-2 rounded-lg bg-[#12122a]/50 border border-[#1e1e3a]/50 space-y-0.5">
        <div className="flex justify-between text-[9px]">
          <span className="text-gray-500">Margin Required</span>
          <span className="text-white">${computedValues.margin.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-[9px]">
          <span className="text-gray-500">Est. Fee</span>
          <span className="text-gray-300">-${computedValues.fee.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-[9px]">
          <span className="text-gray-500">Trade Value</span>
          <span className="text-gray-300">${computedValues.tradeValue.toFixed(2)}</span>
        </div>
      </div>

      {/* Place Order Button */}
      <button
        onClick={handlePlaceOrder}
        disabled={!currentPrice || parseFloat(qty) <= 0}
        className={`w-full py-2.5 rounded-lg font-bold text-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
          isBuy
            ? 'bg-[#26a69a] hover:bg-[#2bbd9a] text-white shadow-lg shadow-[#26a69a]/20'
            : 'bg-[#ef5350] hover:bg-[#f44336] text-white shadow-lg shadow-[#ef5350]/20'
        }`}
      >
        {orderType === 'market' ? '' : `${orderType.toUpperCase()} `}
        {isBuy ? 'BUY / LONG' : 'SELL / SHORT'}
      </button>

      {/* Quick Actions for open positions */}
      <QuickActions />
    </div>
  )
}

/**
 * QuickActions - Modify, reverse, partial close for open positions
 */
function QuickActions() {
  const positions = useTradingStore(s => s.positions)
  const closePosition = useTradingStore(s => s.closePosition)
  const reversePosition = useTradingStore(s => s.reversePosition)
  const partialClose = useTradingStore(s => s.partialClose)
  const [partialQty, setPartialQty] = useState('')
  const [showPartial, setShowPartial] = useState(null) // position id

  if (positions.length === 0) return null

  return (
    <div className="pt-2 border-t border-[#1e1e3a]/50 space-y-1.5">
      <span className="text-[9px] text-gray-500 uppercase tracking-wider">Quick Actions</span>
      {positions.map(pos => (
        <div key={pos.id} className="flex items-center gap-1 flex-wrap">
          <span className={`text-[9px] font-bold ${pos.side === 'buy' ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
            {pos.side === 'buy' ? '▲' : '▼'} {pos.qty}
          </span>
          <button
            onClick={() => closePosition(pos.id)}
            className="px-1.5 py-0.5 text-[8px] rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20"
          >
            Close
          </button>
          <button
            onClick={() => reversePosition(pos.id)}
            className="px-1.5 py-0.5 text-[8px] rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20"
          >
            Reverse
          </button>
          <button
            onClick={() => setShowPartial(showPartial === pos.id ? null : pos.id)}
            className="px-1.5 py-0.5 text-[8px] rounded bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 border border-yellow-500/20"
          >
            Partial
          </button>
          {showPartial === pos.id && (
            <div className="flex items-center gap-1 w-full mt-0.5">
              <input
                type="number"
                value={partialQty}
                onChange={e => setPartialQty(e.target.value)}
                placeholder={`Max: ${pos.qty}`}
                className="flex-1 px-2 py-0.5 rounded bg-[#12122a] border border-[#2a2a5a] text-white text-[9px] focus:outline-none"
                step="any"
                max={pos.qty}
              />
              <button
                onClick={() => {
                  const q = parseFloat(partialQty)
                  if (q > 0 && q <= pos.qty) {
                    partialClose(pos.id, q)
                    setPartialQty('')
                    setShowPartial(null)
                    toast.success(`Partial close: ${q} units`)
                  }
                }}
                className="px-2 py-0.5 text-[8px] rounded bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30"
              >
                ✓
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export default OrderPanel
