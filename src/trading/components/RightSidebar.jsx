/**
 * RightSidebar - Professional trading sidebar
 * Tabs: Positions, Pending Orders, Trade History, Account
 * Shows real-time data with Zustand subscriptions
 */
import React, { useState } from 'react'
import useTradingStore from '../stores/tradingStore'
import useSettingsStore from '../stores/settingsStore'
import { OrderSide, formatPrice, formatPnL, formatROI, formatDuration } from '../types'

const TABS = [
  { id: 'positions', label: 'Positions' },
  { id: 'orders', label: 'Orders' },
  { id: 'history', label: 'History' },
  { id: 'account', label: 'Account' },
]

function RightSidebar() {
  const { sidebarTab, setSidebarTab } = useSettingsStore()
  const positions = useTradingStore(s => s.positions)
  const pendingOrders = useTradingStore(s => s.pendingOrders)
  const trades = useTradingStore(s => s.trades)
  const account = useTradingStore(s => s.account)

  return (
    <div className="w-[300px] h-full flex flex-col bg-[#0d0d22] border-l border-[#1e1e3a] overflow-hidden">
      {/* Tab Bar */}
      <div className="flex border-b border-[#1e1e3a] shrink-0">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setSidebarTab(tab.id)}
            className={`flex-1 py-2 text-[10px] font-medium transition-all relative ${
              sidebarTab === tab.id
                ? 'text-white'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.label}
            {tab.id === 'positions' && positions.length > 0 && (
              <span className="ml-0.5 text-[9px] text-[#26a69a]">({positions.length})</span>
            )}
            {tab.id === 'orders' && pendingOrders.length > 0 && (
              <span className="ml-0.5 text-[9px] text-yellow-400">({pendingOrders.length})</span>
            )}
            {sidebarTab === tab.id && (
              <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#26a69a]" />
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {sidebarTab === 'positions' && <PositionsTab positions={positions} />}
        {sidebarTab === 'orders' && <OrdersTab orders={pendingOrders} />}
        {sidebarTab === 'history' && <HistoryTab trades={trades} />}
        {sidebarTab === 'account' && <AccountTab account={account} trades={trades} />}
      </div>
    </div>
  )
}

// ==================== POSITIONS TAB ====================
function PositionsTab({ positions }) {
  const closePosition = useTradingStore(s => s.closePosition)
  const closeAllPositions = useTradingStore(s => s.closeAllPositions)
  const currentPrice = useTradingStore(s => s.currentPrice)

  if (positions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 text-xs p-4">
        <span className="text-2xl mb-2">📭</span>
        <span>No open positions</span>
      </div>
    )
  }

  const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)

  return (
    <div className="p-2 space-y-1.5">
      {/* Header with total + close all */}
      <div className="flex items-center justify-between px-1 pb-1 border-b border-[#1e1e3a]/50">
        <span className={`text-xs font-bold ${totalPnl >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
          Total: {formatPnL(totalPnl)}
        </span>
        <button
          onClick={closeAllPositions}
          className="text-[9px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded bg-red-400/10 hover:bg-red-400/20"
        >
          Close All
        </button>
      </div>

      {/* Position cards */}
      {positions.map(pos => {
        const isProfit = pos.unrealizedPnl >= 0
        const posSize = pos.entryPrice * pos.qty
        return (
          <div key={pos.id} className={`p-2 rounded-lg border ${
            isProfit ? 'bg-[#26a69a]/5 border-[#26a69a]/20' : 'bg-[#ef5350]/5 border-[#ef5350]/20'
          }`}>
            {/* Row 1: Side + Symbol + Close */}
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                  pos.side === OrderSide.BUY ? 'bg-[#26a69a]/20 text-[#26a69a]' : 'bg-[#ef5350]/20 text-[#ef5350]'
                }`}>
                  {pos.side.toUpperCase()} {pos.leverage}x
                </span>
                <span className="text-gray-300 text-[10px] font-medium">{pos.symbol}</span>
              </div>
              <button
                onClick={() => closePosition(pos.id)}
                className="text-[9px] text-gray-400 hover:text-red-400 px-1 py-0.5 rounded hover:bg-red-400/10"
              >
                Close
              </button>
            </div>

            {/* Row 2: PnL + ROI */}
            <div className="flex items-baseline gap-2 mb-1">
              <span className={`text-sm font-bold ${isProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
                {formatPnL(pos.unrealizedPnl)}
              </span>
              <span className={`text-[10px] ${isProfit ? 'text-[#26a69a]/70' : 'text-[#ef5350]/70'}`}>
                {formatROI(pos.roi)}
              </span>
            </div>

            {/* Row 3: Details grid */}
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
              <div className="flex justify-between">
                <span className="text-gray-500">Entry</span>
                <span className="text-gray-300">${formatPrice(pos.entryPrice)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Mark</span>
                <span className="text-gray-300">${formatPrice(currentPrice)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Size</span>
                <span className="text-gray-300">${posSize.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Margin</span>
                <span className="text-gray-300">${pos.margin.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Liq.</span>
                <span className="text-[#9c27b0]">${formatPrice(pos.liquidationPrice)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Qty</span>
                <span className="text-gray-300">{pos.qty}</span>
              </div>
              {pos.stopLoss && (
                <div className="flex justify-between">
                  <span className="text-gray-500">SL</span>
                  <span className="text-[#ff4976]">${formatPrice(pos.stopLoss)}</span>
                </div>
              )}
              {pos.takeProfit && (
                <div className="flex justify-between">
                  <span className="text-gray-500">TP</span>
                  <span className="text-[#4caf50]">${formatPrice(pos.takeProfit)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">Expected +</span>
                <span className="text-[#4caf50]">+${Number(pos.expectedProfit || 0).toFixed(2)} ({Number(pos.profitPercent || 0).toFixed(2)}%)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Expected -</span>
                <span className="text-[#ff4976]">-${Number(pos.expectedLoss || 0).toFixed(2)} ({Number(pos.lossPercent || 0).toFixed(2)}%)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Risk : Reward</span>
                <span className="text-cyan-400">1:{Number(pos.riskRewardRatio || 0).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Fee</span>
                <span className="text-gray-300">-${pos.totalFees.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Time</span>
                <span className="text-gray-300">{formatDuration(Date.now() - pos.openedAt)}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ==================== ORDERS TAB ====================
function OrdersTab({ orders }) {
  const cancelOrder = useTradingStore(s => s.cancelOrder)
  const cancelAllOrders = useTradingStore(s => s.cancelAllOrders)
  const currentPrice = useTradingStore(s => s.currentPrice)

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 text-xs p-4">
        <span className="text-2xl mb-2">📋</span>
        <span>No pending orders</span>
      </div>
    )
  }

  return (
    <div className="p-2 space-y-1.5">
      {/* Header */}
      <div className="flex items-center justify-between px-1 pb-1 border-b border-[#1e1e3a]/50">
        <span className="text-xs text-gray-400">{orders.length} pending</span>
        <button
          onClick={cancelAllOrders}
          className="text-[9px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded bg-red-400/10 hover:bg-red-400/20"
        >
          Cancel All
        </button>
      </div>

      {orders.map(order => {
        const isBuy = order.side === OrderSide.BUY
        const distance = currentPrice ? ((order.price - currentPrice) / currentPrice * 100).toFixed(2) : '—'

        return (
          <div key={order.id} className="p-2 rounded-lg bg-[#ffab00]/5 border border-[#ffab00]/20">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                  isBuy ? 'bg-[#26a69a]/20 text-[#26a69a]' : 'bg-[#ef5350]/20 text-[#ef5350]'
                }`}>
                  {order.type.toUpperCase()} {order.side.toUpperCase()}
                </span>
                <span className="text-gray-300 text-[10px]">{order.leverage}x</span>
              </div>
              <button
                onClick={() => cancelOrder(order.id)}
                className="text-[9px] text-gray-400 hover:text-red-400 px-1 py-0.5 rounded hover:bg-red-400/10"
              >
                Cancel
              </button>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
              <div className="flex justify-between">
                <span className="text-gray-500">Price</span>
                <span className="text-yellow-400">${formatPrice(order.price)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Qty</span>
                <span className="text-gray-300">{order.qty}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Margin</span>
                <span className="text-gray-300">${order.margin.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Distance</span>
                <span className={`${parseFloat(distance) >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
                  {distance}%
                </span>
              </div>
              {order.stopLoss && (
                <div className="flex justify-between">
                  <span className="text-gray-500">SL</span>
                  <span className="text-[#ff4976]">${formatPrice(order.stopLoss)}</span>
                </div>
              )}
              {order.takeProfit && (
                <div className="flex justify-between">
                  <span className="text-gray-500">TP</span>
                  <span className="text-[#4caf50]">${formatPrice(order.takeProfit)}</span>
                </div>
              )}
            </div>

            <div className="mt-1 text-[8px] text-gray-500">
              {new Date(order.createdAt).toLocaleString()}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ==================== HISTORY TAB ====================
function HistoryTab({ trades }) {
  const [selectedTrade, setSelectedTrade] = useState(null)

  if (trades.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 text-xs p-4">
        <span className="text-2xl mb-2">📊</span>
        <span>No trade history</span>
      </div>
    )
  }

  // Show detailed trade view
  if (selectedTrade) {
    const t = selectedTrade
    const isProfit = t.netPnl >= 0
    return (
      <div className="p-3 space-y-2">
        <button onClick={() => setSelectedTrade(null)} className="text-[10px] text-gray-400 hover:text-white">
          ← Back to list
        </button>
        <div className={`p-3 rounded-lg border ${isProfit ? 'bg-[#26a69a]/5 border-[#26a69a]/30' : 'bg-[#ef5350]/5 border-[#ef5350]/30'}`}>
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-xs px-2 py-0.5 rounded font-bold ${
              t.side === OrderSide.BUY ? 'bg-[#26a69a]/20 text-[#26a69a]' : 'bg-[#ef5350]/20 text-[#ef5350]'
            }`}>
              {t.side.toUpperCase()}
            </span>
            <span className="text-white text-xs font-medium">{t.symbol}</span>
            <span className="text-gray-400 text-[10px]">{t.leverage}x</span>
          </div>

          <div className={`text-lg font-bold mb-2 ${isProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
            {formatPnL(t.netPnl)} <span className="text-sm">({formatROI(t.roi)})</span>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
            <div className="flex justify-between"><span className="text-gray-500">Entry Price</span><span className="text-gray-200">${formatPrice(t.entryPrice)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Exit Price</span><span className="text-gray-200">${formatPrice(t.exitPrice)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Quantity</span><span className="text-gray-200">{t.qty}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Leverage</span><span className="text-gray-200">{t.leverage}x</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Margin</span><span className="text-gray-200">${t.margin.toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Gross P&L</span><span className={isProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}>{formatPnL(t.pnl)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Fees</span><span className="text-gray-200">-${t.fee.toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Funding</span><span className="text-gray-200">-${t.fundingFee.toFixed(4)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Net P&L</span><span className={isProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}>{formatPnL(t.netPnl)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">ROI</span><span className={isProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}>{formatROI(t.roi)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Duration</span><span className="text-gray-200">{formatDuration(t.duration)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Exit Reason</span><span className="text-yellow-400">{t.closeReason.replace('_', ' ').toUpperCase()}</span></div>
            <div className="flex justify-between col-span-2"><span className="text-gray-500">Opened</span><span className="text-gray-200">{new Date(t.openedAt).toLocaleString()}</span></div>
            <div className="flex justify-between col-span-2"><span className="text-gray-500">Closed</span><span className="text-gray-200">{new Date(t.closedAt).toLocaleString()}</span></div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-2 space-y-1">
      {trades.slice().reverse().map(trade => {
        const isProfit = trade.netPnl >= 0
        return (
          <div
            key={trade.id}
            onClick={() => setSelectedTrade(trade)}
            className={`p-2 rounded-lg border cursor-pointer hover:opacity-80 transition-all ${
              isProfit ? 'bg-[#26a69a]/5 border-[#26a69a]/15' : 'bg-[#ef5350]/5 border-[#ef5350]/15'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className={`text-[9px] font-bold ${trade.side === OrderSide.BUY ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
                  {trade.side === OrderSide.BUY ? '▲' : '▼'}
                </span>
                <span className="text-gray-300 text-[10px]">{trade.symbol}</span>
                <span className="text-gray-500 text-[9px]">{trade.leverage}x</span>
              </div>
              <span className={`text-[10px] font-bold ${isProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
                {formatPnL(trade.netPnl)}
              </span>
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-[9px] text-gray-500">
                ${formatPrice(trade.entryPrice)} → ${formatPrice(trade.exitPrice)}
              </span>
              <span className={`text-[9px] ${isProfit ? 'text-[#26a69a]/70' : 'text-[#ef5350]/70'}`}>
                {formatROI(trade.roi)}
              </span>
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-[8px] text-gray-600">{formatDuration(trade.duration)}</span>
              <span className="text-[8px] text-gray-600 capitalize">{trade.closeReason.replace('_', ' ')}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ==================== ACCOUNT TAB ====================
function AccountTab({ account, trades }) {
  const resetAccount = useTradingStore(s => s.resetAccount)
  const totalPnlIsProfit = account.totalPnl >= 0
  const dailyIsProfit = account.dailyPnl >= 0

  return (
    <div className="p-3 space-y-3">
      {/* Balance Card */}
      <div className="p-3 rounded-lg bg-[#12122a] border border-[#1e1e3a]">
        <div className="text-[9px] text-gray-500 uppercase tracking-wider">Wallet Balance</div>
        <div className="text-xl font-bold text-white mt-0.5">
          ${account.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>

      {/* Margin Info */}
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2 rounded-lg bg-[#12122a] border border-[#1e1e3a]">
          <div className="text-[8px] text-gray-500 uppercase">Available</div>
          <div className="text-xs text-white font-medium">${account.availableMargin.toFixed(2)}</div>
        </div>
        <div className="p-2 rounded-lg bg-[#12122a] border border-[#1e1e3a]">
          <div className="text-[8px] text-gray-500 uppercase">Used Margin</div>
          <div className="text-xs text-white font-medium">${account.usedMargin.toFixed(2)}</div>
        </div>
      </div>

      {/* PnL Summary */}
      <div className="p-3 rounded-lg bg-[#12122a] border border-[#1e1e3a] space-y-1.5">
        <div className="flex justify-between items-center">
          <span className="text-[10px] text-gray-500">Daily P&L</span>
          <span className={`text-xs font-bold ${dailyIsProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
            {formatPnL(account.dailyPnl)}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-[10px] text-gray-500">Total P&L</span>
          <span className={`text-xs font-bold ${totalPnlIsProfit ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
            {formatPnL(account.totalPnl)}
          </span>
        </div>
        <div className="w-full bg-[#1e1e3a] rounded-full h-1">
          <div
            className={`h-1 rounded-full ${totalPnlIsProfit ? 'bg-[#26a69a]' : 'bg-[#ef5350]'}`}
            style={{ width: `${Math.min(Math.abs(account.totalPnl / 1000) * 100, 100)}%` }}
          />
        </div>
      </div>

      {/* Statistics */}
      <div className="p-3 rounded-lg bg-[#12122a] border border-[#1e1e3a] space-y-1.5">
        <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">Statistics</div>
        <div className="flex justify-between text-[10px]">
          <span className="text-gray-400">Total Trades</span>
          <span className="text-white">{account.totalTrades}</span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span className="text-gray-400">Winning</span>
          <span className="text-[#26a69a]">{account.winningTrades}</span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span className="text-gray-400">Losing</span>
          <span className="text-[#ef5350]">{account.losingTrades}</span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span className="text-gray-400">Win Rate</span>
          <span className={`font-bold ${account.winRate >= 50 ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
            {account.winRate.toFixed(1)}%
          </span>
        </div>
        {/* Win rate bar */}
        <div className="flex h-1.5 rounded-full overflow-hidden bg-[#1e1e3a]">
          <div className="bg-[#26a69a] h-full" style={{ width: `${account.winRate}%` }} />
          <div className="bg-[#ef5350] h-full" style={{ width: `${100 - account.winRate}%` }} />
        </div>
      </div>

      {/* Reset button */}
      <button
        onClick={() => { if (window.confirm('Reset account to $100,000? All data will be lost.')) resetAccount() }}
        className="w-full py-2 text-[10px] text-red-400 border border-red-400/20 rounded-lg hover:bg-red-400/10 transition-all"
      >
        Reset Account
      </button>
    </div>
  )
}

export default RightSidebar
