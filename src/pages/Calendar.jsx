import React, { useState, useMemo } from 'react'
import { useTrades } from '../context/TradeContext'
import { useAuth } from '../context/AuthContext'
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const DAYS_FULL = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const SESSIONS = ['London','New York','Tokyo','Sydney']

function Calendar() {
  const { trades } = useTrades()
  const { user } = useAuth()
  const now = new Date()
  const [currentMonth, setCurrentMonth] = useState(now.getMonth())
  const [currentYear, setCurrentYear] = useState(now.getFullYear())
  const [viewMode, setViewMode] = useState('monthly')
  const [selectedDate, setSelectedDate] = useState(null)
  const [selectedWeek, setSelectedWeek] = useState('all')
  const [selectedDayFilter, setSelectedDayFilter] = useState('all')
  const currency = '₹'

  const getDaysInMonth = (m, y) => new Date(y, m + 1, 0).getDate()
  const getFirstDayOfMonth = (m, y) => new Date(y, m, 1).getDay()
  const daysInMonth = getDaysInMonth(currentMonth, currentYear)
  const firstDay = getFirstDayOfMonth(currentMonth, currentYear)

  // Trades for current month
  const monthTrades = useMemo(() => {
    return trades.filter(t => {
      const d = new Date(t.date)
      return d.getMonth() === currentMonth && d.getFullYear() === currentYear
    })
  }, [trades, currentMonth, currentYear])

  // Trades grouped by date number
  const tradesByDate = useMemo(() => {
    const grouped = {}
    monthTrades.forEach(t => {
      const day = new Date(t.date).getDate()
      if (!grouped[day]) grouped[day] = []
      grouped[day].push(t)
    })
    return grouped
  }, [monthTrades])

  // Weekly data
  const weeklyData = useMemo(() => {
    const weeks = []
    let weekStart = 1
    for (let w = 0; w < 6; w++) {
      const weekEnd = Math.min(weekStart + 6, daysInMonth)
      if (weekStart > daysInMonth) break
      const weekTrades = monthTrades.filter(t => {
        const day = new Date(t.date).getDate()
        return day >= weekStart && day <= weekEnd
      })
      const wins = weekTrades.filter(t => t.pnl > 0).length
      const losses = weekTrades.filter(t => t.pnl < 0).length
      const pnl = weekTrades.reduce((s, t) => s + t.pnl, 0)
      const tradingDays = new Set(weekTrades.map(t => new Date(t.date).getDate())).size
      const greenDays = Object.entries(tradesByDate).filter(([d, ts]) => {
        const dn = parseInt(d)
        return dn >= weekStart && dn <= weekEnd && ts.reduce((s,t)=>s+t.pnl,0) > 0
      }).length
      const redDays = Object.entries(tradesByDate).filter(([d, ts]) => {
        const dn = parseInt(d)
        return dn >= weekStart && dn <= weekEnd && ts.reduce((s,t)=>s+t.pnl,0) < 0
      }).length
      weeks.push({
        label: `Week ${w+1} (${weekStart}-${weekEnd})`,
        trades: weekTrades.length, wins, losses,
        winRate: weekTrades.length > 0 ? ((wins/weekTrades.length)*100).toFixed(0) : '-',
        pnl, tradingDays, greenDays, redDays,
      })
      weekStart = weekEnd + 1
    }
    return weeks
  }, [monthTrades, daysInMonth, tradesByDate])

  // Day-wise P&L (Mon-Sun breakdown)
  const dayWiseData = useMemo(() => {
    return DAYS_FULL.map(dayName => {
      const dayIdx = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].indexOf(dayName)
      const jsDayIdx = dayIdx === 6 ? 0 : dayIdx + 1 // JS: 0=Sun
      const dayTrades = monthTrades.filter(t => new Date(t.date).getDay() === jsDayIdx)
      const wins = dayTrades.filter(t => t.pnl > 0).length
      const losses = dayTrades.filter(t => t.pnl < 0).length
      const pnl = dayTrades.reduce((s, t) => s + t.pnl, 0)
      const avg = dayTrades.length > 0 ? pnl / dayTrades.length : 0
      let status = 'No trades'
      if (dayTrades.length > 0) status = pnl > 0 ? 'Profit' : pnl < 0 ? 'Loss' : 'Breakeven'
      return { day: dayName, trades: dayTrades.length, wins, losses,
        winRate: dayTrades.length > 0 ? ((wins/dayTrades.length)*100).toFixed(0)+'%' : '-',
        pnl, avg, status }
    })
  }, [monthTrades])

  // Daily summary (each date with trades)
  const dailyData = useMemo(() => {
    return Object.entries(tradesByDate).sort((a,b) => parseInt(a[0]) - parseInt(b[0])).map(([day, dayTrades]) => {
      const date = new Date(currentYear, currentMonth, parseInt(day))
      const dayName = DAYS_SHORT[date.getDay()]
      return dayTrades.map(t => ({
        date: `${day}/${currentMonth+1}/${currentYear}`,
        dayName: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()],
        session: t.session || t.timeframe || 'London',
        pair: t.pair,
        type: t.type,
        entry: t.entryPrice, exit: t.exitPrice,
        result: t.pnl > 0 ? 'Profit' : t.pnl < 0 ? 'Loss' : 'Breakeven',
        pnl: t.pnl,
      }))
    }).flat()
  }, [tradesByDate, currentMonth, currentYear])

  // Trade Count data - month-wise for year
  const monthWiseTradeCount = useMemo(() => {
    return MONTHS.map((m, i) => {
      const mTrades = trades.filter(t => {
        const d = new Date(t.date)
        return d.getMonth() === i && d.getFullYear() === currentYear
      })
      const wins = mTrades.filter(t => t.pnl > 0).length
      const losses = mTrades.filter(t => t.pnl < 0).length
      const pnl = mTrades.reduce((s, t) => s + t.pnl, 0)
      return { month: m, trades: mTrades.length, wins, losses,
        winRate: mTrades.length > 0 ? ((wins/mTrades.length)*100).toFixed(0)+'%' : '-',
        pnl }
    }).filter(m => m.trades > 0)
  }, [trades, currentYear])

  // Session-wise data
  const sessionData = useMemo(() => {
    return SESSIONS.map(session => {
      const sTrades = monthTrades.filter(t =>
        (t.session || t.timeframe || 'London').toLowerCase().includes(session.toLowerCase())
      )
      const wins = sTrades.filter(t => t.pnl > 0).length
      const losses = sTrades.filter(t => t.pnl < 0).length
      const pnl = sTrades.reduce((s, t) => s + t.pnl, 0)
      const avg = sTrades.length > 0 ? pnl / sTrades.length : 0
      return { session: session + ' Session', trades: sTrades.length, wins, losses,
        winRate: sTrades.length > 0 ? ((wins/sTrades.length)*100).toFixed(0)+'%' : '-',
        pnl, avg }
    }).filter(s => s.trades > 0)
  }, [monthTrades])

  const sessionYearData = useMemo(() => {
    const yearTrades = trades.filter(t => new Date(t.date).getFullYear() === currentYear)
    return SESSIONS.map(session => {
      const sTrades = yearTrades.filter(t =>
        (t.session || t.timeframe || 'London').toLowerCase().includes(session.toLowerCase())
      )
      const wins = sTrades.filter(t => t.pnl > 0).length
      const losses = sTrades.filter(t => t.pnl < 0).length
      const pnl = sTrades.reduce((s, t) => s + t.pnl, 0)
      const avg = sTrades.length > 0 ? pnl / sTrades.length : 0
      return { session: session + ' Session', trades: sTrades.length, wins, losses,
        winRate: sTrades.length > 0 ? ((wins/sTrades.length)*100).toFixed(0)+'%' : '-',
        pnl, avg }
    }).filter(s => s.trades > 0)
  }, [trades, currentYear])

  // Monthly summary stats
  const monthlyStats = useMemo(() => {
    const wins = monthTrades.filter(t => t.pnl > 0).length
    const losses = monthTrades.filter(t => t.pnl < 0).length
    const pnl = monthTrades.reduce((s, t) => s + t.pnl, 0)
    const tradingDays = new Set(monthTrades.map(t => new Date(t.date).getDate())).size
    const greenDays = Object.values(tradesByDate).filter(ts => ts.reduce((s,t)=>s+t.pnl,0) > 0).length
    const redDays = Object.values(tradesByDate).filter(ts => ts.reduce((s,t)=>s+t.pnl,0) < 0).length
    const avg = monthTrades.length > 0 ? pnl / monthTrades.length : 0
    return { total: monthTrades.length, wins, losses, pnl,
      winRate: monthTrades.length > 0 ? ((wins/monthTrades.length)*100).toFixed(1) : '0',
      tradingDays, greenDays, redDays, avg }
  }, [monthTrades, tradesByDate])

  // Navigation
  const goToPrev = () => { if(currentMonth===0){setCurrentMonth(11);setCurrentYear(currentYear-1)}else setCurrentMonth(currentMonth-1) }
  const goToNext = () => { if(currentMonth===11){setCurrentMonth(0);setCurrentYear(currentYear+1)}else setCurrentMonth(currentMonth+1) }

  // Calendar grid
  const calendarDays = useMemo(() => {
    const days = []
    for (let i = 0; i < firstDay; i++) days.push(null)
    for (let i = 1; i <= daysInMonth; i++) days.push(i)
    return days
  }, [firstDay, daysInMonth])

  // Best/worst day for Day-wise P&L
  const bestDay = dayWiseData.filter(d=>d.trades>0).sort((a,b)=>b.pnl-a.pnl)[0]
  const worstDay = dayWiseData.filter(d=>d.trades>0).sort((a,b)=>a.pnl-b.pnl)[0]

  // Best session
  const bestSession = [...sessionData].sort((a,b)=>b.pnl-a.pnl)[0]

  // ===== BEST/WORST STATS =====
  // Best/Worst Month (all months in year)
  const allMonthsData = useMemo(() => {
    return MONTHS.map((m, i) => {
      const mTrades = trades.filter(t => { const d=new Date(t.date); return d.getMonth()===i && d.getFullYear()===currentYear })
      const pnl = mTrades.reduce((s,t)=>s+t.pnl,0)
      return { month: m, pnl, trades: mTrades.length }
    }).filter(m => m.trades > 0)
  }, [trades, currentYear])

  // Best/Worst Year
  const allYearsData = useMemo(() => {
    const years = [...new Set(trades.map(t => new Date(t.date).getFullYear()))]
    return years.map(y => {
      const yTrades = trades.filter(t => new Date(t.date).getFullYear()===y)
      const pnl = yTrades.reduce((s,t)=>s+t.pnl,0)
      return { year: y, pnl, trades: yTrades.length }
    }).filter(y => y.trades > 0)
  }, [trades])

  // Best Trading Time
  const bestTradingTime = useMemo(() => {
    const hourGroups = {}
    trades.forEach(t => {
      if (t.time) {
        const hour = parseInt(t.time.split(':')[0])
        const slot = `${hour}:00-${hour+1}:00`
        if (!hourGroups[slot]) hourGroups[slot] = { slot, pnl: 0, trades: 0 }
        hourGroups[slot].pnl += t.pnl
        hourGroups[slot].trades++
      }
    })
    const slots = Object.values(hourGroups).filter(s=>s.trades>0)
    return slots.sort((a,b)=>b.pnl-a.pnl)[0] || null
  }, [trades])

  // Best/Worst Day (Mon-Sun)
  const bestDayOfWeek = dayWiseData.filter(d=>d.trades>0).sort((a,b)=>b.pnl-a.pnl)[0]
  const worstDayOfWeek = dayWiseData.filter(d=>d.trades>0).sort((a,b)=>a.pnl-b.pnl)[0]

  // Best/Worst Week
  const bestWeek = weeklyData.filter(w=>w.trades>0).sort((a,b)=>b.pnl-a.pnl)[0]
  const worstWeek = weeklyData.filter(w=>w.trades>0).sort((a,b)=>a.pnl-b.pnl)[0]

  const bestMonth = allMonthsData.length > 0 ? [...allMonthsData].sort((a,b)=>b.pnl-a.pnl)[0] : null
  const worstMonth = allMonthsData.length > 0 ? [...allMonthsData].sort((a,b)=>a.pnl-b.pnl)[0] : null
  const bestYear = allYearsData.length > 0 ? [...allYearsData].sort((a,b)=>b.pnl-a.pnl)[0] : null
  const worstYear = allYearsData.length > 0 ? [...allYearsData].sort((a,b)=>a.pnl-b.pnl)[0] : null

  const viewModes = [
    { id: 'monthly', label: 'Monthly', icon: '📊' },
    { id: 'weekly', label: 'Weekly', icon: '📅' },
    { id: 'daily', label: 'Daily', icon: '📋' },
    { id: 'daywisePnl', label: 'Day-wise P&L', icon: '🚀' },
    { id: 'tradeCount', label: 'Trade Count', icon: '🔢' },
    { id: 'session', label: 'Session', icon: '🕐' },
  ]

  // Totals helper
  const totalRow = (arr, label) => {
    const t = arr.reduce((a,c)=>a+c.trades,0)
    const w = arr.reduce((a,c)=>a+c.wins,0)
    const l = arr.reduce((a,c)=>a+c.losses,0)
    const p = arr.reduce((a,c)=>a+c.pnl,0)
    return { label, trades: t, wins: w, losses: l,
      winRate: t > 0 ? ((w/t)*100).toFixed(0)+'%' : '-', pnl: p }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <CalendarIcon className="text-[#e94560]" /> Trading Calendar
        </h1>
        <div className="px-3 py-1.5 bg-[#f5a623]/20 text-[#f5a623] rounded-lg text-sm font-medium">
          💰 {currency} INR
        </div>
      </div>

      {/* Filters */}
      <div className="glass-card p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 whitespace-nowrap">📅 Month:</span>
            <select value={currentMonth} onChange={(e) => setCurrentMonth(parseInt(e.target.value))}
              className="input-field py-2 text-sm flex-1">
              {MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 whitespace-nowrap">📅 Year:</span>
            <select value={currentYear} onChange={(e) => setCurrentYear(parseInt(e.target.value))}
              className="input-field py-2 text-sm flex-1">
              {[2020,2021,2022,2023,2024,2025,2026,2027,2028,2029,2030].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 whitespace-nowrap">📋 Week:</span>
            <select value={selectedWeek} onChange={(e) => setSelectedWeek(e.target.value)}
              className="input-field py-2 text-sm flex-1">
              <option value="all">All Weeks</option>
              <option value="1">Week 1</option>
              <option value="2">Week 2</option>
              <option value="3">Week 3</option>
              <option value="4">Week 4</option>
              <option value="5">Week 5</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 whitespace-nowrap">🚀 Day:</span>
            <select value={selectedDayFilter} onChange={(e) => setSelectedDayFilter(e.target.value)}
              className="input-field py-2 text-sm flex-1">
              <option value="all">All Days</option>
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
              <option value="0">Sunday</option>
            </select>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button onClick={goToPrev} className="flex items-center gap-1 px-4 py-2.5 bg-[#1a1a2e] border border-[#0f3460] rounded-lg text-gray-300 hover:text-white hover:border-[#e94560] transition-all text-sm font-medium">
          <ChevronLeft size={16}/> Prev
        </button>
        <h2 className="text-xl font-bold text-white">{MONTHS[currentMonth]} {currentYear}</h2>
        <button onClick={goToNext} className="flex items-center gap-1 px-4 py-2.5 bg-[#1a1a2e] border border-[#0f3460] rounded-lg text-gray-300 hover:text-white hover:border-[#e94560] transition-all text-sm font-medium">
          Next <ChevronRight size={16}/>
        </button>
      </div>

      {/* Calendar Grid */}
      <div className="glass-card p-3 overflow-hidden">
        <div className="grid grid-cols-7 mb-1">
          {DAYS_SHORT.map(d => <div key={d} className="text-center text-[10px] font-semibold text-gray-400 py-1.5">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {calendarDays.map((day, idx) => {
            if (!day) return <div key={`e-${idx}`} className="aspect-square"></div>
            const dayTrades = tradesByDate[day]
            const pnl = dayTrades ? dayTrades.reduce((s,t)=>s+t.pnl,0) : null
            const count = dayTrades?.length || 0
            const isToday = day===now.getDate() && currentMonth===now.getMonth() && currentYear===now.getFullYear()

            // Week filter: calculate which week this day belongs to
            const weekOfMonth = Math.ceil((day + firstDay) / 7)
            const matchesWeek = selectedWeek === 'all' || weekOfMonth === parseInt(selectedWeek)

            // Day filter: check day of week (0=Sun, 1=Mon...)
            const dayOfWeek = new Date(currentYear, currentMonth, day).getDay()
            const matchesDay = selectedDayFilter === 'all' || dayOfWeek === parseInt(selectedDayFilter)

            const isFiltered = matchesWeek && matchesDay
            const dimmed = !isFiltered

            return (
              <div key={day} onClick={() => setSelectedDate(day)} className={`aspect-square flex flex-col items-center justify-center rounded-md text-[10px] transition-all cursor-pointer hover:scale-105 hover:shadow-lg ${dimmed ? 'opacity-30' : ''} ${isToday ? 'ring-2 ring-[#e94560] bg-[#e94560]/10' : ''} ${count > 0 ? pnl > 0 ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-red-500/10 border border-red-500/30' : 'border border-[#0f3460]/20 hover:border-[#0f3460]'}`}>
                <span className={`font-medium ${isToday?'text-[#e94560]':'text-gray-300'}`}>{day}</span>
                {count > 0 && <>
                  <span className={`font-bold ${pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{Math.abs(pnl).toFixed(0)}</span>
                  <span className="text-gray-400 text-[8px]">{count} trade{count>1?'s':''}</span>
                </>}
              </div>
            )
          })}
        </div>
      </div>

      {/* View Mode Tabs */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        {viewModes.map(m => (
          <button key={m.id} onClick={() => setViewMode(m.id)}
            className={`flex flex-col items-center gap-0.5 py-2.5 rounded-xl text-xs font-medium transition-all ${viewMode===m.id ? 'bg-[#e94560]/20 text-[#e94560] border border-[#e94560]/40' : 'bg-[#1a1a2e] text-gray-400 border border-[#0f3460] hover:text-white'}`}>
            <span className="text-base">{m.icon}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>

      {/* ===== MONTHLY TAB ===== */}
      {viewMode === 'monthly' && (
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2 text-lg">📊 Monthly Summary</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/30">
              <p className="text-gray-400 text-xs">Monthly P&L</p>
              <p className={`text-xl font-bold mt-1 ${monthlyStats.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{monthlyStats.pnl.toFixed(2)}</p>
            </div>
            <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/30">
              <p className="text-gray-400 text-xs">Total Trades</p>
              <p className="text-xl font-bold mt-1 text-blue-400">{monthlyStats.total}</p>
            </div>
            <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/30">
              <p className="text-gray-400 text-xs">Wins</p>
              <p className="text-xl font-bold mt-1 text-emerald-400">{monthlyStats.wins}</p>
            </div>
            <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/30">
              <p className="text-gray-400 text-xs">Losses</p>
              <p className="text-xl font-bold mt-1 text-red-400">{monthlyStats.losses}</p>
            </div>
            <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/30">
              <p className="text-gray-400 text-xs">Win Rate</p>
              <p className="text-xl font-bold mt-1 text-emerald-400">{monthlyStats.winRate}%</p>
            </div>
            <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/30">
              <p className="text-gray-400 text-xs">Trading Days</p>
              <p className="text-xl font-bold mt-1 text-blue-400">{monthlyStats.tradingDays}</p>
            </div>
            <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/30">
              <p className="text-gray-400 text-xs">Green Days</p>
              <p className="text-xl font-bold mt-1 text-emerald-400">{monthlyStats.greenDays}</p>
            </div>
            <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/30">
              <p className="text-gray-400 text-xs">Red Days</p>
              <p className="text-xl font-bold mt-1 text-red-400">{monthlyStats.redDays}</p>
            </div>
          </div>
          <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/30 mt-4">
            <p className="text-gray-400 text-xs">Avg P&L/Trade</p>
            <p className={`text-xl font-bold mt-1 ${monthlyStats.avg>=0?'text-emerald-400':'text-red-400'}`}>{currency}{monthlyStats.avg.toFixed(2)}</p>
          </div>

          {/* Best / Worst Stats */}
          <div className="mt-6 pt-5 border-t border-[#0f3460]/30 space-y-4">
            <h3 className="text-white font-semibold flex items-center gap-2">📊 Best / Worst Performance</h3>

            {monthTrades.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-4">Add trades to see Best/Worst stats</p>
            ) : (
              <>
            {/* Best Day / Worst Day */}
            {bestDayOfWeek && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-emerald-500/20">
                  <p className="text-gray-400 text-xs">🏆 Best Day</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{bestDayOfWeek.day}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-emerald-500/20">
                  <p className="text-gray-400 text-xs">Best Day P&L</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{currency}{bestDayOfWeek.pnl.toFixed(2)}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-red-500/20">
                  <p className="text-gray-400 text-xs">⚠️ Worst Day</p>
                  <p className="text-red-400 font-bold text-lg mt-1">{worstDayOfWeek?.day || '-'}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-red-500/20">
                  <p className="text-gray-400 text-xs">Worst Day P&L</p>
                  <p className="text-red-400 font-bold text-lg mt-1">{currency}{worstDayOfWeek ? worstDayOfWeek.pnl.toFixed(2) : '0.00'}</p>
                </div>
              </div>
            )}

            {/* Best Week / Worst Week */}
            {bestWeek && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-emerald-500/20">
                  <p className="text-gray-400 text-xs">📅 Best Week</p>
                  <p className="text-emerald-400 font-bold text-sm mt-1">{bestWeek.label}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-emerald-500/20">
                  <p className="text-gray-400 text-xs">Best Week P&L</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{currency}{bestWeek.pnl.toFixed(2)}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-red-500/20">
                  <p className="text-gray-400 text-xs">📅 Worst Week</p>
                  <p className="text-red-400 font-bold text-sm mt-1">{worstWeek?.label || '-'}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-red-500/20">
                  <p className="text-gray-400 text-xs">Worst Week P&L</p>
                  <p className="text-red-400 font-bold text-lg mt-1">{currency}{worstWeek ? worstWeek.pnl.toFixed(2) : '0.00'}</p>
                </div>
              </div>
            )}

            {/* Best Month / Worst Month */}
            {bestMonth && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-emerald-500/20">
                  <p className="text-gray-400 text-xs">📆 Best Month</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{bestMonth.month}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-emerald-500/20">
                  <p className="text-gray-400 text-xs">Best Month P&L</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{currency}{bestMonth.pnl.toFixed(2)}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-red-500/20">
                  <p className="text-gray-400 text-xs">📆 Worst Month</p>
                  <p className="text-red-400 font-bold text-lg mt-1">{worstMonth?.month || '-'}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-red-500/20">
                  <p className="text-gray-400 text-xs">Worst Month P&L</p>
                  <p className="text-red-400 font-bold text-lg mt-1">{currency}{worstMonth ? worstMonth.pnl.toFixed(2) : '0.00'}</p>
                </div>
              </div>
            )}

            {/* Best Year / Worst Year */}
            {bestYear && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-emerald-500/20">
                  <p className="text-gray-400 text-xs">📈 Best Year</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{bestYear.year}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-emerald-500/20">
                  <p className="text-gray-400 text-xs">Best Year P&L</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{currency}{bestYear.pnl.toFixed(2)}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-red-500/20">
                  <p className="text-gray-400 text-xs">📈 Worst Year</p>
                  <p className="text-red-400 font-bold text-lg mt-1">{worstYear?.year || '-'}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-red-500/20">
                  <p className="text-gray-400 text-xs">Worst Year P&L</p>
                  <p className="text-red-400 font-bold text-lg mt-1">{currency}{worstYear ? worstYear.pnl.toFixed(2) : '0.00'}</p>
                </div>
              </div>
            )}

            {/* Best Trading Time */}
            {bestTradingTime && (
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-emerald-500/20">
                  <p className="text-gray-400 text-xs">⏰ Best Trading Time</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{bestTradingTime.slot}</p>
                </div>
                <div className="text-center p-3 bg-[#0a0a1a] rounded-xl border border-emerald-500/20">
                  <p className="text-gray-400 text-xs">Best Time P&L</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{currency}{bestTradingTime.pnl.toFixed(2)}</p>
                </div>
              </div>
            )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ===== WEEKLY TAB ===== */}
      {viewMode === 'weekly' && (
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2 text-lg">📅 Weekly Summary</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs border-b border-[#0f3460]/40">
                  <th className="text-left py-3 px-2">Week</th>
                  <th className="text-center py-3 px-2">Trades</th>
                  <th className="text-center py-3 px-2">Wins</th>
                  <th className="text-center py-3 px-2">Losses</th>
                  <th className="text-center py-3 px-2">Win Rate</th>
                  <th className="text-center py-3 px-2">P&L ({currency})</th>
                  <th className="text-center py-3 px-2">Trading Days</th>
                  <th className="text-center py-3 px-2">Green/Red</th>
                </tr>
              </thead>
              <tbody>
                {weeklyData.map((w, i) => (
                  <tr key={i} className="border-b border-[#0f3460]/20 hover:bg-[#0f3460]/10">
                    <td className="py-3 px-2 text-white font-medium">{w.label}</td>
                    <td className="py-3 px-2 text-center text-gray-300">{w.trades}</td>
                    <td className="py-3 px-2 text-center text-emerald-400 font-medium">{w.wins}</td>
                    <td className="py-3 px-2 text-center text-red-400 font-medium">{w.losses}</td>
                    <td className="py-3 px-2 text-center text-emerald-400">{w.winRate}{w.winRate !== '-' ? '%' : ''}</td>
                    <td className={`py-3 px-2 text-center font-bold ${w.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{w.pnl.toFixed(2)}</td>
                    <td className="py-3 px-2 text-center text-gray-300">{w.tradingDays}</td>
                    <td className="py-3 px-2 text-center">
                      <span className="text-emerald-400">{w.greenDays}G</span> / <span className="text-red-400">{w.redDays}R</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== DAILY TAB ===== */}
      {viewMode === 'daily' && (
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2 text-lg">📋 Daily Summary</h3>
          {dailyData.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-6">No trades this month</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-[#0f3460]/40">
                    <th className="text-left py-3 px-2">Date</th>
                    <th className="text-left py-3 px-2">Day</th>
                    <th className="text-center py-3 px-2">Trades</th>
                    <th className="text-center py-3 px-2">Session</th>
                    <th className="text-center py-3 px-2">Symbol</th>
                    <th className="text-center py-3 px-2">Buy/Sell</th>
                    <th className="text-center py-3 px-2">Entry → Capture</th>
                    <th className="text-center py-3 px-2">Result</th>
                    <th className="text-center py-3 px-2">P&L ({currency})</th>
                    <th className="text-center py-3 px-2">Cumulative</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyData.map((t, i) => {
                    const cumulative = dailyData.slice(0, i+1).reduce((s, x) => s + x.pnl, 0)
                    return (
                      <tr key={i} className="border-b border-[#0f3460]/20 hover:bg-[#0f3460]/10">
                        <td className="py-3 px-2 text-white">{t.date}</td>
                        <td className="py-3 px-2 text-gray-300">{t.dayName}</td>
                        <td className="py-3 px-2 text-center text-gray-300">1</td>
                        <td className="py-3 px-2 text-center text-blue-400">{t.session}</td>
                        <td className="py-3 px-2 text-center text-white font-medium">{t.pair}</td>
                        <td className={`py-3 px-2 text-center font-medium ${t.type==='long'?'text-emerald-400':'text-red-400'}`}>
                          {t.type === 'long' ? 'Buy' : 'Sell'}
                        </td>
                        <td className="py-3 px-2 text-center text-gray-300">${t.entry} → ${t.exit}</td>
                        <td className="py-3 px-2 text-center">
                          <span className={`inline-flex items-center gap-1 ${t.result==='Profit'?'text-emerald-400':'text-red-400'}`}>
                            {t.result==='Profit' ? '☑️' : '❌'} {t.result}
                          </span>
                        </td>
                        <td className={`py-3 px-2 text-center font-bold ${t.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{t.pnl.toFixed(2)}</td>
                        <td className={`py-3 px-2 text-center font-medium ${cumulative>=0?'text-emerald-400':'text-red-400'}`}>{currency}{cumulative.toFixed(2)}</td>
                      </tr>
                    )
                  })}
                  {/* Day Total */}
                  <tr className="border-t-2 border-[#0f3460]">
                    <td colSpan="8" className="py-3 px-2 text-right text-gray-400 font-medium">Day Total:</td>
                    <td className={`py-3 px-2 text-center font-bold ${monthlyStats.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{monthlyStats.pnl.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ===== DAY-WISE P&L TAB ===== */}
      {viewMode === 'daywisePnl' && (
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2 text-lg">🚀 Day-wise P&L (Mon-Sun Breakdown)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs border-b border-[#0f3460]/40">
                  <th className="text-left py-3 px-2">Day</th>
                  <th className="text-center py-3 px-2">Total Trades</th>
                  <th className="text-center py-3 px-2">Wins</th>
                  <th className="text-center py-3 px-2">Losses</th>
                  <th className="text-center py-3 px-2">Win Rate</th>
                  <th className="text-center py-3 px-2">Total P&L ({currency})</th>
                  <th className="text-center py-3 px-2">Avg P&L/Trade ({currency})</th>
                  <th className="text-center py-3 px-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {dayWiseData.map((d, i) => (
                  <tr key={i} className="border-b border-[#0f3460]/20 hover:bg-[#0f3460]/10">
                    <td className="py-3 px-2 text-white font-medium">{d.day}</td>
                    <td className="py-3 px-2 text-center text-gray-300">{d.trades}</td>
                    <td className="py-3 px-2 text-center text-emerald-400 font-medium">{d.wins}</td>
                    <td className="py-3 px-2 text-center text-red-400 font-medium">{d.losses}</td>
                    <td className="py-3 px-2 text-center text-emerald-400">{d.winRate}</td>
                    <td className={`py-3 px-2 text-center font-bold ${d.pnl>0?'text-emerald-400':d.pnl<0?'text-red-400':'text-gray-400'}`}>
                      {d.trades > 0 ? `${currency}${d.pnl.toFixed(2)}` : '-'}
                    </td>
                    <td className={`py-3 px-2 text-center ${d.avg>=0?'text-emerald-400':'text-red-400'}`}>
                      {d.trades > 0 ? `${currency}${d.avg.toFixed(2)}` : '-'}
                    </td>
                    <td className="py-3 px-2 text-center">
                      {d.status === 'Profit' && <span className="text-emerald-400 flex items-center justify-center gap-1">🟢 Profit</span>}
                      {d.status === 'Loss' && <span className="text-red-400 flex items-center justify-center gap-1">🔴 Loss</span>}
                      {d.status === 'No trades' && <span className="text-gray-500 flex items-center justify-center gap-1">⚪ No trades</span>}
                      {d.status === 'Breakeven' && <span className="text-gray-400">⚪ Breakeven</span>}
                    </td>
                  </tr>
                ))}
                {/* TOTAL row */}
                <tr className="border-t-2 border-[#0f3460] bg-[#0f3460]/10 font-bold">
                  <td className="py-3 px-2 text-white">TOTAL</td>
                  <td className="py-3 px-2 text-center text-white">{monthlyStats.total}</td>
                  <td className="py-3 px-2 text-center text-emerald-400">{monthlyStats.wins}</td>
                  <td className="py-3 px-2 text-center text-red-400">{monthlyStats.losses}</td>
                  <td className="py-3 px-2 text-center text-emerald-400">{monthlyStats.winRate}%</td>
                  <td className={`py-3 px-2 text-center ${monthlyStats.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{monthlyStats.pnl.toFixed(2)}</td>
                  <td className="py-3 px-2 text-center">-</td>
                  <td className="py-3 px-2 text-center">-</td>
                </tr>
              </tbody>
            </table>
          </div>
          {/* Best/Worst Day */}
          {bestDay && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-4 border-t border-[#0f3460]/30">
              <div className="text-center">
                <p className="text-gray-400 text-xs">🏆 Best Day</p>
                <p className="text-emerald-400 font-bold text-lg mt-1">{bestDay.day}</p>
              </div>
              <div className="text-center">
                <p className="text-gray-400 text-xs">Best Day P&L</p>
                <p className="text-emerald-400 font-bold text-lg mt-1">{currency}{bestDay.pnl.toFixed(2)}</p>
              </div>
              <div className="text-center">
                <p className="text-gray-400 text-xs">⚠️ Worst Day</p>
                <p className="text-red-400 font-bold text-lg mt-1">{worstDay?.day || '-'}</p>
              </div>
              <div className="text-center">
                <p className="text-gray-400 text-xs">Worst Day P&L</p>
                <p className="text-red-400 font-bold text-lg mt-1">{currency}{worstDay ? worstDay.pnl.toFixed(2) : '0.00'}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== TRADE COUNT TAB ===== */}
      {viewMode === 'tradeCount' && (
        <div className="space-y-6">
          {/* Month-wise Trade Count (Year) */}
          <div className="glass-card p-5">
            <h3 className="text-white font-semibold mb-4 flex items-center gap-2 text-lg">🔢 Month & Week Wise Trade Count</h3>
            <h4 className="text-gray-300 font-medium mb-3 text-sm">📊 Month-wise Trade Count ({currentYear})</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-[#0f3460]/40">
                    <th className="text-left py-3 px-2">Month</th>
                    <th className="text-center py-3 px-2">Total Trades</th>
                    <th className="text-center py-3 px-2">Profit Trades</th>
                    <th className="text-center py-3 px-2">Loss Trades</th>
                    <th className="text-center py-3 px-2">Win Rate</th>
                    <th className="text-center py-3 px-2">Total P&L ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {monthWiseTradeCount.map((m, i) => (
                    <tr key={i} className="border-b border-[#0f3460]/20 hover:bg-[#0f3460]/10">
                      <td className="py-3 px-2 text-blue-400 font-medium">{m.month}</td>
                      <td className="py-3 px-2 text-center text-gray-300">{m.trades}</td>
                      <td className="py-3 px-2 text-center text-emerald-400 font-medium">{m.wins}</td>
                      <td className="py-3 px-2 text-center text-red-400 font-medium">{m.losses}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{m.winRate}</td>
                      <td className={`py-3 px-2 text-center font-bold ${m.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{m.pnl.toFixed(2)}</td>
                    </tr>
                  ))}
                  {(() => { const t = totalRow(monthWiseTradeCount, 'YEAR TOTAL'); return (
                    <tr className="border-t-2 border-[#0f3460] bg-[#0f3460]/10 font-bold">
                      <td className="py-3 px-2 text-white">{t.label}</td>
                      <td className="py-3 px-2 text-center text-white">{t.trades}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{t.wins}</td>
                      <td className="py-3 px-2 text-center text-red-400">{t.losses}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{t.winRate}</td>
                      <td className={`py-3 px-2 text-center ${t.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{t.pnl.toFixed(2)}</td>
                    </tr>
                  )})()}
                </tbody>
              </table>
            </div>
          </div>

          {/* Week-wise Trade Count */}
          <div className="glass-card p-5">
            <h4 className="text-gray-300 font-medium mb-3 text-sm">📅 Week-wise Trade Count ({MONTHS[currentMonth]} {currentYear})</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-[#0f3460]/40">
                    <th className="text-left py-3 px-2">Week</th>
                    <th className="text-center py-3 px-2">Total Trades</th>
                    <th className="text-center py-3 px-2">Profit Trades</th>
                    <th className="text-center py-3 px-2">Loss Trades</th>
                    <th className="text-center py-3 px-2">Win Rate</th>
                    <th className="text-center py-3 px-2">Total P&L ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {weeklyData.map((w, i) => (
                    <tr key={i} className="border-b border-[#0f3460]/20 hover:bg-[#0f3460]/10">
                      <td className="py-3 px-2 text-white font-medium">{w.label}</td>
                      <td className="py-3 px-2 text-center text-gray-300">{w.trades}</td>
                      <td className="py-3 px-2 text-center text-emerald-400 font-medium">{w.wins}</td>
                      <td className="py-3 px-2 text-center text-red-400 font-medium">{w.losses}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{w.winRate}{w.winRate!=='-'?'%':''}</td>
                      <td className={`py-3 px-2 text-center font-bold ${w.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{w.pnl.toFixed(2)}</td>
                    </tr>
                  ))}
                  {(() => { const t = totalRow(weeklyData, 'MONTH TOTAL'); return (
                    <tr className="border-t-2 border-[#0f3460] bg-[#0f3460]/10 font-bold">
                      <td className="py-3 px-2 text-white">{t.label}</td>
                      <td className="py-3 px-2 text-center text-white">{t.trades}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{t.wins}</td>
                      <td className="py-3 px-2 text-center text-red-400">{t.losses}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{t.winRate}</td>
                      <td className={`py-3 px-2 text-center ${t.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{t.pnl.toFixed(2)}</td>
                    </tr>
                  )})()}
                </tbody>
              </table>
            </div>
          </div>

          {/* Day-wise Trade Count */}
          <div className="glass-card p-5">
            <h4 className="text-gray-300 font-medium mb-3 text-sm">🚀 Day-wise Trade Count ({MONTHS[currentMonth]} {currentYear})</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-[#0f3460]/40">
                    <th className="text-left py-3 px-2">Day</th>
                    <th className="text-center py-3 px-2">Total Trades</th>
                    <th className="text-center py-3 px-2">Profit Trades</th>
                    <th className="text-center py-3 px-2">Loss Trades</th>
                    <th className="text-center py-3 px-2">Win Rate</th>
                    <th className="text-center py-3 px-2">Total P&L ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {dayWiseData.map((d, i) => (
                    <tr key={i} className="border-b border-[#0f3460]/20 hover:bg-[#0f3460]/10">
                      <td className="py-3 px-2 text-white font-medium">{d.day}</td>
                      <td className="py-3 px-2 text-center text-gray-300">{d.trades}</td>
                      <td className="py-3 px-2 text-center text-emerald-400 font-medium">{d.wins}</td>
                      <td className="py-3 px-2 text-center text-red-400 font-medium">{d.losses}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{d.trades > 0 ? d.winRate : '-'}</td>
                      <td className={`py-3 px-2 text-center font-bold ${d.pnl>0?'text-emerald-400':d.pnl<0?'text-red-400':'text-gray-400'}`}>
                        {d.trades > 0 ? `${currency}${d.pnl.toFixed(2)}` : '-'}
                      </td>
                    </tr>
                  ))}
                  {(() => { const t = totalRow(dayWiseData, 'TOTAL'); return (
                    <tr className="border-t-2 border-[#0f3460] bg-[#0f3460]/10 font-bold">
                      <td className="py-3 px-2 text-white">{t.label}</td>
                      <td className="py-3 px-2 text-center text-white">{t.trades}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{t.wins}</td>
                      <td className="py-3 px-2 text-center text-red-400">{t.losses}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{t.winRate}</td>
                      <td className={`py-3 px-2 text-center ${t.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{t.pnl.toFixed(2)}</td>
                    </tr>
                  )})()}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===== SESSION TAB ===== */}
      {viewMode === 'session' && (
        <div className="space-y-6">
          <div className="glass-card p-5">
            <h3 className="text-white font-semibold mb-4 flex items-center gap-2 text-lg">🕐 Session-wise Trade Count</h3>

            {/* Monthly Session */}
            <h4 className="text-gray-300 font-medium mb-3 text-sm">🕐 Session-wise Trade Count ({MONTHS[currentMonth]} {currentYear})</h4>
            <div className="overflow-x-auto mb-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-[#0f3460]/40">
                    <th className="text-left py-3 px-2">Session</th>
                    <th className="text-center py-3 px-2">Total Trades</th>
                    <th className="text-center py-3 px-2">Profit Trades</th>
                    <th className="text-center py-3 px-2">Loss Trades</th>
                    <th className="text-center py-3 px-2">Win Rate</th>
                    <th className="text-center py-3 px-2">Total P&L ({currency})</th>
                    <th className="text-center py-3 px-2">Avg P&L ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionData.map((s, i) => (
                    <tr key={i} className="border-b border-[#0f3460]/20 hover:bg-[#0f3460]/10">
                      <td className="py-3 px-2 text-white font-medium">{s.session}</td>
                      <td className="py-3 px-2 text-center text-gray-300">{s.trades}</td>
                      <td className="py-3 px-2 text-center text-emerald-400 font-medium">{s.wins}</td>
                      <td className="py-3 px-2 text-center text-red-400 font-medium">{s.losses}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{s.winRate}</td>
                      <td className={`py-3 px-2 text-center font-bold ${s.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{s.pnl.toFixed(2)}</td>
                      <td className={`py-3 px-2 text-center ${s.avg>=0?'text-emerald-400':'text-red-400'}`}>{currency}{s.avg.toFixed(2)}</td>
                    </tr>
                  ))}
                  {sessionData.length === 0 && (
                    <tr><td colSpan="7" className="py-4 text-center text-gray-500">No session data this month</td></tr>
                  )}
                  {sessionData.length > 0 && (() => {
                    const t = totalRow(sessionData, 'TOTAL')
                    return (
                      <tr className="border-t-2 border-[#0f3460] bg-[#0f3460]/10 font-bold">
                        <td className="py-3 px-2 text-white">{t.label}</td>
                        <td className="py-3 px-2 text-center text-white">{t.trades}</td>
                        <td className="py-3 px-2 text-center text-emerald-400">{t.wins}</td>
                        <td className="py-3 px-2 text-center text-red-400">{t.losses}</td>
                        <td className="py-3 px-2 text-center text-emerald-400">{t.winRate}</td>
                        <td className={`py-3 px-2 text-center ${t.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{t.pnl.toFixed(2)}</td>
                        <td className="py-3 px-2 text-center">-</td>
                      </tr>
                    )
                  })()}
                </tbody>
              </table>
            </div>

            {/* Yearly Session */}
            <h4 className="text-gray-300 font-medium mb-3 text-sm mt-6">📊 Session-wise Trade Count (Year {currentYear})</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-[#0f3460]/40">
                    <th className="text-left py-3 px-2">Session</th>
                    <th className="text-center py-3 px-2">Total Trades</th>
                    <th className="text-center py-3 px-2">Profit Trades</th>
                    <th className="text-center py-3 px-2">Loss Trades</th>
                    <th className="text-center py-3 px-2">Win Rate</th>
                    <th className="text-center py-3 px-2">Total P&L ({currency})</th>
                    <th className="text-center py-3 px-2">Avg P&L ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionYearData.map((s, i) => (
                    <tr key={i} className="border-b border-[#0f3460]/20 hover:bg-[#0f3460]/10">
                      <td className="py-3 px-2 text-white font-medium">{s.session}</td>
                      <td className="py-3 px-2 text-center text-gray-300">{s.trades}</td>
                      <td className="py-3 px-2 text-center text-emerald-400 font-medium">{s.wins}</td>
                      <td className="py-3 px-2 text-center text-red-400 font-medium">{s.losses}</td>
                      <td className="py-3 px-2 text-center text-emerald-400">{s.winRate}</td>
                      <td className={`py-3 px-2 text-center font-bold ${s.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{s.pnl.toFixed(2)}</td>
                      <td className={`py-3 px-2 text-center ${s.avg>=0?'text-emerald-400':'text-red-400'}`}>{currency}{s.avg.toFixed(2)}</td>
                    </tr>
                  ))}
                  {sessionYearData.length > 0 && (() => {
                    const t = totalRow(sessionYearData, 'YEAR TOTAL')
                    return (
                      <tr className="border-t-2 border-[#0f3460] bg-[#0f3460]/10 font-bold">
                        <td className="py-3 px-2 text-white">{t.label}</td>
                        <td className="py-3 px-2 text-center text-white">{t.trades}</td>
                        <td className="py-3 px-2 text-center text-emerald-400">{t.wins}</td>
                        <td className="py-3 px-2 text-center text-red-400">{t.losses}</td>
                        <td className="py-3 px-2 text-center text-emerald-400">{t.winRate}</td>
                        <td className={`py-3 px-2 text-center ${t.pnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{t.pnl.toFixed(2)}</td>
                        <td className="py-3 px-2 text-center">-</td>
                      </tr>
                    )
                  })()}
                </tbody>
              </table>
            </div>

            {/* Best Session */}
            {bestSession && (
              <div className="grid grid-cols-2 gap-4 mt-6 pt-4 border-t border-[#0f3460]/30">
                <div className="text-center">
                  <p className="text-gray-400 text-xs">🏆 Best Session</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{bestSession.session.replace(' Session','')}</p>
                </div>
                <div className="text-center">
                  <p className="text-gray-400 text-xs">Best Session P&L</p>
                  <p className="text-emerald-400 font-bold text-lg mt-1">{currency}{bestSession.pnl.toFixed(2)}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== DATE DETAIL MODAL ===== */}
      {selectedDate && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSelectedDate(null)}>
          <div className="bg-[#1a1a2e] border border-[#0f3460] rounded-2xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-xl font-bold text-white">
                  {selectedDate} {MONTHS[currentMonth]} {currentYear}
                </h3>
                <p className="text-gray-400 text-sm mt-0.5">
                  {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(currentYear, currentMonth, selectedDate).getDay()]}
                </p>
              </div>
              <button onClick={() => setSelectedDate(null)} className="text-gray-400 hover:text-white text-2xl leading-none px-2">×</button>
            </div>

            {/* Date Trades */}
            {tradesByDate[selectedDate] && tradesByDate[selectedDate].length > 0 ? (
              <div className="space-y-4">
                {/* Day Summary */}
                {(() => {
                  const dayTrades = tradesByDate[selectedDate]
                  const dayPnl = dayTrades.reduce((s,t) => s+t.pnl, 0)
                  const dayWins = dayTrades.filter(t => t.pnl > 0).length
                  const dayLosses = dayTrades.filter(t => t.pnl < 0).length
                  return (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                      <div className="text-center p-2.5 bg-[#0a0a1a] rounded-lg border border-[#0f3460]/30">
                        <p className="text-gray-400 text-[10px] uppercase">Trades</p>
                        <p className="text-white font-bold text-lg">{dayTrades.length}</p>
                      </div>
                      <div className="text-center p-2.5 bg-[#0a0a1a] rounded-lg border border-[#0f3460]/30">
                        <p className="text-gray-400 text-[10px] uppercase">Wins</p>
                        <p className="text-emerald-400 font-bold text-lg">{dayWins}</p>
                      </div>
                      <div className="text-center p-2.5 bg-[#0a0a1a] rounded-lg border border-[#0f3460]/30">
                        <p className="text-gray-400 text-[10px] uppercase">Losses</p>
                        <p className="text-red-400 font-bold text-lg">{dayLosses}</p>
                      </div>
                      <div className="text-center p-2.5 bg-[#0a0a1a] rounded-lg border border-[#0f3460]/30">
                        <p className="text-gray-400 text-[10px] uppercase">Day P&L</p>
                        <p className={`font-bold text-lg ${dayPnl>=0?'text-emerald-400':'text-red-400'}`}>{currency}{dayPnl.toFixed(2)}</p>
                      </div>
                    </div>
                  )
                })()}

                {/* Individual Trades */}
                <div className="space-y-3">
                  {tradesByDate[selectedDate].map((trade, idx) => (
                    <div key={trade.id || idx} className={`p-4 rounded-xl border ${trade.pnl >= 0 ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-semibold text-sm">{trade.pair}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${trade.type==='long'?'bg-emerald-500/20 text-emerald-400':'bg-red-500/20 text-red-400'}`}>
                            {trade.type === 'long' ? '📈 BUY' : '📉 SELL'}
                          </span>
                        </div>
                        <span className={`font-bold text-sm ${trade.pnl>=0?'text-emerald-400':'text-red-400'}`}>
                          {trade.pnl >= 0 ? '+' : ''}{currency}{trade.pnl.toFixed(2)}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-gray-500">Entry: </span>
                          <span className="text-gray-300">${trade.entryPrice}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Exit: </span>
                          <span className="text-gray-300">${trade.exitPrice}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Qty: </span>
                          <span className="text-gray-300">{trade.quantity}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Leverage: </span>
                          <span className="text-gray-300">{trade.leverage || 1}x</span>
                        </div>
                        {trade.strategy && (
                          <div>
                            <span className="text-gray-500">Strategy: </span>
                            <span className="text-gray-300">{trade.strategy}</span>
                          </div>
                        )}
                        {trade.session && (
                          <div>
                            <span className="text-gray-500">Session: </span>
                            <span className="text-blue-400">{trade.session}</span>
                          </div>
                        )}
                        {trade.timeframe && (
                          <div>
                            <span className="text-gray-500">Timeframe: </span>
                            <span className="text-gray-300">{trade.timeframe}</span>
                          </div>
                        )}
                        {trade.time && (
                          <div>
                            <span className="text-gray-500">Time: </span>
                            <span className="text-gray-300">{trade.time}</span>
                          </div>
                        )}
                      </div>
                      {trade.notes && (
                        <div className="mt-2 pt-2 border-t border-[#0f3460]/30">
                          <p className="text-gray-400 text-[10px] uppercase mb-0.5">Notes:</p>
                          <p className="text-gray-300 text-xs">{trade.notes}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-4xl mb-3">📭</p>
                <p className="text-gray-400 font-medium">No trades on this date</p>
                <p className="text-gray-500 text-sm mt-1">Add a trade for this day to see data here</p>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  )
}

export default Calendar
