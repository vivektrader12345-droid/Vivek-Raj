import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Clock3, History, ListChecks, WalletCards, X, XCircle } from 'lucide-react'
import useTradingStore from '../stores/tradingStore'
import { OrderSide, formatDuration, formatPnL, formatPrice, formatROI } from '../types'

const TABS = [
  ['positions', 'Positions'], ['open', 'Open Orders'], ['pending', 'Pending Orders'],
  ['trades', 'Trade History'], ['orders', 'Order History'], ['portfolio', 'Portfolio'],
  ['account', 'Account'], ['activity', 'Activity'], ['logs', 'Logs'],
]

const empty = (icon, title, detail) => <div className="flex h-32 flex-col items-center justify-center text-center"><div className="mb-2 text-slate-600">{icon}</div><p className="text-xs font-semibold text-slate-400">{title}</p><p className="mt-1 text-[10px] text-slate-600">{detail}</p></div>

export default function TradingDock() {
  const positions = useTradingStore(s => s.positions)
  const pendingOrders = useTradingStore(s => s.pendingOrders)
  const trades = useTradingStore(s => s.trades)
  const account = useTradingStore(s => s.account)
  const currentPrice = useTradingStore(s => s.currentPrice)
  const closePosition = useTradingStore(s => s.closePosition)
  const closeAllPositions = useTradingStore(s => s.closeAllPositions)
  const cancelOrder = useTradingStore(s => s.cancelOrder)
  const cancelAllOrders = useTradingStore(s => s.cancelAllOrders)
  const [tab, setTab] = useState('positions')
  const [collapsed, setCollapsed] = useState(true)

  const totalUnrealized = useMemo(() => positions.reduce((sum, item) => sum + (Number(item.unrealizedPnl) || 0), 0), [positions])
  const logs = useMemo(() => [
    ...positions.map(item => ({ at: item.openedAt, text: `${item.side.toUpperCase()} ${item.symbol} position opened`, tone: item.side === 'buy' ? 'text-emerald-400' : 'text-rose-400' })),
    ...pendingOrders.map(item => ({ at: item.createdAt, text: `${item.type.toUpperCase()} ${item.side.toUpperCase()} order pending`, tone: 'text-amber-400' })),
    ...trades.map(item => ({ at: item.closedAt, text: `${item.symbol} closed · ${formatPnL(item.netPnl)}`, tone: item.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400' })),
  ].sort((a, b) => b.at - a.at).slice(0, 30), [positions, pendingOrders, trades])

  return <section className={`trading-dock ${collapsed ? 'trading-dock--collapsed' : ''}`}>
    <div className="flex h-9 items-center border-b border-white/[.055] bg-[#090d18]/95">
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto no-scrollbar">{TABS.map(([id, label]) => { const count = id === 'positions' ? positions.length : id === 'pending' ? pendingOrders.length : id === 'trades' ? trades.length : null; return <button key={id} type="button" onClick={() => { setTab(id); setCollapsed(false) }} className={`dock-tab ${tab === id ? 'dock-tab--active' : ''}`}>{label}{count !== null && count > 0 && <span>{count}</span>}</button> })}</div>
      <div className="flex shrink-0 items-center gap-3 border-l border-white/[.055] px-2 text-[9px]"><span className="hidden text-slate-500 md:inline">Unrealized <strong className={totalUnrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{formatPnL(totalUnrealized)}</strong></span><button type="button" className="rounded p-1 text-slate-500 hover:bg-white/[.05] hover:text-white" onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button></div>
    </div>
    {!collapsed && <div className="h-[184px] overflow-auto custom-scrollbar">
      {tab === 'positions' && (positions.length ? <div className="min-w-[980px]"><table className="terminal-table"><thead><tr><th>Symbol</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Liq.</th><th>Margin</th><th>Unrealized P&amp;L</th><th>ROI</th><th>SL / TP</th><th>Opened</th><th /></tr></thead><tbody>{positions.map(item => <tr key={item.id}><td className="font-semibold text-slate-100">{item.symbol}</td><td><span className={item.side === OrderSide.BUY ? 'trade-side trade-side--buy' : 'trade-side trade-side--sell'}>{item.side === OrderSide.BUY ? 'LONG' : 'SHORT'} · {item.leverage}×</span></td><td>{item.qty}</td><td>${formatPrice(item.entryPrice)}</td><td>${formatPrice(currentPrice)}</td><td className="text-purple-300">${formatPrice(item.liquidationPrice)}</td><td>${item.margin.toFixed(2)}</td><td className={item.unrealizedPnl >= 0 ? 'font-semibold text-emerald-400' : 'font-semibold text-rose-400'}>{formatPnL(item.unrealizedPnl)}</td><td className={item.roi >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{formatROI(item.roi)}</td><td><span className="text-rose-300">{item.stopLoss ? formatPrice(item.stopLoss) : '—'}</span> / <span className="text-emerald-300">{item.takeProfit ? formatPrice(item.takeProfit) : '—'}</span></td><td>{formatDuration(Date.now() - item.openedAt)}</td><td><button type="button" title="Close position" onClick={() => closePosition(item.id)} className="dock-action dock-action--danger"><X size={12} /> Close</button></td></tr>)}</tbody></table><div className="sticky bottom-0 flex justify-end border-t border-white/[.05] bg-[#080c16]/95 p-1.5"><button type="button" onClick={closeAllPositions} className="dock-action dock-action--danger"><XCircle size={12} /> Close all</button></div></div> : empty(<WalletCards size={22} />, 'No open positions', 'Use the BUY or SELL quote box to open a paper position.'))}

      {tab === 'open' && empty(<ListChecks size={22} />, 'No working market orders', 'Market orders fill immediately and become positions. Limit and stop orders appear under Pending Orders.')}

      {tab === 'pending' && (pendingOrders.length ? <div className="min-w-[820px]"><table className="terminal-table"><thead><tr><th>Symbol</th><th>Type</th><th>Side</th><th>Price</th><th>Quantity</th><th>Leverage</th><th>Margin</th><th>Created</th><th /></tr></thead><tbody>{pendingOrders.map(item => <tr key={item.id}><td>{item.symbol}</td><td className="text-amber-300">{item.type.toUpperCase()}</td><td>{item.side.toUpperCase()}</td><td>${formatPrice(item.price)}</td><td>{item.qty}</td><td>{item.leverage}×</td><td>${item.margin.toFixed(2)}</td><td>{new Date(item.createdAt).toLocaleTimeString()}</td><td><button type="button" onClick={() => cancelOrder(item.id)} className="dock-action dock-action--danger"><X size={12} /> Cancel</button></td></tr>)}</tbody></table><div className="flex justify-end p-1.5"><button type="button" onClick={cancelAllOrders} className="dock-action dock-action--danger">Cancel all</button></div></div> : empty(<Clock3 size={22} />, 'No pending orders', 'Limit and stop paper orders will wait here for their trigger price.'))}

      {(tab === 'trades' || tab === 'orders') && (trades.length ? <div className="min-w-[940px]"><table className="terminal-table"><thead><tr><th>Closed</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Qty</th><th>Leverage</th><th>Net P&amp;L</th><th>ROI</th><th>Reason</th><th>Duration</th></tr></thead><tbody>{trades.slice().reverse().map(item => <tr key={item.id}><td>{new Date(item.closedAt).toLocaleString()}</td><td>{item.symbol}</td><td>{item.side.toUpperCase()}</td><td>${formatPrice(item.entryPrice)}</td><td>${formatPrice(item.exitPrice)}</td><td>{item.qty}</td><td>{item.leverage}×</td><td className={item.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{formatPnL(item.netPnl)}</td><td>{formatROI(item.roi)}</td><td className="capitalize">{item.closeReason?.replaceAll('_', ' ')}</td><td>{formatDuration(item.duration)}</td></tr>)}</tbody></table></div> : empty(<History size={22} />, 'No completed trades', 'Closed paper positions appear here and sync to Trade History.'))}

      {(tab === 'portfolio' || tab === 'account') && <div className="grid h-full gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4"><DockMetric label="Wallet balance" value={`$${account.balance.toFixed(2)}`} /><DockMetric label="Available margin" value={`$${account.availableMargin.toFixed(2)}`} /><DockMetric label="Used margin" value={`$${account.usedMargin.toFixed(2)}`} /><DockMetric label="Total P&L" value={formatPnL(account.totalPnl)} tone={account.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'} /><DockMetric label="Win rate" value={`${account.winRate.toFixed(1)}%`} /><DockMetric label="Trades" value={account.totalTrades} /><DockMetric label="Wins / losses" value={`${account.winningTrades} / ${account.losingTrades}`} /><DockMetric label="Daily P&L" value={formatPnL(account.dailyPnl)} tone={account.dailyPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'} /></div>}

      {(tab === 'activity' || tab === 'logs') && (logs.length ? <div className="divide-y divide-white/[.045]">{logs.map((item, index) => <div key={`${item.at}-${index}`} className="flex items-center gap-3 px-4 py-2 text-[10px]"><span className="h-1.5 w-1.5 rounded-full bg-slate-600" /><span className={`font-medium ${item.tone}`}>{item.text}</span><span className="ml-auto text-slate-600">{new Date(item.at).toLocaleString()}</span></div>)}</div> : empty(<ListChecks size={22} />, 'No account activity', 'Order, position, and close activity will be recorded here.'))}
    </div>}
  </section>
}

function DockMetric({ label, value, tone = 'text-slate-100' }) {
  return <div className="rounded-lg border border-white/[.055] bg-white/[.025] p-3"><p className="text-[9px] font-semibold uppercase tracking-[.14em] text-slate-600">{label}</p><p className={`mt-1 text-base font-bold tabular-nums ${tone}`}>{value}</p></div>
}
