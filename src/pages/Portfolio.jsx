import React, { useMemo } from 'react'
import { useTrades } from '../context/TradeContext'
import { Briefcase, TrendingUp, TrendingDown, Coins, PieChart as PieIcon } from 'lucide-react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'

const COLORS = ['#e94560', '#f5a623', '#00c853', '#2196f3', '#9c27b0', '#ff5722', '#00bcd4', '#8bc34a', '#ff9800', '#e91e63']

function Portfolio() {
  const { trades, getStats } = useTrades()
  const stats = getStats()

  const portfolioByPair = useMemo(() => {
    const grouped = trades.reduce((acc, trade) => {
      const pair = trade.pair
      if (!acc[pair]) acc[pair] = { pair, totalPnL: 0, trades: 0, wins: 0, losses: 0, volume: 0 }
      acc[pair].trades++
      acc[pair].totalPnL += trade.pnl
      acc[pair].volume += (parseFloat(trade.entryPrice) || 0) * (parseFloat(trade.quantity) || 0)
      if (trade.pnl > 0) acc[pair].wins++
      else if (trade.pnl < 0) acc[pair].losses++
      return acc
    }, {})
    return Object.values(grouped).sort((a, b) => b.totalPnL - a.totalPnL)
  }, [trades])

  const portfolioByStrategy = useMemo(() => {
    const grouped = trades.reduce((acc, trade) => {
      const strategy = trade.strategy || 'No Strategy'
      if (!acc[strategy]) acc[strategy] = { strategy, totalPnL: 0, trades: 0 }
      acc[strategy].trades++
      acc[strategy].totalPnL += trade.pnl
      return acc
    }, {})
    return Object.values(grouped).sort((a, b) => b.trades - a.trades)
  }, [trades])

  // Pie chart data - trades by pair
  const tradeDistribution = portfolioByPair.map((p, i) => ({
    name: p.pair,
    value: p.trades,
    color: COLORS[i % COLORS.length],
  }))

  const totalBalance = stats.totalPnL
  const totalVolume = portfolioByPair.reduce((sum, p) => sum + p.volume, 0)
  const profitablePairs = portfolioByPair.filter(p => p.totalPnL > 0).length
  const bestPair = portfolioByPair[0]
  const worstPair = portfolioByPair[portfolioByPair.length - 1]

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl lg:text-3xl font-bold text-white flex items-center gap-3">
          <Briefcase className="text-[#e94560]" /> Portfolio
        </h1>
        <p className="text-gray-400 mt-1 text-sm">Complete breakdown of your trading portfolio</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-2">
            <Coins size={18} className="text-[#f5a623]" />
            <span className="text-gray-400 text-xs uppercase tracking-wider">Net P&L</span>
          </div>
          <p className={`text-2xl font-bold ${totalBalance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {totalBalance >= 0 ? '+' : ''}${totalBalance.toFixed(2)}
          </p>
        </div>
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-2">
            <PieIcon size={18} className="text-purple-400" />
            <span className="text-gray-400 text-xs uppercase tracking-wider">Pairs Traded</span>
          </div>
          <p className="text-2xl font-bold text-white">{portfolioByPair.length}</p>
        </div>
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp size={18} className="text-emerald-400" />
            <span className="text-gray-400 text-xs uppercase tracking-wider">Profitable</span>
          </div>
          <p className="text-2xl font-bold text-emerald-400">{profitablePairs}</p>
        </div>
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-2">
            <Coins size={18} className="text-blue-400" />
            <span className="text-gray-400 text-xs uppercase tracking-wider">Total Volume</span>
          </div>
          <p className="text-2xl font-bold text-blue-400">${totalVolume.toFixed(0)}</p>
        </div>
      </div>

      {/* Best / Worst Pair */}
      {portfolioByPair.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="glass-card p-5 border-emerald-500/20">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Best Performing Pair</p>
            <div className="flex items-center justify-between">
              <span className="text-white text-lg font-bold">{bestPair?.pair}</span>
              <span className="text-emerald-400 font-bold text-lg">+${bestPair?.totalPnL.toFixed(2)}</span>
            </div>
            <p className="text-gray-500 text-xs mt-1">{bestPair?.trades} trades • {bestPair?.wins} wins</p>
          </div>
          {worstPair && worstPair.totalPnL < 0 && (
            <div className="glass-card p-5 border-red-500/20">
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Worst Performing Pair</p>
              <div className="flex items-center justify-between">
                <span className="text-white text-lg font-bold">{worstPair?.pair}</span>
                <span className="text-red-400 font-bold text-lg">${worstPair?.totalPnL.toFixed(2)}</span>
              </div>
              <p className="text-gray-500 text-xs mt-1">{worstPair?.trades} trades • {worstPair?.losses} losses</p>
            </div>
          )}
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Trade Distribution Pie */}
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4">Trade Distribution by Pair</h3>
          {tradeDistribution.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie data={tradeDistribution} dataKey="value" cx="50%" cy="50%" outerRadius={90} innerRadius={50} paddingAngle={2}>
                    {tradeDistribution.map((entry, idx) => <Cell key={idx} fill={entry.color} />)}
                  </Pie>
                  <Tooltip contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #0f3460', borderRadius: '8px', fontSize: '12px' }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap justify-center gap-3 mt-2">
                {tradeDistribution.slice(0, 6).map(d => (
                  <div key={d.name} className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }}></div>
                    <span className="text-gray-400 text-xs">{d.name} ({d.value})</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="h-[250px] flex items-center justify-center text-gray-500">No data</div>
          )}
        </div>

        {/* P&L by Pair Bar */}
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4">P&L by Pair</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={portfolioByPair.slice(0, 10)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
              <XAxis type="number" stroke="#6b7280" fontSize={11} />
              <YAxis dataKey="pair" type="category" stroke="#6b7280" fontSize={11} width={80} />
              <Tooltip contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #0f3460', borderRadius: '8px', fontSize: '12px' }} formatter={(v) => [`$${v.toFixed(2)}`, 'P&L']} />
              <Bar dataKey="totalPnL" radius={[0, 4, 4, 0]}>
                {portfolioByPair.slice(0, 10).map((entry, idx) => (
                  <Cell key={idx} fill={entry.totalPnL >= 0 ? '#00c853' : '#ff1744'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Portfolio Table */}
      <div className="glass-card p-5">
        <h3 className="text-white font-semibold mb-4">Detailed Breakdown</h3>
        {portfolioByPair.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400">No portfolio data. Add trades to build your portfolio view.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-[#0f3460]/30">
                <tr className="text-gray-400 text-xs uppercase tracking-wider">
                  <th className="text-left py-3 px-3">Pair</th>
                  <th className="text-left py-3 px-3">Trades</th>
                  <th className="text-left py-3 px-3">Wins</th>
                  <th className="text-left py-3 px-3">Losses</th>
                  <th className="text-left py-3 px-3">Win Rate</th>
                  <th className="text-left py-3 px-3">Total P&L</th>
                  <th className="text-left py-3 px-3">Avg P&L</th>
                  <th className="text-left py-3 px-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#0f3460]/20">
                {portfolioByPair.map(item => (
                  <tr key={item.pair} className="hover:bg-[#0f3460]/10 transition-colors">
                    <td className="py-3 px-3 font-medium text-white">{item.pair}</td>
                    <td className="py-3 px-3 text-gray-300">{item.trades}</td>
                    <td className="py-3 px-3 text-emerald-400">{item.wins}</td>
                    <td className="py-3 px-3 text-red-400">{item.losses}</td>
                    <td className="py-3 px-3 text-gray-300">{((item.wins / item.trades) * 100).toFixed(0)}%</td>
                    <td className={`py-3 px-3 font-semibold ${item.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {item.totalPnL >= 0 ? '+' : ''}${item.totalPnL.toFixed(2)}
                    </td>
                    <td className={`py-3 px-3 ${(item.totalPnL / item.trades) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      ${(item.totalPnL / item.trades).toFixed(2)}
                    </td>
                    <td className="py-3 px-3">
                      {item.totalPnL >= 0 ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400 text-xs">
                          <TrendingUp size={12} /> Profit
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-red-400 text-xs">
                          <TrendingDown size={12} /> Loss
                        </span>
                      )}
                    </td>
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

export default Portfolio
