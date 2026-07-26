import React from 'react'
import { Link } from 'react-router-dom'
import { useTrades } from '../context/TradeContext'
import { useAuth } from '../context/AuthContext'
import { useCurrency } from '../context/CurrencyContext'
import { requestNotificationPermission } from '../utils/notifications'
import { exportMonthlyReport } from '../utils/exportPDF'
import {
  TrendingUp, TrendingDown, Target, DollarSign, Award, Activity,
  ArrowUpRight, ArrowDownRight, Flame, PlusCircle, History
} from 'lucide-react'
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts'

function Dashboard() {
  const { trades, getStats } = useTrades()
  const { user } = useAuth()
  const { formatAmount, symbol } = useCurrency()
  const stats = getStats()

  const recentTrades = trades.slice(0, 7)

  // Mini equity curve for dashboard
  const equityCurve = trades
    .slice()
    .reverse()
    .reduce((acc, trade, idx) => {
      const prev = acc.length > 0 ? acc[acc.length - 1].balance : 0
      acc.push({ trade: idx + 1, balance: parseFloat((prev + trade.pnl).toFixed(2)) })
      return acc
    }, [])

  // Additional stats for photo-matching
  const totalProfit = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0)
  const totalLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0))
  const totalInvested = trades.reduce((s, t) => s + (parseFloat(t.entryPrice)||0) * (parseFloat(t.quantity)||0), 0)
  const returnPercent = totalInvested > 0 ? ((stats.totalPnL / totalInvested) * 100).toFixed(2) : '0.00'
  const availableBalance = stats.totalPnL

  const statCards = [
    { label: 'Total Trades', value: stats.totalTrades, icon: Activity, color: 'text-blue-400', bg: 'from-blue-500/20 to-blue-500/5', borderColor: 'border-blue-500/20' },
    { label: 'Win Rate', value: `${stats.winRate}%`, icon: Target, color: 'text-emerald-400', bg: 'from-emerald-500/20 to-emerald-500/5', borderColor: 'border-emerald-500/20' },
    { label: 'Overall P&L', value: formatAmount(stats.totalPnL), icon: DollarSign, color: stats.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400', bg: stats.totalPnL >= 0 ? 'from-emerald-500/20 to-emerald-500/5' : 'from-red-500/20 to-red-500/5', borderColor: stats.totalPnL >= 0 ? 'border-emerald-500/20' : 'border-red-500/20' },
    { label: 'Return %', value: `${returnPercent}%`, icon: Award, color: 'text-cyan-400', bg: 'from-cyan-500/20 to-cyan-500/5', borderColor: 'border-cyan-500/20' },
    { label: 'Total Profit', value: formatAmount(totalProfit), icon: TrendingUp, color: 'text-emerald-400', bg: 'from-emerald-500/20 to-emerald-500/5', borderColor: 'border-emerald-500/20' },
    { label: 'Total Loss', value: formatAmount(totalLoss), icon: TrendingDown, color: 'text-red-400', bg: 'from-red-500/20 to-red-500/5', borderColor: 'border-red-500/20' },
    { label: 'Wins / Losses', value: `${stats.wins} / ${stats.losses}`, icon: Target, color: 'text-purple-400', bg: 'from-purple-500/20 to-purple-500/5', borderColor: 'border-purple-500/20' },
    { label: 'Available Balance', value: formatAmount(availableBalance), icon: DollarSign, color: availableBalance >= 0 ? 'text-emerald-400' : 'text-red-400', bg: availableBalance >= 0 ? 'from-emerald-500/20 to-emerald-500/5' : 'from-red-500/20 to-red-500/5', borderColor: availableBalance >= 0 ? 'border-emerald-500/20' : 'border-red-500/20' },
  ]

  const getGreeting = () => {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good Morning'
    if (hour < 18) return 'Good Afternoon'
    return 'Good Evening'
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl lg:text-3xl font-bold text-white">
            {getGreeting()}, <span className="bg-gradient-to-r from-[#e94560] to-[#f5a623] bg-clip-text text-transparent">{user?.fullName?.split(' ')[0]}</span> 👋
          </h1>
          <p className="text-gray-400 mt-1">Here's your trading performance overview</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => exportMonthlyReport(trades)}
            className="flex items-center gap-2 px-4 py-2 bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded-xl hover:bg-purple-500/30 transition-all text-sm">
            📤 Export PDF
          </button>
          <button onClick={requestNotificationPermission}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-xl hover:bg-blue-500/30 transition-all text-sm">
            🔔 Notifications
          </button>
          <Link
            to="/add-trade"
            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-[#e94560] to-[#f5a623] text-white font-medium rounded-xl hover:shadow-lg hover:shadow-[#e94560]/20 transition-all w-fit"
          >
            <PlusCircle size={18} />
            New Trade
          </Link>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map(({ label, value, icon: Icon, color, bg, borderColor }) => (
          <div key={label} className={`bg-gradient-to-br ${bg} border ${borderColor} rounded-xl p-4 lg:p-5 hover:scale-[1.02] transition-transform duration-200`}>
            <div className="flex items-center justify-between mb-3">
              <Icon size={22} className={color} />
              {label === 'Win Rate' && stats.totalTrades > 0 && (
                <span className="text-xs text-gray-500">{stats.wins}W / {stats.losses}L</span>
              )}
            </div>
            <p className={`text-xl lg:text-2xl font-bold ${color}`}>{value}</p>
            <p className="text-gray-400 text-xs mt-1.5 font-medium uppercase tracking-wide">{label}</p>
          </div>
        ))}
      </div>

      {/* Charts and Streak Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Mini Equity Curve */}
        <div className="lg:col-span-2 glass-card p-5">
          <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
            <TrendingUp size={18} className="text-[#e94560]" />
            Equity Curve
          </h3>
          {equityCurve.length > 1 ? (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={equityCurve}>
                <Tooltip
                  contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #0f3460', borderRadius: '8px', fontSize: '12px' }}
                  labelStyle={{ color: '#9ca3af' }}
                  formatter={(value) => [`${symbol}${value}`, 'Balance']}
                />
                <Line
                  type="monotone"
                  dataKey="balance"
                  stroke="#e94560"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: '#e94560' }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[180px] flex items-center justify-center text-gray-500 text-sm">
              Add more trades to see your equity curve
            </div>
          )}
        </div>

        {/* Streak & Quick Stats */}
        <div className="glass-card p-5 space-y-4">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <Flame size={18} className="text-orange-400" />
            Streak
          </h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a1a]/50">
              <span className="text-gray-400 text-sm">Current</span>
              <span className={`font-bold text-lg ${stats.currentStreak > 0 ? 'text-emerald-400' : stats.currentStreak < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                {stats.currentStreak > 0 ? `${stats.currentStreak}W` : stats.currentStreak < 0 ? `${Math.abs(stats.currentStreak)}L` : '-'}
              </span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a1a]/50">
              <span className="text-gray-400 text-sm">Best Win Streak</span>
              <span className="font-bold text-emerald-400">{stats.longestWinStreak}</span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a1a]/50">
              <span className="text-gray-400 text-sm">Worst Loss Streak</span>
              <span className="font-bold text-red-400">{stats.longestLossStreak}</span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a1a]/50">
              <span className="text-gray-400 text-sm">Expectancy</span>
              <span className={`font-bold ${stats.expectancy >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{formatAmount(stats.expectancy)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Trades */}
      <div className="glass-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <History size={18} className="text-blue-400" />
            Recent Trades
          </h3>
          {trades.length > 0 && (
            <Link to="/history" className="text-[#e94560] text-sm hover:underline">View All →</Link>
          )}
        </div>

        {recentTrades.length === 0 ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-3">📊</div>
            <p className="text-gray-400 font-medium">No trades yet</p>
            <p className="text-gray-500 text-sm mt-1">Start logging your trades to track your performance</p>
            <Link to="/add-trade" className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-[#e94560]/20 text-[#e94560] rounded-lg hover:bg-[#e94560]/30 transition-colors">
              <PlusCircle size={16} />
              Add First Trade
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs uppercase tracking-wider">
                  <th className="text-left py-3 px-3">Pair</th>
                  <th className="text-left py-3 px-3">Type</th>
                  <th className="text-left py-3 px-3">Entry</th>
                  <th className="text-left py-3 px-3">Exit</th>
                  <th className="text-left py-3 px-3">P&L</th>
                  <th className="text-left py-3 px-3">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#0f3460]/30">
                {recentTrades.map(trade => (
                  <tr key={trade.id} className="hover:bg-[#0f3460]/10 transition-colors">
                    <td className="py-3 px-3 font-medium text-white">{trade.pair}</td>
                    <td className="py-3 px-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${trade.type === 'long' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                        {trade.type === 'long' ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                        {trade.type.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-gray-300">{symbol}{trade.entryPrice}</td>
                    <td className="py-3 px-3 text-gray-300">{symbol}{trade.exitPrice}</td>
                    <td className={`py-3 px-3 font-semibold ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {trade.pnl >= 0 ? '+' : ''}{formatAmount(trade.pnl)}
                    </td>
                    <td className="py-3 px-3 text-gray-400 text-xs">{new Date(trade.date).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default Dashboard
