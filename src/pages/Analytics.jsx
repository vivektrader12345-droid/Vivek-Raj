import React, { useMemo } from 'react'
import { useTrades } from '../context/TradeContext'
import { useCurrency } from '../context/CurrencyContext'
import { BarChart3, TrendingUp, Calendar, Target, Clock, Zap } from 'lucide-react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area
} from 'recharts'

function Analytics() {
  const { trades, getStats } = useTrades()
  const { currency: currencyName, symbol: currSymbol, convert } = useCurrency()
  const stats = getStats()

  // Equity Curve
  const equityCurve = useMemo(() => {
    return trades.slice().reverse().reduce((acc, trade, idx) => {
      const prev = acc.length > 0 ? acc[acc.length - 1].balance : 0
      acc.push({
        trade: idx + 1,
        balance: parseFloat((prev + trade.pnl).toFixed(2)),
        date: new Date(trade.date).toLocaleDateString(),
      })
      return acc
    }, [])
  }, [trades])

  // Daily P&L
  const dailyPnL = useMemo(() => {
    const grouped = trades.reduce((acc, trade) => {
      const date = new Date(trade.date).toLocaleDateString()
      if (!acc[date]) acc[date] = { date, pnl: 0, trades: 0 }
      acc[date].pnl += trade.pnl
      acc[date].trades++
      return acc
    }, {})
    return Object.values(grouped).slice(-30)
  }, [trades])

  // Weekly P&L
  const weeklyPnL = useMemo(() => {
    const grouped = trades.reduce((acc, trade) => {
      const d = new Date(trade.date)
      const weekStart = new Date(d)
      weekStart.setDate(d.getDate() - d.getDay())
      const key = weekStart.toLocaleDateString()
      if (!acc[key]) acc[key] = { week: key, pnl: 0, trades: 0 }
      acc[key].pnl += trade.pnl
      acc[key].trades++
      return acc
    }, {})
    return Object.values(grouped).slice(-12)
  }, [trades])

  // Monthly P&L
  const monthlyPnL = useMemo(() => {
    const grouped = trades.reduce((acc, trade) => {
      const d = new Date(trade.date)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!acc[key]) acc[key] = { month: key, pnl: 0, trades: 0 }
      acc[key].pnl += trade.pnl
      acc[key].trades++
      return acc
    }, {})
    return Object.values(grouped)
  }, [trades])

  // Win/Loss Pie
  const pieData = [
    { name: 'Wins', value: stats.wins, color: '#00c853' },
    { name: 'Losses', value: stats.losses, color: '#ff1744' },
    { name: 'Breakeven', value: stats.breakeven, color: '#9ca3af' },
  ].filter(d => d.value > 0)

  // Strategy Performance
  const strategyData = useMemo(() => {
    const grouped = trades.reduce((acc, trade) => {
      const strategy = trade.strategy || 'No Strategy'
      if (!acc[strategy]) acc[strategy] = { name: strategy, wins: 0, losses: 0, pnl: 0, count: 0 }
      acc[strategy].count++
      acc[strategy].pnl += trade.pnl
      if (trade.pnl > 0) acc[strategy].wins++
      else if (trade.pnl < 0) acc[strategy].losses++
      return acc
    }, {})
    return Object.values(grouped).sort((a, b) => b.pnl - a.pnl)
  }, [trades])

  // By Day of Week
  const dayOfWeekData = useMemo(() => {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const grouped = trades.reduce((acc, trade) => {
      const day = new Date(trade.date).getDay()
      if (!acc[day]) acc[day] = { day: days[day], pnl: 0, count: 0, wins: 0 }
      acc[day].count++
      acc[day].pnl += trade.pnl
      if (trade.pnl > 0) acc[day].wins++
      return acc
    }, {})
    return days.map((d, i) => grouped[i] || { day: d, pnl: 0, count: 0, wins: 0 })
  }, [trades])

  // By Hour
  const hourData = useMemo(() => {
    const grouped = trades.reduce((acc, trade) => {
      if (trade.time) {
        const hour = parseInt(trade.time.split(':')[0])
        if (!acc[hour]) acc[hour] = { hour: `${hour}:00`, pnl: 0, count: 0 }
        acc[hour].count++
        acc[hour].pnl += trade.pnl
      }
      return acc
    }, {})
    return Object.values(grouped).sort((a, b) => parseInt(a.hour) - parseInt(b.hour))
  }, [trades])

  // Pair Performance
  const pairData = useMemo(() => {
    const grouped = trades.reduce((acc, trade) => {
      if (!acc[trade.pair]) acc[trade.pair] = { pair: trade.pair, pnl: 0, count: 0, wins: 0 }
      acc[trade.pair].count++
      acc[trade.pair].pnl += trade.pnl
      if (trade.pnl > 0) acc[trade.pair].wins++
      return acc
    }, {})
    return Object.values(grouped).sort((a, b) => b.pnl - a.pnl)
  }, [trades])

  const tooltipStyle = {
    contentStyle: { backgroundColor: '#1a1a2e', border: '1px solid #0f3460', borderRadius: '8px', fontSize: '12px' },
    labelStyle: { color: '#9ca3af' },
  }

  if (trades.length === 0) {
    return (
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl lg:text-3xl font-bold text-white flex items-center gap-3 mb-6">
          <BarChart3 className="text-[#e94560]" /> Analytics
        </h1>
        <div className="glass-card p-16 text-center">
          <div className="text-5xl mb-4">📈</div>
          <p className="text-gray-400 text-lg font-medium">No data yet</p>
          <p className="text-gray-500 text-sm mt-1">Add some trades to see your analytics</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <h1 className="text-2xl lg:text-3xl font-bold text-white flex items-center gap-3">
        <BarChart3 className="text-[#e94560]" /> Analytics
      </h1>

      {/* Top Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="glass-card p-4 text-center">
          <p className="text-gray-400 text-xs uppercase tracking-wider">Best Trade</p>
          <p className="text-emerald-400 text-xl font-bold mt-1">+{currSymbol}{convert(stats.largestWin).toFixed(2)}</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-gray-400 text-xs uppercase tracking-wider">Worst Trade</p>
          <p className="text-red-400 text-xl font-bold mt-1">{currSymbol}{convert(stats.largestLoss).toFixed(2)}</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-gray-400 text-xs uppercase tracking-wider">Profit Factor</p>
          <p className="text-blue-400 text-xl font-bold mt-1">{stats.profitFactor}</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-gray-400 text-xs uppercase tracking-wider">Total Fees</p>
          <p className="text-orange-400 text-xl font-bold mt-1">{currSymbol}{convert(stats.totalFees).toFixed(2)}</p>
        </div>
      </div>

      {/* Row 1: Equity + Win/Loss */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 glass-card p-5">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
            <TrendingUp size={18} className="text-emerald-400" /> Equity Curve
          </h3>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={equityCurve}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
              <XAxis dataKey="trade" stroke="#6b7280" fontSize={11} />
              <YAxis stroke="#6b7280" fontSize={11} />
              <Tooltip {...tooltipStyle} formatter={(v) => [`$${v}`, 'Balance']} />
              <defs>
                <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#e94560" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#e94560" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="balance" stroke="#e94560" strokeWidth={2} fill="url(#equityGradient)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
            <Target size={18} className="text-purple-400" /> Win / Loss
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={pieData} dataKey="value" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}
                label={({ name, value }) => `${name}: ${value}`} labelLine={false}>
                {pieData.map((entry, idx) => <Cell key={idx} fill={entry.color} />)}
              </Pie>
              <Tooltip {...tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex justify-center gap-4 mt-2">
            {pieData.map(d => (
              <div key={d.name} className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }}></div>
                <span className="text-gray-400 text-xs">{d.name} ({d.value})</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Row 2: Daily P&L */}
      <div className="glass-card p-5">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <Calendar size={18} className="text-blue-400" /> Daily P&L
        </h3>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={dailyPnL}>
            <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
            <XAxis dataKey="date" stroke="#6b7280" fontSize={10} angle={-45} textAnchor="end" height={60} />
            <YAxis stroke="#6b7280" fontSize={11} />
            <Tooltip {...tooltipStyle} formatter={(v) => [`$${v.toFixed(2)}`, 'P&L']} />
            <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
              {dailyPnL.map((entry, idx) => (
                <Cell key={idx} fill={entry.pnl >= 0 ? '#00c853' : '#ff1744'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Row 3: Weekly & Monthly */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4">Weekly P&L</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={weeklyPnL}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
              <XAxis dataKey="week" stroke="#6b7280" fontSize={10} />
              <YAxis stroke="#6b7280" fontSize={11} />
              <Tooltip {...tooltipStyle} formatter={(v) => [`$${v.toFixed(2)}`, 'P&L']} />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                {weeklyPnL.map((entry, idx) => <Cell key={idx} fill={entry.pnl >= 0 ? '#00c853' : '#ff1744'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4">Monthly P&L</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlyPnL}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
              <XAxis dataKey="month" stroke="#6b7280" fontSize={10} />
              <YAxis stroke="#6b7280" fontSize={11} />
              <Tooltip {...tooltipStyle} formatter={(v) => [`$${v.toFixed(2)}`, 'P&L']} />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                {monthlyPnL.map((entry, idx) => <Cell key={idx} fill={entry.pnl >= 0 ? '#00c853' : '#ff1744'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Row 4: Day of Week & Hour */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
            <Clock size={18} className="text-cyan-400" /> P&L by Day of Week
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dayOfWeekData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
              <XAxis dataKey="day" stroke="#6b7280" fontSize={10} />
              <YAxis stroke="#6b7280" fontSize={11} />
              <Tooltip {...tooltipStyle} formatter={(v) => [`$${v.toFixed(2)}`, 'P&L']} />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                {dayOfWeekData.map((entry, idx) => <Cell key={idx} fill={entry.pnl >= 0 ? '#00c853' : '#ff1744'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {hourData.length > 0 && (
          <div className="glass-card p-5">
            <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
              <Zap size={18} className="text-yellow-400" /> P&L by Hour
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={hourData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
                <XAxis dataKey="hour" stroke="#6b7280" fontSize={10} />
                <YAxis stroke="#6b7280" fontSize={11} />
                <Tooltip {...tooltipStyle} formatter={(v) => [`$${v.toFixed(2)}`, 'P&L']} />
                <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                  {hourData.map((entry, idx) => <Cell key={idx} fill={entry.pnl >= 0 ? '#00c853' : '#ff1744'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Strategy Performance Table */}
      <div className="glass-card p-5">
        <h3 className="text-white font-semibold mb-4">Strategy Performance</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-xs uppercase tracking-wider border-b border-[#0f3460]/30">
                <th className="text-left py-3 px-3">Strategy</th>
                <th className="text-left py-3 px-3">Trades</th>
                <th className="text-left py-3 px-3">Wins</th>
                <th className="text-left py-3 px-3">Win Rate</th>
                <th className="text-left py-3 px-3">Total P&L</th>
                <th className="text-left py-3 px-3">Avg P&L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#0f3460]/20">
              {strategyData.map(s => (
                <tr key={s.name} className="hover:bg-[#0f3460]/10">
                  <td className="py-3 px-3 text-white font-medium">{s.name}</td>
                  <td className="py-3 px-3 text-gray-300">{s.count}</td>
                  <td className="py-3 px-3 text-emerald-400">{s.wins}</td>
                  <td className="py-3 px-3 text-gray-300">{s.count > 0 ? ((s.wins / s.count) * 100).toFixed(0) : 0}%</td>
                  <td className={`py-3 px-3 font-semibold ${s.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {s.pnl >= 0 ? '+' : ''}{currSymbol}{convert(Math.abs(s.pnl)).toFixed(2)}
                  </td>
                  <td className={`py-3 px-3 ${(s.pnl / s.count) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {currSymbol}{convert(s.pnl / s.count).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pair Performance Table */}
      <div className="glass-card p-5">
        <h3 className="text-white font-semibold mb-4">Pair Performance</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-xs uppercase tracking-wider border-b border-[#0f3460]/30">
                <th className="text-left py-3 px-3">Pair</th>
                <th className="text-left py-3 px-3">Trades</th>
                <th className="text-left py-3 px-3">Win Rate</th>
                <th className="text-left py-3 px-3">Total P&L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#0f3460]/20">
              {pairData.map(p => (
                <tr key={p.pair} className="hover:bg-[#0f3460]/10">
                  <td className="py-3 px-3 text-white font-medium">{p.pair}</td>
                  <td className="py-3 px-3 text-gray-300">{p.count}</td>
                  <td className="py-3 px-3 text-gray-300">{p.count > 0 ? ((p.wins / p.count) * 100).toFixed(0) : 0}%</td>
                  <td className={`py-3 px-3 font-semibold ${p.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {p.pnl >= 0 ? '+' : ''}{currSymbol}{convert(Math.abs(p.pnl)).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default Analytics
