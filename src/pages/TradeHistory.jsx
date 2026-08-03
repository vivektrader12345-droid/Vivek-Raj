import React, { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTrades } from '../context/TradeContext'
import { History, Trash2, Search, Edit3, ArrowUpRight, ArrowDownRight, Download, Trash, Eye } from 'lucide-react'
import CustomSelect from '../components/CustomSelect'
import { useCurrency } from '../context/CurrencyContext'
import CSVImport from '../components/CSVImport'
import toast from 'react-hot-toast'

function TradeHistory() {
  const { trades, deleteTrade, deleteAllTrades } = useTrades()
  const { formatAmount, symbol } = useCurrency()
  const [searchTerm, setSearchTerm] = useState('')
  const [showImportCSV, setShowImportCSV] = useState(false)
  const [filterType, setFilterType] = useState('all')
  const [filterResult, setFilterResult] = useState('all')
  const [filterStrategy, setFilterStrategy] = useState('all')
  const [filterMonth, setFilterMonth] = useState('all')
  const [filterYear, setFilterYear] = useState('all')
  const [filterWeek, setFilterWeek] = useState('all')
  const [filterDay, setFilterDay] = useState('all')
  const [filterSession, setFilterSession] = useState('all')
  const [filterFromDate, setFilterFromDate] = useState('')
  const [filterToDate, setFilterToDate] = useState('')
  const [sortBy, setSortBy] = useState('date-desc')
  const [selectedTrade, setSelectedTrade] = useState(null)
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false)

  const strategies = useMemo(() => {
    const strats = [...new Set(trades.map(t => t.strategy).filter(Boolean))]
    return strats.sort()
  }, [trades])

  const filteredTrades = useMemo(() => {
    let result = trades.filter(trade => {
      const matchSearch = trade.pair?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        trade.strategy?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        trade.notes?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        trade.tags?.toLowerCase().includes(searchTerm.toLowerCase())
      const matchType = filterType === 'all' || trade.type === filterType
      const matchResult = filterResult === 'all' ||
        (filterResult === 'win' && trade.pnl > 0) ||
        (filterResult === 'loss' && trade.pnl < 0) ||
        (filterResult === 'breakeven' && trade.pnl === 0)
      const matchStrategy = filterStrategy === 'all' || trade.strategy === filterStrategy
      const tradeDate = new Date(trade.date)
      const matchMonth = filterMonth === 'all' || tradeDate.getMonth() === parseInt(filterMonth)
      const matchYear = filterYear === 'all' || tradeDate.getFullYear() === parseInt(filterYear)
      const matchDay = filterDay === 'all' || tradeDate.getDay() === parseInt(filterDay)
      const matchWeek = filterWeek === 'all' || Math.ceil(tradeDate.getDate() / 7) === parseInt(filterWeek)
      const matchSession = filterSession === 'all' || (trade.session||'').toLowerCase().includes(filterSession.toLowerCase())
      const matchFromDate = !filterFromDate || new Date(trade.date) >= new Date(filterFromDate)
      const matchToDate = !filterToDate || new Date(trade.date) <= new Date(filterToDate)
      return matchSearch && matchType && matchResult && matchStrategy && matchMonth && matchYear && matchDay && matchWeek && matchSession && matchFromDate && matchToDate
    })

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'date-desc': return new Date(b.date) - new Date(a.date)
        case 'date-asc': return new Date(a.date) - new Date(b.date)
        case 'pnl-desc': return b.pnl - a.pnl
        case 'pnl-asc': return a.pnl - b.pnl
        case 'pair': return a.pair.localeCompare(b.pair)
        default: return 0
      }
    })

    return result
  }, [trades, searchTerm, filterType, filterResult, filterStrategy, filterMonth, filterYear, filterWeek, filterDay, filterSession, filterFromDate, filterToDate, sortBy])

  const handleDelete = (id, pair) => {
    if (window.confirm(`Delete trade for ${pair}?`)) {
      deleteTrade(id)
      toast.success('Trade deleted')
    }
  }

  const handleDeleteAll = () => {
    deleteAllTrades()
    setShowDeleteAllConfirm(false)
    toast.success('All trades deleted')
  }

  const exportCSV = () => {
    const headers = 'Date,Pair,Type,Entry,Exit,Qty,Leverage,P&L,Strategy,Fees,Notes\n'
    const rows = trades.map(t =>
      `${t.date},${t.pair},${t.type},${t.entryPrice},${t.exitPrice},${t.quantity},${t.leverage || 1},${t.pnl},${t.strategy || ''},${t.fees || 0},"${(t.notes || '').replace(/"/g, '""')}"`
    ).join('\n')
    const blob = new Blob([headers + rows], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `vivek-trades-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Trades exported to CSV!')
  }

  const totalFilteredPnL = filteredTrades.reduce((sum, t) => sum + t.pnl, 0)

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl lg:text-3xl font-bold text-white flex items-center gap-3">
            <History className="text-[#e94560]" />
            Trade History
          </h1>
          <p className="text-gray-400 mt-1 text-sm">View and manage all your trades</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowImportCSV(!showImportCSV)}
            className="flex items-center gap-2 px-4 py-2 bg-[#e94560]/20 text-[#e94560] rounded-lg hover:bg-[#e94560]/30 transition-all text-sm border border-[#e94560]/30">
            📊 Import CSV
          </button>
          {trades.length > 0 && (
            <>
              <button onClick={exportCSV} className="flex items-center gap-2 px-4 py-2 bg-[#0f3460] text-white rounded-lg hover:bg-[#0f3460]/80 transition-all text-sm">
                <Download size={16} /> Export CSV
              </button>
              <button onClick={() => setShowDeleteAllConfirm(true)} className="flex items-center gap-2 px-4 py-2 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-all text-sm">
                <Trash size={16} /> Clear All
              </button>
            </>
          )}
        </div>
      </div>

      {/* CSV Import */}
      {showImportCSV && (
        <div className="glass-card p-5">
          <CSVImport onComplete={() => setShowImportCSV(false)} />
        </div>
      )}

      {/* Delete All Confirmation */}
      {showDeleteAllConfirm && (
        <div className="glass-card p-4 border-red-500/30 flex items-center justify-between">
          <p className="text-red-400 text-sm">Are you sure? This will permanently delete all {trades.length} trades.</p>
          <div className="flex gap-2">
            <button onClick={() => setShowDeleteAllConfirm(false)} className="px-3 py-1.5 text-sm rounded-lg border border-[#0f3460] text-gray-400 hover:text-white">Cancel</button>
            <button onClick={handleDeleteAll} className="px-3 py-1.5 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600">Delete All</button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="glass-card p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2 relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search pair, strategy, notes..." className="input-field pl-10 text-sm" />
          </div>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="input-field text-sm">
            <option value="all">All Types</option>
            <option value="long">Long Only</option>
            <option value="short">Short Only</option>
          </select>
          <select value={filterResult} onChange={(e) => setFilterResult(e.target.value)} className="input-field text-sm">
            <option value="all">All Results</option>
            <option value="win">Wins</option>
            <option value="loss">Losses</option>
            <option value="breakeven">Breakeven</option>
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="input-field text-sm">
            <option value="date-desc">Newest First</option>
            <option value="date-asc">Oldest First</option>
            <option value="pnl-desc">Highest P&L</option>
            <option value="pnl-asc">Lowest P&L</option>
            <option value="pair">By Pair</option>
          </select>
        </div>
        <div className="mt-3">
          <select value={filterStrategy} onChange={(e) => {
            if (e.target.value === '__add_custom__') {
              const custom = prompt('Enter custom strategy name:')
              if (custom && custom.trim()) {
                const saved = JSON.parse(localStorage.getItem('vmt_custom_strategies') || '[]')
                if (!saved.includes(custom.trim())) {
                  saved.push(custom.trim())
                  localStorage.setItem('vmt_custom_strategies', JSON.stringify(saved))
                }
                setFilterStrategy(custom.trim())
              }
            } else {
              setFilterStrategy(e.target.value)
            }
          }} className="input-field text-sm">
            <option value="all">All Strategies</option>
            {strategies.map(s => <option key={s} value={s}>{s}</option>)}
            {JSON.parse(localStorage.getItem('vmt_custom_strategies') || '[]')
              .filter(cs => !strategies.includes(cs))
              .map(cs => <option key={`cs-${cs}`} value={cs}>⭐ {cs}</option>)}
            <option value="__add_custom__">➕ Add Custom...</option>
          </select>
        </div>
        {/* Month, Year, Week, Day Filters */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
          <select value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)} className="input-field text-sm">
            <option value="all">All Months</option>
            <option value="0">January</option><option value="1">February</option>
            <option value="2">March</option><option value="3">April</option>
            <option value="4">May</option><option value="5">June</option>
            <option value="6">July</option><option value="7">August</option>
            <option value="8">September</option><option value="9">October</option>
            <option value="10">November</option><option value="11">December</option>
          </select>
          <select value={filterYear} onChange={(e) => setFilterYear(e.target.value)} className="input-field text-sm">
            <option value="all">All Years</option>
            <option value="2024">2024</option><option value="2025">2025</option>
            <option value="2026">2026</option><option value="2027">2027</option>
            <option value="2028">2028</option>
          </select>
          <select value={filterWeek} onChange={(e) => setFilterWeek(e.target.value)} className="input-field text-sm">
            <option value="all">All Weeks</option>
            <option value="1">Week 1</option><option value="2">Week 2</option>
            <option value="3">Week 3</option><option value="4">Week 4</option>
            <option value="5">Week 5</option>
          </select>
          <select value={filterDay} onChange={(e) => setFilterDay(e.target.value)} className="input-field text-sm">
            <option value="all">All Days</option>
            <option value="1">Monday</option><option value="2">Tuesday</option>
            <option value="3">Wednesday</option><option value="4">Thursday</option>
            <option value="5">Friday</option><option value="6">Saturday</option>
            <option value="0">Sunday</option>
          </select>
        </div>
        {/* Session Filter */}
        <div className="mt-3">
          <select value={filterSession} onChange={(e) => {
            if (e.target.value === '__add_custom_session__') {
              const custom = prompt('Enter custom session name:')
              if (custom && custom.trim()) {
                const saved = JSON.parse(localStorage.getItem('vmt_custom_sessions') || '[]')
                if (!saved.includes(custom.trim())) {
                  saved.push(custom.trim())
                  localStorage.setItem('vmt_custom_sessions', JSON.stringify(saved))
                }
                setFilterSession(custom.trim())
              }
            } else {
              setFilterSession(e.target.value)
            }
          }} className="input-field text-sm">
            <option value="all">All Sessions</option>
            <option value="London">London Session</option>
            <option value="New York">New York Session</option>
            <option value="Tokyo">Tokyo Session</option>
            <option value="Sydney">Sydney Session</option>
            <option value="Overlap">Overlap (London/NY)</option>
            <option value="Pre-Market">Pre-Market</option>
            <option value="After Hours">After Hours</option>
            {JSON.parse(localStorage.getItem('vmt_custom_sessions') || '[]').map(cs => (
              <option key={`cs-${cs}`} value={cs}>⭐ {cs}</option>
            ))}
            <option value="__add_custom_session__">➕ Add Custom...</option>
          </select>
        </div>
        {/* From Date - To Date Filter */}
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label className="text-gray-500 text-[10px] uppercase mb-1 block">From Date</label>
            <input type="date" value={filterFromDate} onChange={(e) => setFilterFromDate(e.target.value)} className="input-field text-sm" />
          </div>
          <div>
            <label className="text-gray-500 text-[10px] uppercase mb-1 block">To Date</label>
            <input type="date" value={filterToDate} onChange={(e) => setFilterToDate(e.target.value)} className="input-field text-sm" />
          </div>
        </div>
      </div>
      {filteredTrades.length > 0 && (
        <div className="flex flex-wrap gap-4 text-sm">
          <span className="text-gray-400">
            Showing <span className="text-white font-medium">{filteredTrades.length}</span> of {trades.length} trades
          </span>
          <span className="text-gray-400">•</span>
          <span className={`font-medium ${totalFilteredPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            Total P&L: {totalFilteredPnL >= 0 ? '+' : ''}{formatAmount(totalFilteredPnL)}
          </span>
        </div>
      )}

      {/* Trade Table */}
      <div className="glass-card overflow-hidden">
        {filteredTrades.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-5xl mb-4">📋</div>
            <p className="text-gray-400 text-lg font-medium">No trades found</p>
            <p className="text-gray-500 text-sm mt-1">
              {trades.length === 0 ? 'Start adding trades to see them here' : 'Try adjusting your filters'}
            </p>
            {trades.length === 0 && (
              <Link to="/add-trade" className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-[#e94560]/20 text-[#e94560] rounded-lg hover:bg-[#e94560]/30 transition-colors">
                Add First Trade
              </Link>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#0f3460]/20 border-b border-[#0f3460]/30">
                <tr className="text-gray-400 text-xs uppercase tracking-wider">
                  <th className="text-left py-4 px-4">Date</th>
                  <th className="text-left py-4 px-4">Pair</th>
                  <th className="text-left py-4 px-4">Type</th>
                  <th className="text-left py-4 px-4">Entry</th>
                  <th className="text-left py-4 px-4">Exit</th>
                  <th className="text-left py-4 px-4">Qty</th>
                  <th className="text-left py-4 px-4">P&L</th>
                  <th className="text-left py-4 px-4">Strategy</th>
                  <th className="text-left py-4 px-4">Rating</th>
                  <th className="text-center py-4 px-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#0f3460]/20">
                {filteredTrades.map(trade => (
                  <tr key={trade.id} className="hover:bg-[#0f3460]/10 transition-colors group">
                    <td className="py-3.5 px-4 text-gray-300 text-xs">
                      {new Date(trade.date).toLocaleDateString()}
                      {trade.time && <span className="block text-gray-500">{trade.time}</span>}
                    </td>
                    <td className="py-3.5 px-4 font-medium text-white">{trade.pair}</td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${trade.type === 'long' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                        {trade.type === 'long' ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                        {trade.type.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-gray-300">{symbol}{trade.entryPrice}</td>
                    <td className="py-3.5 px-4 text-gray-300">{symbol}{trade.exitPrice}</td>
                    <td className="py-3.5 px-4 text-gray-300">{trade.quantity}</td>
                    <td className={`py-3.5 px-4 font-semibold ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {trade.pnl >= 0 ? '+' : ''}{formatAmount(trade.pnl)}
                      {trade.pnlPercent && (
                        <span className="block text-xs opacity-70">{trade.pnlPercent >= 0 ? '+' : ''}{trade.pnlPercent}%</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-gray-400 text-xs">{trade.strategy || '-'}</td>
                    <td className="py-3.5 px-4 text-xs">
                      {'⭐'.repeat(trade.rating || 0)}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => setSelectedTrade(trade)} className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-all" title="View">
                          <Eye size={14} />
                        </button>
                        <Link to={`/edit-trade/${trade.id}`} className="p-1.5 text-gray-400 hover:text-yellow-400 hover:bg-yellow-500/10 rounded-lg transition-all" title="Edit">
                          <Edit3 size={14} />
                        </Link>
                        <button onClick={() => handleDelete(trade.id, trade.pair)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all" title="Delete">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Trade Detail Modal */}
      {selectedTrade && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSelectedTrade(null)}>
          <div className="bg-[#1a1a2e] border border-[#0f3460] rounded-2xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-white">{selectedTrade.pair}</h3>
              <button onClick={() => setSelectedTrade(null)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[#0a0a1a] rounded-lg p-3">
                  <p className="text-gray-400 text-xs">Type</p>
                  <p className={`font-medium ${selectedTrade.type === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>{selectedTrade.type.toUpperCase()}</p>
                </div>
                <div className="bg-[#0a0a1a] rounded-lg p-3">
                  <p className="text-gray-400 text-xs">P&L</p>
                  <p className={`font-bold text-lg ${selectedTrade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>${selectedTrade.pnl}</p>
                </div>
                <div className="bg-[#0a0a1a] rounded-lg p-3">
                  <p className="text-gray-400 text-xs">Entry Price</p>
                  <p className="text-white">${selectedTrade.entryPrice}</p>
                </div>
                <div className="bg-[#0a0a1a] rounded-lg p-3">
                  <p className="text-gray-400 text-xs">Exit Price</p>
                  <p className="text-white">${selectedTrade.exitPrice}</p>
                </div>
                <div className="bg-[#0a0a1a] rounded-lg p-3">
                  <p className="text-gray-400 text-xs">Quantity</p>
                  <p className="text-white">{selectedTrade.quantity}</p>
                </div>
                <div className="bg-[#0a0a1a] rounded-lg p-3">
                  <p className="text-gray-400 text-xs">Leverage</p>
                  <p className="text-white">{selectedTrade.leverage || 1}x</p>
                </div>
                <div className="bg-[#0a0a1a] rounded-lg p-3">
                  <p className="text-gray-400 text-xs">Date</p>
                  <p className="text-white">{new Date(selectedTrade.date).toLocaleDateString()}</p>
                </div>
                <div className="bg-[#0a0a1a] rounded-lg p-3">
                  <p className="text-gray-400 text-xs">Strategy</p>
                  <p className="text-white">{selectedTrade.strategy || '-'}</p>
                </div>
                {selectedTrade.timeframe && (
                  <div className="bg-[#0a0a1a] rounded-lg p-3">
                    <p className="text-gray-400 text-xs">Timeframe</p>
                    <p className="text-white">{selectedTrade.timeframe}</p>
                  </div>
                )}
                {selectedTrade.emotion && (
                  <div className="bg-[#0a0a1a] rounded-lg p-3">
                    <p className="text-gray-400 text-xs">Emotion</p>
                    <p className="text-white capitalize">{selectedTrade.emotion}</p>
                  </div>
                )}
              </div>
              {selectedTrade.notes && (
                <div className="bg-[#0a0a1a] rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">Notes</p>
                  <p className="text-gray-300 whitespace-pre-wrap">{selectedTrade.notes}</p>
                </div>
              )}
              {selectedTrade.screenshot && (
                <div>
                  <p className="text-gray-400 text-xs mb-1">Screenshot</p>
                  <img src={selectedTrade.screenshot} alt="Trade screenshot" className="rounded-lg w-full max-h-60 object-cover" />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default TradeHistory
