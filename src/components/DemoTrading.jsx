import React, { useState, useEffect } from 'react'
import toast from 'react-hot-toast'

function DemoTrading({ symbol = 'BTC/USDT', currentPrice = 0, showPopup = false, popupSide = 'buy', onClosePopup = () => {} }) {
  const [balance, setBalance] = useState(() => parseFloat(localStorage.getItem('vmt_demo_balance')) || 100000)
  const [positions, setPositions] = useState(() => {
    const saved = localStorage.getItem('vmt_demo_positions')
    return saved ? JSON.parse(saved) : []
  })
  const [pendingOrders, setPendingOrders] = useState(() => {
    const saved = localStorage.getItem('vmt_demo_pending_orders')
    return saved ? JSON.parse(saved) : []
  })
  const [history, setHistory] = useState(() => {
    const saved = localStorage.getItem('vmt_demo_history')
    return saved ? JSON.parse(saved) : []
  })

  // Order popup state
  const [showOrderPopup, setShowOrderPopup] = useState(false)
  const [orderSide, setOrderSide] = useState('buy')

  // Sync with parent props
  useEffect(() => {
    if (showPopup) {
      setOrderSide(popupSide)
      setShowOrderPopup(true)
    }
  }, [showPopup, popupSide])
  const [orderType, setOrderType] = useState('market')
  const [units, setUnits] = useState('1')
  const [leverage, setLeverage] = useState('10')
  const [tpEnabled, setTpEnabled] = useState(false)
  const [slEnabled, setSlEnabled] = useState(true)
  const [tpPrice, setTpPrice] = useState('')
  const [slPrice, setSlPrice] = useState('')
  const [limitPrice, setLimitPrice] = useState('')

  useEffect(() => { localStorage.setItem('vmt_demo_balance', balance.toString()) }, [balance])
  useEffect(() => { localStorage.setItem('vmt_demo_positions', JSON.stringify(positions)) }, [positions])
  useEffect(() => { localStorage.setItem('vmt_demo_pending_orders', JSON.stringify(pendingOrders)) }, [pendingOrders])
  useEffect(() => { localStorage.setItem('vmt_demo_history', JSON.stringify(history)) }, [history])

  // Auto-set TP/SL when popup opens
  useEffect(() => {
    if (showOrderPopup && currentPrice > 0) {
      if (orderSide === 'buy') {
        setTpPrice((currentPrice * 1.012).toFixed(2))
        setSlPrice((currentPrice * 0.993).toFixed(2))
      } else {
        setTpPrice((currentPrice * 0.988).toFixed(2))
        setSlPrice((currentPrice * 1.007).toFixed(2))
      }
      setLimitPrice(currentPrice.toFixed(2))
    }
  }, [showOrderPopup, orderSide, currentPrice])

  const getPositionPnL = (pos) => {
    if (!currentPrice) return 0
    if (pos.side === 'buy') return (currentPrice - pos.entryPrice) * pos.qty * pos.leverage
    else return (pos.entryPrice - currentPrice) * pos.qty * pos.leverage
  }

  const totalUnrealizedPnL = positions.reduce((sum, pos) => sum + getPositionPnL(pos), 0)

  // Open order popup
  const openBuy = () => { setOrderSide('buy'); setShowOrderPopup(true) }
  const openSell = () => { setOrderSide('sell'); setShowOrderPopup(true) }
  const closePopup = () => { setShowOrderPopup(false); onClosePopup() }

  // Place order
  const placeOrder = () => {
    if (!currentPrice || currentPrice === 0) { toast.error('Price not available'); return }
    const qty = parseFloat(units)
    const lev = parseFloat(leverage) || 1
    if (!qty || qty <= 0) { toast.error('Enter valid units'); return }

    const price = orderType === 'market' ? currentPrice : parseFloat(limitPrice)
    if (orderType !== 'market' && (!price || price <= 0)) { toast.error('Enter valid price'); return }

    const margin = (price * qty) / lev
    if (margin > balance) { toast.error('Insufficient margin'); return }

    // For limit/stop orders - add to pending orders (shown on chart)
    if (orderType !== 'market') {
      const pendingOrder = {
        id: 'order_' + Date.now(),
        symbol, side: orderSide, qty, leverage: lev,
        price: price, orderType,
        tp: tpEnabled ? parseFloat(tpPrice) : null,
        sl: slEnabled ? parseFloat(slPrice) : null,
        margin: parseFloat(margin.toFixed(2)),
        createdAt: new Date().toISOString(),
      }
      setPendingOrders(prev => [...prev, pendingOrder])
      setShowOrderPopup(false)
      onClosePopup()
      toast.success(`${orderType.toUpperCase()} order: ${orderSide.toUpperCase()} ${qty} ${symbol} @ $${price.toFixed(2)} (${lev}x)`)
      return
    }

    // Market order - execute immediately
    const position = {
      id: 'pos_' + Date.now(),
      symbol, side: orderSide, qty, leverage: lev,
      entryPrice: price, orderType,
      tp: tpEnabled ? parseFloat(tpPrice) : null,
      sl: slEnabled ? parseFloat(slPrice) : null,
      margin: parseFloat(margin.toFixed(2)),
      openedAt: new Date().toISOString(),
    }

    setPositions(prev => [...prev, position])
    setBalance(prev => prev - margin * 0.001) // 0.1% fee
    setShowOrderPopup(false)
    onClosePopup()
    toast.success(`${orderSide.toUpperCase()} ${qty} ${symbol} @ $${price.toFixed(2)} (${lev}x)`)
  }

  // Cancel pending order
  const cancelPendingOrder = (orderId) => {
    setPendingOrders(prev => prev.filter(o => o.id !== orderId))
    toast.success('Order cancelled')
  }

  // Check if pending orders should be triggered (price reached)
  useEffect(() => {
    if (!currentPrice || pendingOrders.length === 0) return
    const toTrigger = []
    const remaining = []

    pendingOrders.forEach(order => {
      let triggered = false
      if (order.orderType === 'limit') {
        // Buy limit triggers when price drops to or below order price
        if (order.side === 'buy' && currentPrice <= order.price) triggered = true
        // Sell limit triggers when price rises to or above order price
        if (order.side === 'sell' && currentPrice >= order.price) triggered = true
      } else if (order.orderType === 'stop') {
        // Buy stop triggers when price rises to or above order price
        if (order.side === 'buy' && currentPrice >= order.price) triggered = true
        // Sell stop triggers when price drops to or below order price
        if (order.side === 'sell' && currentPrice <= order.price) triggered = true
      }
      if (triggered) toTrigger.push(order)
      else remaining.push(order)
    })

    if (toTrigger.length > 0) {
      toTrigger.forEach(order => {
        const position = {
          id: 'pos_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
          symbol: order.symbol, side: order.side, qty: order.qty, leverage: order.leverage,
          entryPrice: order.price, orderType: order.orderType,
          tp: order.tp, sl: order.sl,
          margin: order.margin,
          openedAt: new Date().toISOString(),
        }
        setPositions(prev => [...prev, position])
        setBalance(prev => prev - order.margin * 0.001)
        toast.success(`${order.orderType.toUpperCase()} order triggered: ${order.side.toUpperCase()} ${order.qty} ${order.symbol} @ $${order.price.toFixed(2)}`)
      })
      setPendingOrders(remaining)
    }
  }, [currentPrice])

  // Close position
  const closePosition = (posId) => {
    const pos = positions.find(p => p.id === posId)
    if (!pos) return
    const pnl = getPositionPnL(pos)
    setHistory(prev => [{ ...pos, exitPrice: currentPrice, pnl: parseFloat(pnl.toFixed(2)), closedAt: new Date().toISOString() }, ...prev])
    setPositions(prev => prev.filter(p => p.id !== posId))
    setBalance(prev => prev + pos.margin + pnl)
    toast.success(`Closed: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`)
  }

  const closeAll = () => {
    positions.forEach(pos => {
      const pnl = getPositionPnL(pos)
      setHistory(prev => [{ ...pos, exitPrice: currentPrice, pnl: parseFloat(pnl.toFixed(2)), closedAt: new Date().toISOString() }, ...prev])
      setBalance(prev => prev + pos.margin + pnl)
    })
    setPositions([])
    toast.success('All positions closed')
  }

  // Calculations for order info
  const tradeValue = currentPrice * (parseFloat(units) || 0)
  const marginRequired = tradeValue / (parseFloat(leverage) || 1)
  const risk = slEnabled && slPrice ? Math.abs(currentPrice - parseFloat(slPrice)) * (parseFloat(units) || 0) * (parseFloat(leverage) || 1) : 0
  const riskPercent = balance > 0 ? ((risk / balance) * 100).toFixed(2) : '0'
  const tpTicks = tpEnabled && tpPrice ? Math.abs(parseFloat(tpPrice) - currentPrice).toFixed(0) : 0
  const slTicks = slEnabled && slPrice ? Math.abs(currentPrice - parseFloat(slPrice)).toFixed(0) : 0

  return (
    <div className="space-y-3">
      {/* Buy/Sell Price Buttons - Always Visible (like TradingView) */}
      <div className="flex items-center gap-1">
        <button onClick={openSell}
          className="flex flex-col items-center px-3 py-1.5 bg-red-500/20 border border-red-500/40 rounded-lg hover:bg-red-500/30 transition-all cursor-pointer">
          <span className="text-red-400 font-bold text-sm">{currentPrice ? currentPrice.toLocaleString() : '...'}</span>
          <span className="text-red-400 text-[9px] font-medium">SELL</span>
        </button>
        <span className="text-gray-500 text-[10px]">0</span>
        <button onClick={openBuy}
          className="flex flex-col items-center px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/40 rounded-lg hover:bg-emerald-500/30 transition-all cursor-pointer">
          <span className="text-emerald-400 font-bold text-sm">{currentPrice ? currentPrice.toLocaleString() : '...'}</span>
          <span className="text-emerald-400 text-[9px] font-medium">BUY</span>
        </button>
      </div>

      {/* Open Positions */}
      {positions.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-gray-400 text-[10px]">Positions ({positions.length})</span>
            <button onClick={closeAll} className="text-red-400 text-[10px] hover:underline">Close All</button>
          </div>
          {positions.map(pos => {
            const pnl = getPositionPnL(pos)
            return (
              <div key={pos.id} className={`flex items-center justify-between p-2 rounded-lg text-[10px] ${pnl >= 0 ? 'bg-emerald-500/5 border border-emerald-500/20' : 'bg-red-500/5 border border-red-500/20'}`}>
                <div>
                  <span className={`font-bold ${pos.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>{pos.side.toUpperCase()}</span>
                  <span className="text-gray-300 ml-1">{pos.qty} @ ${pos.entryPrice.toFixed(0)} ({pos.leverage}x)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</span>
                  <button onClick={() => closePosition(pos.id)} className="px-1.5 py-0.5 bg-[#2a2a5a] text-gray-300 rounded hover:bg-red-500/20 hover:text-red-400">✕</button>
                </div>
              </div>
            )
          })}
          <div className="text-right">
            <span className={`text-xs font-bold ${totalUnrealizedPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              Total: {totalUnrealizedPnL >= 0 ? '+' : ''}${totalUnrealizedPnL.toFixed(2)}
            </span>
          </div>
        </div>
      )}

      {/* Pending Orders */}
      {pendingOrders.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-gray-400 text-[10px]">Pending Orders ({pendingOrders.length})</span>
            <button onClick={() => { setPendingOrders([]); toast.success('All orders cancelled') }} className="text-red-400 text-[10px] hover:underline">Cancel All</button>
          </div>
          {pendingOrders.map(order => (
            <div key={order.id} className="flex items-center justify-between p-2 rounded-lg text-[10px] bg-yellow-500/5 border border-yellow-500/20">
              <div>
                <span className={`font-bold ${order.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>{order.side.toUpperCase()}</span>
                <span className="text-gray-300 ml-1">{order.qty} @ ${order.price.toFixed(2)} ({order.leverage}x)</span>
                <span className="text-yellow-400 ml-1 text-[9px]">[{order.orderType.toUpperCase()}]</span>
              </div>
              <button onClick={() => cancelPendingOrder(order.id)} className="px-1.5 py-0.5 bg-[#2a2a5a] text-gray-300 rounded hover:bg-red-500/20 hover:text-red-400">✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Balance */}
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-gray-400">Balance: <span className="text-white font-medium">${balance.toFixed(2)}</span></span>
        <button onClick={() => { if(window.confirm('Reset to $100,000?')){ setBalance(100000); setPositions([]); setPendingOrders([]); setHistory([]) }}}
          className="text-gray-500 hover:text-gray-300">Reset</button>
      </div>

      {/* ===== ORDER POPUP ===== */}
      {showOrderPopup && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4" onClick={closePopup}>
          <div className="bg-[#1a1a2e] border border-[#2a2a5a] rounded-2xl w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="p-4 border-b border-[#2a2a5a]/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-white font-semibold">📊 {symbol}</span>
                </div>
                <button onClick={closePopup} className="text-gray-400 hover:text-white text-xl">✕</button>
              </div>

              {/* Buy/Sell Toggle */}
              <div className="flex mt-3 bg-[#0a0a1f] rounded-xl p-1">
                <button onClick={() => setOrderSide('sell')}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${orderSide === 'sell' ? 'bg-red-500 text-white' : 'text-gray-400'}`}>
                  Sell<br/><span className="text-xs">{currentPrice ? currentPrice.toLocaleString() : '...'}</span>
                </button>
                <button onClick={() => setOrderSide('buy')}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${orderSide === 'buy' ? 'bg-blue-500 text-white' : 'text-gray-400'}`}>
                  Buy<br/><span className="text-xs">{currentPrice ? currentPrice.toLocaleString() : '...'}</span>
                </button>
              </div>
            </div>

            {/* Order Type Tabs */}
            <div className="px-4 pt-3">
              <div className="flex border-b border-[#2a2a5a]/50">
                {['market', 'limit', 'stop'].map(type => (
                  <button key={type} onClick={() => setOrderType(type)}
                    className={`flex-1 pb-2 text-sm font-medium capitalize border-b-2 transition-all ${orderType === type ? 'border-blue-500 text-white' : 'border-transparent text-gray-400'}`}>
                    {type}
                  </button>
                ))}
              </div>
            </div>

            {/* Order Form */}
            <div className="p-4 space-y-3">
              {/* Limit/Stop Price */}
              {orderType !== 'market' && (
                <div>
                  <label className="text-gray-400 text-xs">{orderType === 'limit' ? 'Limit' : 'Stop'} Price</label>
                  <input type="number" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)}
                    className="input-field text-sm py-2 mt-1" step="any" />
                </div>
              )}

              {/* Units */}
              <div>
                <label className="text-gray-400 text-xs flex items-center justify-between">
                  <span>Units</span>
                  <span className="text-gray-500">{tradeValue.toFixed(2)} USD</span>
                </label>
                <input type="number" value={units} onChange={(e) => setUnits(e.target.value)}
                  className="input-field text-sm py-2 mt-1" step="any" />
              </div>

              {/* Exits */}
              <div className="pt-2 border-t border-[#2a2a5a]/30">
                <p className="text-gray-400 text-xs font-medium mb-2">Exits</p>

                {/* Take Profit */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 flex-1">
                    <span className="text-gray-400 text-xs">Take profit, price</span>
                  </div>
                  <button onClick={() => setTpEnabled(!tpEnabled)}
                    className={`w-10 h-5 rounded-full transition-all relative ${tpEnabled ? 'bg-blue-500' : 'bg-[#2a2a5a]'}`}>
                    <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all ${tpEnabled ? 'right-0.5' : 'left-0.5'}`}></div>
                  </button>
                </div>
                {tpEnabled && (
                  <div className="flex items-center gap-2 mb-2">
                    <input type="number" value={tpPrice} onChange={(e) => setTpPrice(e.target.value)}
                      className="input-field text-sm py-1.5 flex-1" step="any" />
                    <span className="text-gray-500 text-xs">{tpTicks} ticks</span>
                  </div>
                )}

                {/* Stop Loss */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 flex-1">
                    <span className="text-gray-400 text-xs">Stop loss, price</span>
                  </div>
                  <button onClick={() => setSlEnabled(!slEnabled)}
                    className={`w-10 h-5 rounded-full transition-all relative ${slEnabled ? 'bg-blue-500' : 'bg-[#2a2a5a]'}`}>
                    <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all ${slEnabled ? 'right-0.5' : 'left-0.5'}`}></div>
                  </button>
                </div>
                {slEnabled && (
                  <div className="flex items-center gap-2 mb-2">
                    <input type="number" value={slPrice} onChange={(e) => setSlPrice(e.target.value)}
                      className="input-field text-sm py-1.5 flex-1" step="any" />
                    <span className="text-gray-500 text-xs">{slTicks} ticks</span>
                  </div>
                )}
              </div>

              {/* Order Info */}
              <div className="pt-2 border-t border-[#2a2a5a]/30 space-y-1.5">
                <p className="text-gray-400 text-xs font-medium">Order info</p>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Margin</span>
                  <span className="text-white">{marginRequired.toFixed(2)} / {balance.toFixed(2)}</span>
                </div>
                <div className="w-full bg-[#2a2a5a] rounded-full h-1.5">
                  <div className="bg-blue-500 h-1.5 rounded-full" style={{width: `${Math.min((marginRequired/balance)*100, 100)}%`}}></div>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Leverage</span>
                  <span className="text-white">{leverage}:1</span>
                </div>
                <div>
                  <input type="range" min="1" max="100" value={leverage} onChange={(e) => setLeverage(e.target.value)}
                    className="w-full h-1 bg-[#2a2a5a] rounded-full appearance-none cursor-pointer" />
                  <div className="flex justify-between text-[10px] text-gray-500 mt-0.5">
                    <span>1x</span><span>25x</span><span>50x</span><span>100x</span>
                  </div>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Trade value</span>
                  <span className="text-white">{tradeValue.toFixed(2)} USD</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Risk</span>
                  <span className="text-white">{riskPercent}% / ${risk.toFixed(2)} USD</span>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="p-4 pt-0 flex gap-3">
              <button onClick={closePopup}
                className="flex-1 py-3 rounded-xl border border-[#2a2a5a] text-gray-300 font-medium text-sm hover:bg-[#2a2a5a]/30 transition-all">
                Discard
              </button>
              <button onClick={placeOrder}
                className={`flex-[2] py-3 rounded-xl font-bold text-sm text-white transition-all ${orderSide === 'buy' ? 'bg-blue-500 hover:bg-blue-600' : 'bg-red-500 hover:bg-red-600'}`}>
                {orderSide === 'buy' ? 'Buy' : 'Sell'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default DemoTrading
