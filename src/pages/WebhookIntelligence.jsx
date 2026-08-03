import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  Activity, AlertTriangle, BarChart3, Bell, CheckCircle2, ChevronDown, ChevronLeft,
  ChevronRight, CircleOff, Clock3, Copy, Database, Download, ExternalLink, Eye,
  FileDown, Gauge, KeyRound, Loader2, LockKeyhole, Plus, RadioTower, RefreshCw,
  RotateCcw, Search, Server, ShieldAlert, ShieldCheck, Trash2, TrendingDown,
  TrendingUp, Volume2, Webhook, X, XCircle, Zap,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts'
import { useAuth } from '../context/AuthContext'
import {
  WEBHOOK_API_BASE_URL, downloadCsv, downloadExcel, printReport,
  webhookIntelligenceService as api,
} from '../services/webhookIntelligenceService'

const TABS = ['Overview', 'Alert History', 'Open Positions', 'Analytics', 'Execution Logs', 'Endpoints', 'Notifications']
const inputClass = 'w-full rounded-lg border border-[#2a2a5a]/70 bg-[#09091a] px-3 py-2.5 text-sm text-gray-100 outline-none transition placeholder:text-gray-600 focus:border-[#e94560] focus:ring-1 focus:ring-[#e94560]/30'
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-[#2a2a5a]/70 bg-[#15152d] px-3 py-2 text-sm font-medium text-gray-200 transition hover:border-[#e94560]/50 hover:text-white focus:outline-none focus:ring-2 focus:ring-[#e94560]/40 disabled:cursor-not-allowed disabled:opacity-50'
const alertColumns = [
  { key: 'receivedTimestamp', label: 'Time' }, { key: 'strategy', label: 'Strategy' },
  { key: 'triggerName', label: 'Signal' }, { key: 'symbol', label: 'Symbol' },
  { key: 'action', label: 'Action' }, { key: 'price', label: 'Price' },
  { key: 'status', label: 'Status' }, { key: 'tradeStatus', label: 'Execution' },
  { key: 'executionLatencyMs', label: 'Latency (ms)' },
  { label: 'P&L', value: row => row?.executionResult?.pnl ?? '' },
]

const numberValue = value => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const number = (value, options = {}) => {
  const parsed = numberValue(value)
  return parsed === null ? 'N/A' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, ...options }).format(parsed)
}
const percent = value => numberValue(value) === null ? 'N/A' : `${number(value)}%`
const money = value => numberValue(value) === null ? 'N/A' : number(value, { style: 'currency', currency: 'USD' })
const time = value => {
  if (!value) return 'N/A'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString()
}
const duration = value => {
  const seconds = numberValue(value)
  if (seconds === null) return 'N/A'
  if (seconds < 60) return `${number(seconds)}s`
  if (seconds < 3600) return `${number(seconds / 60)}m`
  return `${number(seconds / 3600)}h`
}
const array = value => Array.isArray(value) ? value : []
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const safeJson = value => {
  try { return JSON.stringify(value ?? {}, null, 2) } catch { return '[Unable to display value]' }
}
const statusTone = value => {
  const key = String(value || '').toLowerCase()
  if (['healthy', 'connected', 'enabled', 'executed', 'filled', 'completed', 'buy', 'paper', 'active'].includes(key)) return 'emerald'
  if (['failed', 'rejected', 'error', 'sell', 'deleted'].includes(key)) return 'red'
  if (['ignored', 'duplicate', 'skipped', 'memory_fallback', 'idle'].includes(key)) return 'amber'
  if (['execution_blocked', 'adapter_not_configured', 'disabled'].includes(key)) return 'purple'
  return 'blue'
}
const titleCase = value => String(value || 'N/A').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
const aggregateRows = value => Object.entries(record(value)).map(([name, count]) => ({ name, count: numberValue(count) || 0 }))
const eventPnl = event => numberValue(event?.executionResult?.pnl ?? event?.pnl)

function Badge({ children, status }) {
  const tones = {
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    red: 'border-red-500/30 bg-red-500/10 text-red-300',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    purple: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
    blue: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  }
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${tones[statusTone(status ?? children)]}`}>{children ?? 'N/A'}</span>
}
function Panel({ children, className = '' }) { return <section className={`glass-card min-w-0 border border-[#2a2a5a]/40 ${className}`}>{children}</section> }
function MetricCard({ label, value, icon: Icon = Activity, tone = 'text-sky-400', hint }) {
  return <Panel className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[.14em] text-gray-500">{label}</p><p className={`mt-2 truncate text-xl font-bold ${tone}`}>{value}</p>{hint && <p className="mt-1 truncate text-xs text-gray-500">{hint}</p>}</div><Icon className={`shrink-0 ${tone}`} size={19} /></div></Panel>
}
function Empty({ title, detail }) {
  return <div className="flex min-h-[160px] flex-col items-center justify-center px-5 text-center"><CircleOff size={27} className="mb-3 text-gray-600" /><p className="text-sm font-medium text-gray-300">{title}</p><p className="mt-1 max-w-md text-xs text-gray-500">{detail}</p></div>
}
function Skeleton() {
  return <div className="space-y-4" aria-label="Loading webhook intelligence"><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, index) => <div key={index} className="h-24 animate-pulse rounded-2xl bg-[#15152d]" />)}</div><div className="h-72 animate-pulse rounded-2xl bg-[#15152d]" /></div>
}
function Table({ children, minWidth = '900px' }) { return <div className="max-w-full overflow-x-auto"><table style={{ minWidth }} className="w-full text-left text-sm">{children}</table></div> }
function Head({ labels }) { return <thead className="border-b border-[#2a2a5a]/60 bg-[#101026]"><tr>{labels.map(label => <th key={label} className="whitespace-nowrap px-3 py-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</th>)}</tr></thead> }
function Modal({ title, onClose, children, wide = false }) {
  const boxRef = useRef(null)
  const previousFocus = useRef(null)
  useEffect(() => {
    previousFocus.current = document.activeElement
    const box = boxRef.current
    box?.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus()
    const onKey = event => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || !box) return
      const focusable = [...box.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); previousFocus.current?.focus?.() }
  }, [onClose])
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div ref={boxRef} role="dialog" aria-modal="true" aria-label={title} className={`max-h-[92vh] w-full overflow-hidden rounded-2xl border border-[#2a2a5a] bg-[#0d0d20] shadow-2xl ${wide ? 'max-w-5xl' : 'max-w-xl'}`}>
      <header className="flex items-center justify-between border-b border-[#2a2a5a]/60 px-5 py-4"><h2 className="font-semibold text-white">{title}</h2><button aria-label="Close dialog" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-white/5 hover:text-white"><X size={18} /></button></header>
      <div className="max-h-[calc(92vh-65px)] overflow-y-auto p-5">{children}</div>
    </div>
  </div>
}
function ChartPanel({ title, data, type = 'bar', nameKey = 'name', dataKey = 'count', formatter }) {
  return <Panel className="p-4"><h3 className="mb-4 text-sm font-semibold text-white">{title}</h3>{data.length ? <ResponsiveContainer width="100%" height={240}>{type === 'area' ? <AreaChart data={data}><defs><linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#e94560" stopOpacity={0.4} /><stop offset="95%" stopColor="#e94560" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#242440" strokeDasharray="3 3" vertical={false} /><XAxis dataKey={nameKey} stroke="#74748a" tick={{ fontSize: 10 }} minTickGap={28} /><YAxis stroke="#74748a" tick={{ fontSize: 10 }} allowDecimals={false} /><Tooltip formatter={formatter} contentStyle={{ background: '#15152d', border: '1px solid #2a2a5a', borderRadius: 8 }} /><Area type="monotone" dataKey={dataKey} stroke="#e94560" fill="url(#activityFill)" strokeWidth={2} /></AreaChart> : <BarChart data={data}><CartesianGrid stroke="#242440" strokeDasharray="3 3" vertical={false} /><XAxis dataKey={nameKey} stroke="#74748a" tick={{ fontSize: 10 }} minTickGap={15} /><YAxis stroke="#74748a" tick={{ fontSize: 10 }} allowDecimals={false} /><Tooltip formatter={formatter} contentStyle={{ background: '#15152d', border: '1px solid #2a2a5a', borderRadius: 8 }} /><Bar dataKey={dataKey} fill="#e94560" radius={[5, 5, 0, 0]} /></BarChart>}</ResponsiveContainer> : <Empty title="No activity recorded" detail="This chart will populate from server aggregates as webhook alerts arrive." />}</Panel>
}
function dateRange(preset, customStart, customEnd) {
  const now = new Date()
  const start = new Date(now)
  const end = new Date(now)
  if (preset === 'custom') return {
    start: customStart ? new Date(`${customStart}T00:00:00`).toISOString() : '',
    end: customEnd ? new Date(`${customEnd}T23:59:59.999`).toISOString() : '',
  }
  start.setHours(0, 0, 0, 0)
  if (preset === 'yesterday') { start.setDate(start.getDate() - 1); end.setTime(start.getTime()); end.setHours(23, 59, 59, 999) }
  if (preset === '7d') start.setDate(start.getDate() - 6)
  if (preset === '30d') start.setDate(start.getDate() - 29)
  return { start: start.toISOString(), end: end.toISOString() }
}

function Overview({ overview, health, events }) {
  const metrics = record(overview.metrics)
  const trade = record(overview.tradeMetrics)
  const aggregates = record(overview.aggregates)
  const newest = events[0]?.receivedTimestamp
  const age = newest ? Date.now() - new Date(newest).getTime() : null
  const tradingViewStatus = age !== null && age <= 300000 ? 'active' : newest ? 'idle' : 'no activity'
  const hourly = aggregateRows(aggregates.perHour).sort((a, b) => a.name.localeCompare(b.name)).map(item => ({ ...item, name: item.name.slice(5, 16).replace('T', ' ') }))
  const strategies = aggregateRows(aggregates.perStrategy).sort((a, b) => b.count - a.count).slice(0, 12)
  const symbols = aggregateRows(aggregates.perSymbol).sort((a, b) => b.count - a.count).slice(0, 12)
  const cards = [
    ['Total alerts', metrics.total, RadioTower, 'text-sky-400'], ['Buy', metrics.buy, TrendingUp, 'text-emerald-400'],
    ['Sell', metrics.sell, TrendingDown, 'text-red-400'], ['Executed', metrics.executed, CheckCircle2, 'text-emerald-400'],
    ['Failed', metrics.failed, XCircle, 'text-red-400'], ['Duplicate', metrics.duplicate, Copy, 'text-amber-400'],
    ['Ignored', metrics.ignored, CircleOff, 'text-amber-400'], ['Win rate', percent(metrics.winRate), TrendingUp, 'text-emerald-400'],
    ['Loss rate', percent(metrics.lossRate), TrendingDown, 'text-red-400'], ['Avg execution', `${number(metrics.averageExecutionMs)} ms`, Zap, 'text-purple-400'],
    ['Avg latency', `${number(metrics.averageLatencyMs)} ms`, Gauge, 'text-cyan-400'], ['Connected webhooks', number(metrics.connectedEndpoints), Webhook, 'text-orange-400'],
  ]
  const healthRows = [
    ['Server', health.server?.status || overview.statuses?.server, Server],
    ['Database', health.database?.status || overview.statuses?.database, Database],
    ['Connected exchange', health.exchange?.status || overview.statuses?.exchange, Zap],
    ['Live safety', health.liveSafety?.status || overview.statuses?.liveSafety, ShieldCheck],
    ['TradingView activity', tradingViewStatus, RadioTower],
  ]
  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{cards.map(([label, value, icon, tone]) => <MetricCard key={label} label={label} value={numberValue(value) !== null && !String(value).includes('ms') ? number(value) : value ?? 'N/A'} icon={icon} tone={tone} />)}</div>
    <div className="grid gap-4 lg:grid-cols-4">{healthRows.map(([label, status, Icon]) => <Panel key={label} className="p-4"><div className="flex items-center justify-between"><div><p className="text-xs text-gray-500">{label}</p><div className="mt-2"><Badge status={status}>{titleCase(status)}</Badge></div></div><Icon size={21} className={statusTone(status) === 'emerald' ? 'text-emerald-400' : statusTone(status) === 'red' ? 'text-red-400' : 'text-amber-400'} /></div></Panel>)}</div>
    <div className="grid gap-4 xl:grid-cols-2"><ChartPanel title="Alerts by hour" data={hourly} type="area" /><Panel className="p-4"><h3 className="mb-3 text-sm font-semibold text-white">Recent alert timeline</h3>{events.length ? <ol className="space-y-1">{events.slice(0, 8).map(event => <li key={event.id} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-white/[.03]"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusTone(event.status) === 'emerald' ? 'bg-emerald-400' : statusTone(event.status) === 'red' ? 'bg-red-400' : 'bg-amber-400'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-gray-200">{event.strategy || 'Unspecified'}</span><Badge status={event.action}>{titleCase(event.action)}</Badge><span className="text-xs text-gray-500">{event.symbol || 'Unknown'}</span></div><p className="mt-1 text-xs text-gray-500">{time(event.receivedTimestamp)} · {titleCase(event.status)}</p></div></li>)}</ol> : <Empty title="No alerts yet" detail="Validated TradingView webhook activity will appear here." />}</Panel></div>
    <div className="grid gap-4 xl:grid-cols-2"><ChartPanel title="Activity by strategy" data={strategies} /><ChartPanel title="Activity by symbol" data={symbols} /></div>
    {trade.closedTrades === 0 && <p className="text-xs text-gray-600">Win/loss metrics remain zero until closed trades with P&amp;L are recorded.</p>}
  </div>
}

function EventDetail({ selected, detail, loading }) {
  if (loading) return <div className="flex justify-center py-16"><Loader2 className="animate-spin text-[#e94560]" /></div>
  const event = record(detail?.event || selected)
  const fields = [
    ['Event ID', event.id], ['Alert ID', event.alertId], ['UUID', event.uuid], ['Strategy', event.strategy], ['Strategy version', event.strategyVersion],
    ['Symbol', event.symbol], ['Exchange', event.exchange], ['Market type', event.marketType], ['Spot / futures', event.spotFutures], ['Timeframe', event.timeframe],
    ['Action', event.action], ['Action type', event.actionType], ['Direction', event.direction], ['Price', event.price], ['Entry price', event.entryPrice],
    ['Exit price', event.exitPrice], ['Stop loss', event.stopLoss], ['Take profit', event.takeProfit], ['Risk %', event.riskPercent], ['Risk amount', event.riskAmount],
    ['Size', event.size], ['Quantity', event.quantity], ['Leverage', event.leverage], ['Order type', event.orderType], ['Trigger', event.triggerName],
    ['Trigger detection', event.triggerDetection], ['Trigger time', time(event.triggerTimestamp)], ['Received time', time(event.receivedTimestamp)], ['Execution time', time(event.executionTimestamp)],
    ['Receive latency', numberValue(event.receiveLatencyMs) === null ? 'N/A' : `${number(event.receiveLatencyMs)} ms`], ['Execution latency', numberValue(event.executionLatencyMs) === null ? 'N/A' : `${number(event.executionLatencyMs)} ms`],
    ['Status', event.status], ['Trade status', event.tradeStatus], ['Mode', event.mode], ['Endpoint', event.endpointName], ['Endpoint ID', event.endpointId],
    ['Source IP', event.sourceIp], ['Request ID', event.requestId], ['Message', event.message],
  ]
  const stages = array(event.timeline).length ? array(event.timeline) : array(detail?.executions).flatMap(item => array(item.stages))
  return <div className="space-y-5">
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{fields.map(([label, value]) => <div key={label} className="rounded-lg border border-[#252547] bg-[#0a0a19] p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-gray-600">{label}</p><p className="mt-1 break-words text-sm text-gray-200">{value === null || value === undefined || value === '' ? 'N/A' : String(value)}</p></div>)}</div>
    <div><h3 className="mb-3 text-sm font-semibold text-white">Processing timeline</h3>{stages.length ? <ol className="space-y-2">{stages.map((stage, index) => <li key={`${stage.sequence || index}-${stage.stage}`} className="flex gap-3 rounded-lg bg-[#101025] p-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#e94560]/15 text-xs text-[#e94560]">{stage.sequence || index + 1}</span><div><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-gray-200">{titleCase(stage.stage)}</span><Badge status={stage.status}>{titleCase(stage.status)}</Badge></div><p className="mt-1 text-xs text-gray-500">{time(stage.timestamp)}{stage.detail ? ` · ${stage.detail}` : ''}</p></div></li>)}</ol> : <p className="text-sm text-gray-500">No execution stages recorded.</p>}</div>
    {!!array(detail?.executions).length && <div><h3 className="mb-2 text-sm font-semibold text-white">Execution records</h3><pre className="max-h-72 overflow-auto rounded-xl border border-[#252547] bg-black/30 p-4 text-xs text-gray-300">{safeJson(detail.executions)}</pre></div>}
    {!!array(detail?.errors).length && <div><h3 className="mb-2 text-sm font-semibold text-red-300">Errors</h3><pre className="max-h-72 overflow-auto rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-200">{safeJson(detail.errors)}</pre></div>}
    <div className="grid gap-4 lg:grid-cols-2"><div><h3 className="mb-2 text-sm font-semibold text-white">Raw payload</h3><pre className="max-h-80 overflow-auto rounded-xl border border-[#252547] bg-black/30 p-4 text-xs text-gray-300">{safeJson(event.rawPayload)}</pre></div><div><h3 className="mb-2 text-sm font-semibold text-white">Pine variables</h3><pre className="max-h-80 overflow-auto rounded-xl border border-[#252547] bg-black/30 p-4 text-xs text-gray-300">{safeJson(event.pineVariables)}</pre></div></div>
  </div>
}

function History({ events, options, loadHistory, loading, refreshVersion }) {
  const [filters, setFilters] = useState({ preset: 'today', customStart: '', customEnd: '', search: '', strategy: '', symbol: '', action: '', status: '' })
  const [page, setPage] = useState(1)
  const [result, setResult] = useState({ events: [], total: 0, limit: 25, hasMore: false })
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const query = useMemo(() => ({ page, limit: 25, ...dateRange(filters.preset, filters.customStart, filters.customEnd), search: filters.search, strategy: filters.strategy, symbol: filters.symbol, action: filters.action, status: filters.status }), [filters, page])
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => loadHistory(query).then(data => active && setResult(data)).catch(error => active && toast.error(error.message)), 250)
    return () => { active = false; clearTimeout(timer) }
  }, [loadHistory, query, refreshVersion])
  const update = (key, value) => { setFilters(previous => ({ ...previous, [key]: value })); setPage(1) }
  const open = async event => {
    setSelected(event); setDetail(null); setDetailLoading(true)
    try { setDetail(await api.eventDetail(event.id)) } catch (error) { toast.error(error.message) } finally { setDetailLoading(false) }
  }
  const rows = array(result.events)
  const filename = `webhook-alerts-${new Date().toISOString().slice(0, 10)}`
  const exportHint = () => rows.length ? true : (toast.error('No loaded filtered rows to export.'), false)
  return <div className="space-y-4">
    <Panel className="p-4"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
      <select aria-label="Date preset" className={inputClass} value={filters.preset} onChange={event => update('preset', event.target.value)}><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="custom">Custom</option></select>
      <label className="relative sm:col-span-2"><Search size={15} className="absolute left-3 top-3 text-gray-600" /><input aria-label="Search alerts" className={`${inputClass} pl-9`} placeholder="Search alerts" value={filters.search} onChange={event => update('search', event.target.value)} /></label>
      <select aria-label="Strategy filter" className={inputClass} value={filters.strategy} onChange={event => update('strategy', event.target.value)}><option value="">All strategies</option>{options.strategies.map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Symbol filter" className={inputClass} value={filters.symbol} onChange={event => update('symbol', event.target.value)}><option value="">All symbols</option>{options.symbols.map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Action filter" className={inputClass} value={filters.action} onChange={event => update('action', event.target.value)}><option value="">All actions</option>{options.actions.map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Status filter" className={inputClass} value={filters.status} onChange={event => update('status', event.target.value)}><option value="">All statuses</option>{options.statuses.map(value => <option key={value}>{value}</option>)}</select>
      <button className={buttonClass} onClick={() => { setFilters({ preset: 'today', customStart: '', customEnd: '', search: '', strategy: '', symbol: '', action: '', status: '' }); setPage(1) }}><RotateCcw size={15} /> Reset</button>
    </div>{filters.preset === 'custom' && <div className="mt-3 grid max-w-xl grid-cols-2 gap-3"><input aria-label="Custom start date" type="date" className={inputClass} value={filters.customStart} onChange={event => update('customStart', event.target.value)} /><input aria-label="Custom end date" type="date" className={inputClass} value={filters.customEnd} onChange={event => update('customEnd', event.target.value)} /></div>}</Panel>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-gray-500">{number(result.total)} matching alerts · exports include this loaded page</p><div className="flex flex-wrap gap-2"><button className={buttonClass} onClick={() => exportHint() && downloadCsv(rows, alertColumns, `${filename}.csv`)}><Download size={15} /> CSV</button><button className={buttonClass} onClick={() => exportHint() && downloadExcel(rows, alertColumns, `${filename}.xls`)}><FileDown size={15} /> XLS</button><button className={buttonClass} onClick={() => exportHint() && printReport(rows, alertColumns, { title: 'Webhook Alert History', subtitle: 'Loaded filtered page' })}><ExternalLink size={15} /> Print / PDF</button></div></div>
    <Panel className="overflow-hidden">{loading && !rows.length ? <div className="p-8 text-center"><Loader2 className="mx-auto animate-spin text-[#e94560]" /></div> : rows.length ? <Table minWidth="1200px"><Head labels={['Time', 'Strategy', 'Signal', 'Symbol', 'Action', 'Price', 'Status', 'Execution', 'Latency', 'P&L']} /><tbody className="divide-y divide-[#242440]/60">{rows.map(event => <tr key={event.id} tabIndex={0} role="button" aria-label={`Open alert ${event.id}`} onClick={() => open(event)} onKeyDown={key => (key.key === 'Enter' || key.key === ' ') && open(event)} className="cursor-pointer transition hover:bg-white/[.035] focus:bg-white/[.05] focus:outline-none"><td className="whitespace-nowrap px-3 py-3 text-xs text-gray-400">{time(event.receivedTimestamp)}</td><td className="px-3 py-3 font-medium text-gray-200">{event.strategy || 'N/A'}</td><td className="px-3 py-3 text-gray-400">{event.triggerName || 'N/A'}</td><td className="px-3 py-3 text-gray-300">{event.symbol || 'N/A'}</td><td className="px-3 py-3"><Badge status={event.action}>{titleCase(event.action)}</Badge></td><td className="px-3 py-3 text-gray-300">{number(event.price)}</td><td className="px-3 py-3"><Badge status={event.status}>{titleCase(event.status)}</Badge></td><td className="px-3 py-3 text-gray-400">{titleCase(event.tradeStatus)}</td><td className="px-3 py-3 text-gray-400">{numberValue(event.executionLatencyMs) === null ? 'N/A' : `${number(event.executionLatencyMs)} ms`}</td><td className={`px-3 py-3 font-medium ${(eventPnl(event) || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{eventPnl(event) === null ? 'N/A' : money(eventPnl(event))}</td></tr>)}</tbody></Table> : <Empty title="No matching alerts" detail="Change the filters or wait for TradingView webhook activity." />}</Panel>
    <div className="flex items-center justify-end gap-2"><button className={buttonClass} disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={15} /> Previous</button><span className="px-2 text-sm text-gray-400">Page {page}</span><button className={buttonClass} disabled={!result.hasMore} onClick={() => setPage(value => value + 1)}>Next <ChevronRight size={15} /></button></div>
    {selected && <Modal wide title="Alert detail" onClose={() => setSelected(null)}><EventDetail selected={selected} detail={detail} loading={detailLoading} /></Modal>}
  </div>
}

function OpenPositions({ positions }) {
  const rows = array(positions)
  const longCount = rows.filter(position => position.direction === 'long').length
  const shortCount = rows.filter(position => position.direction === 'short').length
  const notional = rows.reduce((sum, position) => sum + (numberValue(position.positionValue) || 0), 0)
  const margin = rows.reduce((sum, position) => sum + (numberValue(position.margin) || 0), 0)
  const cards = [
    ['Open paper positions', rows.length, Activity, 'text-sky-400'],
    ['Long / BUY', longCount, TrendingUp, 'text-emerald-400'],
    ['Short / SELL', shortCount, TrendingDown, 'text-red-400'],
    ['Position value', money(notional), BarChart3, 'text-purple-400'],
    ['Margin used', money(margin), Gauge, 'text-amber-400'],
  ]
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">{cards.map(([label, value, icon, tone]) => <MetricCard key={label} label={label} value={value} icon={icon} tone={tone} />)}</div>
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2a2a5a]/60 p-4"><div><h2 className="text-sm font-semibold text-white">Open TradingView paper positions</h2><p className="mt-1 text-xs text-gray-500">BUY opens a long and SELL opens a short. Send exit_long or exit_short to close a position and record P&amp;L.</p></div><Badge status={rows.length ? 'active' : 'idle'}>{rows.length ? `${rows.length} Open` : 'No open positions'}</Badge></div>
      {rows.length ? <Table minWidth="1180px"><Head labels={['Symbol', 'Direction', 'Strategy', 'Entry', 'Quantity', 'Leverage', 'Position value', 'Margin', 'Stop loss', 'Take profit', 'Opened', 'Trade ID']} /><tbody>{rows.map(position => <tr key={position.id} className="border-b border-[#242440]/50"><td className="px-3 py-3 font-semibold text-gray-200">{position.symbol || 'Unknown'}</td><td className="px-3 py-3"><Badge status={position.side}>{titleCase(position.direction || position.side)}</Badge></td><td className="px-3 py-3 text-gray-300">{position.strategy || 'Unspecified'}</td><td className="px-3 py-3 text-gray-300">{money(position.entryPrice)}</td><td className="px-3 py-3 text-gray-400">{number(position.quantity)}</td><td className="px-3 py-3 text-gray-400">{number(position.leverage)}×</td><td className="px-3 py-3 text-gray-300">{money(position.positionValue)}</td><td className="px-3 py-3 text-gray-400">{money(position.margin)}</td><td className="px-3 py-3 text-gray-400">{number(position.stopLoss)}</td><td className="px-3 py-3 text-gray-400">{number(position.takeProfit)}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-gray-500">{time(position.openedAt)}</td><td className="max-w-48 break-all px-3 py-3 font-mono text-[10px] text-gray-600">{position.id || 'N/A'}</td></tr>)}</tbody></Table> : <Empty title="No open paper positions" detail="When an executed BUY or SELL webhook is received, the position will appear here automatically." />}
    </Panel>
    <p className="text-xs text-gray-600">Prices are the values supplied by TradingView when the entry webhook fired. Unrealized P&amp;L requires a live market-price feed and is not calculated here.</p>
  </div>
}

function Analytics({ overview, events, positions, onViewPositions }) {
  const trade = record(overview.tradeMetrics)
  const aggregates = record(overview.aggregates)
  const pnlEvents = events.filter(event => eventPnl(event) !== null)
  const ranked = [...pnlEvents].sort((a, b) => eventPnl(b) - eventPnl(a))
  const latencyEvents = events.filter(event => numberValue(event.executionLatencyMs) !== null).sort((a, b) => Number(a.executionLatencyMs) - Number(b.executionLatencyMs))
  const strategies = aggregateRows(aggregates.perStrategy).sort((a, b) => b.count - a.count)
  const symbols = aggregateRows(aggregates.perSymbol).sort((a, b) => b.count - a.count)
  const cards = [
    ['Closed trades', trade.closedTrades, Activity], ['Wins', trade.wins, TrendingUp], ['Losses', trade.losses, TrendingDown],
    ['Win rate', percent(trade.winRate), Gauge], ['Loss rate', percent(trade.lossRate), Gauge], ['Gross profit', money(trade.grossProfit), TrendingUp],
    ['Gross loss', money(trade.grossLoss), TrendingDown], ['Net profit', money(trade.netProfit), BarChart3],
    ['Profit factor', trade.profitFactor === 'infinity' ? '∞' : number(trade.profitFactor), Zap], ['Avg holding', duration(trade.averageHoldingSeconds), Clock3],
    ['Max drawdown', money(trade.maxDrawdown), TrendingDown], ['Current streak', number(trade.currentStreak), Activity],
    ['Longest win streak', number(trade.longestWinStreak), TrendingUp], ['Longest loss streak', number(trade.longestLossStreak), TrendingDown], ['Average RR', 'N/A', Gauge],
  ]
  return <div className="space-y-5">
    {array(positions).length > 0 && <Panel className="flex flex-wrap items-center justify-between gap-4 border-sky-500/25 bg-sky-500/5 p-4"><div className="flex items-start gap-3"><Activity className="mt-0.5 shrink-0 text-sky-400" size={20} /><div><p className="text-sm font-semibold text-sky-100">{array(positions).length} paper position{array(positions).length === 1 ? '' : 's'} currently open</p><p className="mt-1 text-xs text-gray-500">The BUY/SELL webhook was executed. Closed-trade analytics will update after an exit_long or exit_short signal.</p></div></div><button className={buttonClass} onClick={onViewPositions}>View Open Positions</button></Panel>}
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">{cards.map(([label, value, icon]) => <MetricCard key={label} label={label} value={numberValue(value) !== null ? number(value) : value} icon={icon} tone={label.includes('Loss') || label.includes('drawdown') ? 'text-red-400' : label.includes('Win') || label.includes('profit') ? 'text-emerald-400' : 'text-sky-400'} />)}</div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Best loaded P&L" value={ranked.length ? `${ranked[0].symbol || 'Unknown'} · ${money(eventPnl(ranked[0]))}` : 'N/A'} icon={TrendingUp} tone="text-emerald-400" hint="Only events with recorded P&L" /><MetricCard label="Worst loaded P&L" value={ranked.length ? `${ranked.at(-1).symbol || 'Unknown'} · ${money(eventPnl(ranked.at(-1)))}` : 'N/A'} icon={TrendingDown} tone="text-red-400" hint="Only events with recorded P&L" /><MetricCard label="Fastest execution" value={latencyEvents.length ? `${number(latencyEvents[0].executionLatencyMs)} ms` : 'N/A'} icon={Zap} tone="text-cyan-400" /><MetricCard label="Slowest execution" value={latencyEvents.length ? `${number(latencyEvents.at(-1).executionLatencyMs)} ms` : 'N/A'} icon={Clock3} tone="text-amber-400" /></div>
    <div className="grid gap-4 xl:grid-cols-2"><ChartPanel title="Strategy activity" data={strategies.slice(0, 15)} /><ChartPanel title="Symbol activity" data={symbols.slice(0, 15)} /></div>
    <div className="grid gap-4 xl:grid-cols-2"><Panel className="overflow-hidden"><div className="border-b border-[#2a2a5a]/60 p-4"><h3 className="text-sm font-semibold">Most active strategies</h3></div>{strategies.length ? <Table minWidth="420px"><Head labels={['Rank', 'Strategy', 'Alerts']} /><tbody>{strategies.slice(0, 10).map((item, index) => <tr key={item.name} className="border-b border-[#242440]/50"><td className="px-3 py-3 text-gray-500">{index + 1}</td><td className="px-3 py-3 text-gray-200">{item.name}</td><td className="px-3 py-3 text-gray-400">{number(item.count)}</td></tr>)}</tbody></Table> : <Empty title="No strategy data" detail="No server aggregate is available." />}</Panel><Panel className="overflow-hidden"><div className="border-b border-[#2a2a5a]/60 p-4"><h3 className="text-sm font-semibold">Most active symbols</h3></div>{symbols.length ? <Table minWidth="420px"><Head labels={['Rank', 'Symbol', 'Alerts']} /><tbody>{symbols.slice(0, 10).map((item, index) => <tr key={item.name} className="border-b border-[#242440]/50"><td className="px-3 py-3 text-gray-500">{index + 1}</td><td className="px-3 py-3 text-gray-200">{item.name}</td><td className="px-3 py-3 text-gray-400">{number(item.count)}</td></tr>)}</tbody></Table> : <Empty title="No symbol data" detail="No server aggregate is available." />}</Panel></div>
    <p className="text-xs text-gray-600">Best/worst values use the loaded event sample only. Average RR is unavailable because the API does not return a completed-trade reward/risk aggregate.</p>
  </div>
}

function Logs({ executions, errors }) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [expanded, setExpanded] = useState(null)
  const needle = search.trim().toLowerCase()
  const filtered = executions.filter(item => (!status || item.status === status) && (!needle || [item.id, item.eventId, item.endpointId, item.status].some(value => String(value || '').toLowerCase().includes(needle))))
  const filteredErrors = errors.filter(item => !needle || [item.code, item.message, item.eventId, item.endpointId, item.requestId].some(value => String(value || '').toLowerCase().includes(needle)))
  const statuses = [...new Set(executions.map(item => item.status).filter(Boolean))].sort()
  return <div className="space-y-5">
    <Panel className="p-4"><div className="grid gap-3 sm:grid-cols-2"><label className="relative"><Search size={15} className="absolute left-3 top-3 text-gray-600" /><input aria-label="Search logs" className={`${inputClass} pl-9`} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search event, endpoint, error" /></label><select aria-label="Execution status" className={inputClass} value={status} onChange={event => setStatus(event.target.value)}><option value="">All execution statuses</option>{statuses.map(value => <option key={value}>{value}</option>)}</select></div></Panel>
    <Panel className="overflow-hidden"><div className="flex items-center justify-between border-b border-[#2a2a5a]/60 p-4"><h3 className="text-sm font-semibold">Execution records</h3><span className="text-xs text-gray-500">{filtered.length} loaded</span></div>{filtered.length ? <div className="divide-y divide-[#242440]/60">{filtered.map(item => <div key={item.id}><button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[.03]" aria-expanded={expanded === item.id} onClick={() => setExpanded(value => value === item.id ? null : item.id)}><ChevronDown size={16} className={`shrink-0 text-gray-500 transition ${expanded === item.id ? 'rotate-180' : ''}`} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-gray-200">Event {item.eventId || 'N/A'}</span><span className="text-xs text-gray-500">{time(item.createdAt)} · Endpoint {item.endpointId || 'N/A'}</span></span><Badge status={item.status}>{titleCase(item.status)}</Badge></button>{expanded === item.id && <div className="border-t border-[#242440]/50 bg-black/10 p-4"><ol className="space-y-2">{array(item.stages).map((stage, index) => <li key={`${stage.stage}-${index}`} className="flex items-start gap-3"><span className="mt-1 h-2 w-2 rounded-full bg-[#e94560]" /><div><p className="text-sm text-gray-300">{index + 1}. {titleCase(stage.stage)} <Badge status={stage.status}>{titleCase(stage.status)}</Badge></p><p className="mt-1 text-xs text-gray-500">{time(stage.timestamp)}{stage.detail ? ` · ${stage.detail}` : ''}</p></div></li>)}</ol>{Object.keys(record(item.details)).length > 0 && <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-black/30 p-3 text-xs text-gray-400">{safeJson(item.details)}</pre>}</div>}</div>)}</div> : <Empty title="No execution logs" detail="No loaded records match these filters." />}</Panel>
    <Panel className="overflow-hidden"><div className="flex items-center justify-between border-b border-[#2a2a5a]/60 p-4"><h3 className="text-sm font-semibold text-red-300">Errors</h3><span className="text-xs text-gray-500">{filteredErrors.length} loaded</span></div>{filteredErrors.length ? <Table minWidth="1050px"><Head labels={['Code', 'Message', 'HTTP', 'Event', 'Endpoint', 'Request', 'Time']} /><tbody>{filteredErrors.map(item => <tr key={item.id} className="border-b border-[#242440]/50"><td className="px-3 py-3"><Badge status="error">{item.code || 'N/A'}</Badge></td><td className="max-w-sm px-3 py-3 text-gray-300">{item.message || 'N/A'}</td><td className="px-3 py-3 text-gray-400">{item.httpStatus ?? 'N/A'}</td><td className="px-3 py-3 text-xs text-gray-500">{item.eventId || 'N/A'}</td><td className="px-3 py-3 text-xs text-gray-500">{item.endpointId || 'N/A'}</td><td className="px-3 py-3 text-xs text-gray-500">{item.requestId || 'N/A'}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-gray-500">{time(item.createdAt)}</td></tr>)}</tbody></Table> : <Empty title="No logged errors" detail="No loaded error records match the search." />}</Panel>
  </div>
}

function EndpointForm({ onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', strategy: '', mode: 'paper', maxRiskPercent: '', maxLeverage: '', replayWindowSeconds: 300, ipWhitelist: '' })
  const [saving, setSaving] = useState(false)
  const set = (key, value) => setForm(previous => ({ ...previous, [key]: value }))
  const submit = async event => {
    event.preventDefault(); setSaving(true)
    try {
      const payload = {
        name: form.name.trim(), strategy: form.strategy.trim(), mode: form.mode,
        replayWindowSeconds: Number(form.replayWindowSeconds),
        ipWhitelist: form.ipWhitelist.split(/[\n,]/).map(value => value.trim()).filter(Boolean),
        ...(form.maxRiskPercent !== '' ? { maxRiskPercent: Number(form.maxRiskPercent) } : {}),
        ...(form.maxLeverage !== '' ? { maxLeverage: Number(form.maxLeverage) } : {}),
      }
      const result = await api.createEndpoint(payload)
      toast.success('Endpoint created. Copy the secret now.')
      onSaved(result)
    } catch (error) { toast.error(error.message) } finally { setSaving(false) }
  }
  return <form onSubmit={submit} className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><label className="text-xs text-gray-400">Name<input required maxLength={128} className={`${inputClass} mt-1`} value={form.name} onChange={event => set('name', event.target.value)} /></label><label className="text-xs text-gray-400">Strategy<input required maxLength={128} className={`${inputClass} mt-1`} value={form.strategy} onChange={event => set('strategy', event.target.value)} /></label><label className="text-xs text-gray-400">Mode<select className={`${inputClass} mt-1`} value={form.mode} onChange={event => set('mode', event.target.value)}><option value="paper">Paper (default)</option><option value="live">Live (fail-closed)</option></select></label><label className="text-xs text-gray-400">Replay window (seconds)<input required type="number" min="1" max="3600" className={`${inputClass} mt-1`} value={form.replayWindowSeconds} onChange={event => set('replayWindowSeconds', event.target.value)} /></label><label className="text-xs text-gray-400">Maximum risk % (optional)<input type="number" min="0" max="100" step="0.01" className={`${inputClass} mt-1`} value={form.maxRiskPercent} onChange={event => set('maxRiskPercent', event.target.value)} /></label><label className="text-xs text-gray-400">Maximum leverage (optional)<input type="number" min="1" max="125" step="0.01" className={`${inputClass} mt-1`} value={form.maxLeverage} onChange={event => set('maxLeverage', event.target.value)} /></label></div><label className="block text-xs text-gray-400">IP whitelist (optional; one IP/CIDR per line)<textarea rows="4" className={`${inputClass} mt-1 resize-y`} value={form.ipWhitelist} onChange={event => set('ipWhitelist', event.target.value)} placeholder="203.0.113.10\n10.0.0.0/24" /></label>{form.mode === 'live' && <div className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-200"><ShieldAlert size={18} className="shrink-0" /><p>Live mode is fail-closed. The server blocks execution unless a tenant-safe live adapter is explicitly configured.</p></div>}<div className="flex justify-end gap-2"><button type="button" className={buttonClass} onClick={onClose}>Cancel</button><button disabled={saving} className={`${buttonClass} border-[#e94560]/60 bg-[#e94560] text-white hover:bg-[#d83c56]`}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Create endpoint</button></div></form>
}

function Endpoints({ endpoints, refresh }) {
  const [creating, setCreating] = useState(false)
  const [secretResult, setSecretResult] = useState(null)
  const [busy, setBusy] = useState(null)
  const copy = async value => { try { await navigator.clipboard.writeText(value); toast.success('Copied to clipboard') } catch { toast.error('Clipboard access was denied') } }
  const mutate = async (id, action, success) => {
    setBusy(id)
    try { await action(); toast.success(success); await refresh() } catch (error) { toast.error(error.message) } finally { setBusy(null) }
  }
  const rotate = endpoint => {
    if (!window.confirm(`Rotate the secret for “${endpoint.name}”? The current secret will stop working immediately.`)) return
    mutate(endpoint.id, async () => { const result = await api.rotateEndpointSecret(endpoint.id); setSecretResult(result) }, 'Secret rotated')
  }
  const remove = endpoint => {
    if (!window.confirm(`Soft-delete “${endpoint.name}”? It will be disabled and hidden, but retained for audit history.`)) return
    mutate(endpoint.id, () => api.deleteEndpoint(endpoint.id), 'Endpoint soft-deleted')
  }
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold text-white">Webhook endpoints</h2><p className="mt-1 text-xs text-gray-500">All configured endpoints are shown; no client-side list limit is applied.</p></div><button className={`${buttonClass} border-[#e94560]/50 bg-[#e94560] text-white`} onClick={() => setCreating(true)}><Plus size={16} /> New endpoint</button></div>
    <div className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-200"><LockKeyhole size={20} className="shrink-0" /><div><p className="font-medium">Live execution is fail-closed</p><p className="mt-1 text-xs text-amber-200/70">Selecting live mode never bypasses server safety. Without a configured tenant-safe adapter, live orders are blocked.</p></div></div>
    {endpoints.length ? <div className="grid gap-4 xl:grid-cols-2">{endpoints.map(endpoint => {
      const url = endpoint.webhookUrl || `${WEBHOOK_API_BASE_URL}/webhook/v1/${endpoint.id}`
      return <Panel key={endpoint.id} className="p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-semibold text-white">{endpoint.name || 'Unnamed endpoint'}</h3><Badge status={endpoint.mode}>{titleCase(endpoint.mode)}</Badge><Badge status={endpoint.enabled ? 'enabled' : 'disabled'}>{endpoint.enabled ? 'Enabled' : 'Disabled'}</Badge></div><p className="mt-1 text-sm text-gray-400">{endpoint.strategy || 'No strategy'}</p></div><Webhook className="shrink-0 text-[#e94560]" size={21} /></div><div className="mt-4 flex items-center gap-2 rounded-lg border border-[#242447] bg-black/20 p-2"><code className="min-w-0 flex-1 truncate text-xs text-gray-400">{url}</code><button aria-label="Copy webhook URL" onClick={() => copy(url)} className="rounded-md p-1.5 text-gray-400 hover:bg-white/5 hover:text-white"><Copy size={15} /></button></div><div className="mt-4 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-[#101025] p-2"><p className="text-lg font-semibold text-emerald-400">{number(endpoint.acceptedCount)}</p><p className="text-[10px] uppercase text-gray-600">Accepted</p></div><div className="rounded-lg bg-[#101025] p-2"><p className="text-lg font-semibold text-red-400">{number(endpoint.failedCount)}</p><p className="text-[10px] uppercase text-gray-600">Failed</p></div><div className="rounded-lg bg-[#101025] p-2"><p className="text-lg font-semibold text-amber-400">{number(endpoint.duplicateCount)}</p><p className="text-[10px] uppercase text-gray-600">Duplicate</p></div></div><dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs"><dt className="text-gray-600">Max risk</dt><dd className="text-right text-gray-400">{numberValue(endpoint.maxRiskPercent) === null ? 'Not set' : `${number(endpoint.maxRiskPercent)}%`}</dd><dt className="text-gray-600">Max leverage</dt><dd className="text-right text-gray-400">{numberValue(endpoint.maxLeverage) === null ? 'Not set' : `${number(endpoint.maxLeverage)}×`}</dd><dt className="text-gray-600">Replay window</dt><dd className="text-right text-gray-400">{number(endpoint.replayWindowSeconds)}s</dd><dt className="text-gray-600">Last activity</dt><dd className="text-right text-gray-400">{time(endpoint.lastActivityAt)}</dd></dl><div className="mt-5 flex flex-wrap gap-2"><button disabled={busy === endpoint.id} className={buttonClass} onClick={() => mutate(endpoint.id, () => endpoint.enabled ? api.disableEndpoint(endpoint.id) : api.enableEndpoint(endpoint.id), endpoint.enabled ? 'Endpoint disabled' : 'Endpoint enabled')}>{endpoint.enabled ? <CircleOff size={15} /> : <CheckCircle2 size={15} />}{endpoint.enabled ? 'Disable' : 'Enable'}</button><button disabled={busy === endpoint.id} className={buttonClass} onClick={() => rotate(endpoint)}><KeyRound size={15} /> Rotate secret</button><button disabled={busy === endpoint.id} className={`${buttonClass} text-red-300`} onClick={() => remove(endpoint)}><Trash2 size={15} /> Delete</button></div></Panel>
    })}</div> : <Panel><Empty title="No endpoints configured" detail="Create a paper endpoint to begin receiving TradingView webhooks." /></Panel>}
    {creating && <Modal title="Create webhook endpoint" onClose={() => setCreating(false)}><EndpointForm onClose={() => setCreating(false)} onSaved={result => { setCreating(false); setSecretResult(result); refresh() }} /></Modal>}
    {secretResult && <Modal title="One-time webhook secret" onClose={() => setSecretResult(null)}><div className="space-y-4"><div className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-200"><AlertTriangle size={20} className="shrink-0" /><p><strong>Copy this secret now.</strong> It is shown only once and cannot be recovered. Closing this dialog permanently hides it.</p></div>{secretResult.webhookUrl && <div><p className="mb-1 text-xs text-gray-500">Webhook URL</p><div className="flex gap-2"><code className="min-w-0 flex-1 break-all rounded-lg bg-black/30 p-3 text-xs text-gray-300">{secretResult.webhookUrl}</code><button className={buttonClass} onClick={() => copy(secretResult.webhookUrl)}><Copy size={15} /></button></div></div>}<div><p className="mb-1 text-xs text-gray-500">Secret</p><div className="flex gap-2"><code className="min-w-0 flex-1 break-all rounded-lg border border-[#e94560]/30 bg-[#e94560]/5 p-3 text-sm text-[#ff8a9e]">{secretResult.secret}</code><button className={buttonClass} onClick={() => copy(secretResult.secret)}><Copy size={15} /></button></div></div><button className={`${buttonClass} w-full`} onClick={() => setSecretResult(null)}>I have stored the secret securely</button></div></Modal>}
  </div>
}

const notificationDefaults = { desktop: false, sound: false, telegram: false, discord: false, email: false, mobile: false }
function Notifications({ uid }) {
  const storageKey = `webhook-intelligence-notifications:${uid || 'anonymous'}`
  const [settings, setSettings] = useState(notificationDefaults)
  useEffect(() => {
    try { setSettings({ ...notificationDefaults, ...JSON.parse(localStorage.getItem(storageKey) || '{}') }) } catch { setSettings(notificationDefaults) }
  }, [storageKey])
  const update = (key, value) => {
    const next = { ...settings, [key]: value }
    setSettings(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { toast.error('Unable to save browser preferences') }
  }
  const requestDesktop = async () => {
    if (!('Notification' in window)) return toast.error('Browser notifications are not supported')
    const permission = await Notification.requestPermission()
    update('desktop', permission === 'granted')
    permission === 'granted' ? toast.success('Browser notifications enabled') : toast.error('Notification permission was not granted')
  }
  const testDesktop = () => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return toast.error('Enable browser notification permission first')
    new Notification('Webhook Intelligence', { body: 'Test notification from your local dashboard preference.' })
  }
  const testSound = () => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext
      if (!AudioContext) throw new Error('Audio is not supported')
      const context = new AudioContext()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.frequency.value = 660
      gain.gain.setValueAtTime(0.08, context.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.22)
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.22)
      oscillator.onended = () => context.close()
    } catch (error) { toast.error(error.message) }
  }
  const items = [
    ['desktop', 'Desktop / browser alerts', 'Stored locally; requires browser permission.', Bell],
    ['sound', 'Sound alerts', 'Stored locally; browser audio policy applies.', Volume2],
    ['telegram', 'Telegram', 'UI preference only — not server-configured.', RadioTower],
    ['discord', 'Discord', 'UI preference only — not server-configured.', Webhook],
    ['email', 'Email', 'UI preference only — not server-configured.', Bell],
    ['mobile', 'Mobile push', 'UI preference only — not server-configured.', Activity],
  ]
  return <div className="grid gap-4 lg:grid-cols-[1fr_320px]"><Panel className="overflow-hidden"><div className="border-b border-[#2a2a5a]/60 p-5"><h2 className="font-semibold text-white">Notification preferences</h2><p className="mt-1 text-xs text-gray-500">Saved only in this browser for the signed-in user.</p></div><div className="divide-y divide-[#242440]/60">{items.map(([key, label, detail, Icon]) => <div key={key} className="flex items-center gap-4 p-5"><div className="rounded-xl bg-[#e94560]/10 p-2.5 text-[#e94560]"><Icon size={19} /></div><div className="min-w-0 flex-1"><p className="text-sm font-medium text-gray-200">{label}</p><p className="mt-1 text-xs text-gray-500">{detail}</p></div><button role="switch" aria-checked={settings[key]} aria-label={`Toggle ${label}`} onClick={() => key === 'desktop' && !settings.desktop ? requestDesktop() : update(key, !settings[key])} className={`relative h-6 w-11 shrink-0 rounded-full transition ${settings[key] ? 'bg-[#e94560]' : 'bg-[#30304f]'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${settings[key] ? 'left-6' : 'left-1'}`} /></button></div>)}</div></Panel><div className="space-y-4"><Panel className="p-5"><h3 className="text-sm font-semibold text-white">Browser tests</h3><p className="mt-1 text-xs text-gray-500">Tests run locally and do not contact the server.</p><div className="mt-4 space-y-2"><button className={`${buttonClass} w-full`} onClick={requestDesktop}><Bell size={16} /> Request permission</button><button className={`${buttonClass} w-full`} onClick={testDesktop}><CheckCircle2 size={16} /> Test notification</button><button className={`${buttonClass} w-full`} onClick={testSound}><Volume2 size={16} /> Test sound</button></div></Panel><Panel className="p-5"><div className="flex gap-3 text-xs text-amber-200"><AlertTriangle size={18} className="shrink-0" /><p>Telegram, Discord, email, and mobile toggles are UI preferences only. They do not configure backend delivery integrations.</p></div></Panel></div></div>
}

export default function WebhookIntelligence() {
  const { user } = useAuth()
  const [tab, setTab] = useState('Overview')
  const [data, setData] = useState({ overview: {}, health: {}, endpoints: [], events: [], errors: [], executions: [], positions: [] })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)
  const [now, setNow] = useState(Date.now())
  const fetching = useRef(false)
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (fetching.current || !user) return
    fetching.current = true
    if (!quiet) setRefreshing(true)
    const requests = [api.overview(), api.endpoints(), api.events({ limit: 100 }), api.errors({ limit: 200 }), api.executions({ limit: 200 }), api.health(), api.trades({ status: 'open', limit: 200 })]
    try {
      const results = await Promise.allSettled(requests)
      const failed = results.filter(result => result.status === 'rejected')
      if (failed.length === results.length) throw failed[0].reason
      setData(previous => ({
        overview: results[0].status === 'fulfilled' ? record(results[0].value) : previous.overview,
        endpoints: results[1].status === 'fulfilled' ? array(results[1].value.endpoints) : previous.endpoints,
        events: results[2].status === 'fulfilled' ? array(results[2].value.events) : previous.events,
        errors: results[3].status === 'fulfilled' ? array(results[3].value.errors) : previous.errors,
        executions: results[4].status === 'fulfilled' ? array(results[4].value.executions) : previous.executions,
        health: results[5].status === 'fulfilled' ? record(results[5].value) : previous.health,
        positions: results[6].status === 'fulfilled' ? array(results[6].value.trades) : previous.positions,
      }))
      setLastUpdated(new Date())
      setError(failed.length ? `${failed.length} data source${failed.length > 1 ? 's' : ''} could not refresh; showing available last-known data.` : '')
    } catch (failure) { setError(failure?.message || 'Unable to load webhook intelligence.') } finally { fetching.current = false; setLoading(false); setRefreshing(false) }
  }, [user])
  const loadHistory = useCallback(query => api.events(query), [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) load({ quiet: true }) }, 10000)
    const focus = () => { if (!document.hidden) load({ quiet: true }) }
    const visibility = () => { if (!document.hidden) load({ quiet: true }) }
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', visibility)
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visibility) }
  }, [load])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer) }, [])
  const stale = lastUpdated && now - lastUpdated.getTime() > 25000
  const options = useMemo(() => ({
    strategies: [...new Set(data.events.map(item => item.strategy).filter(Boolean))].sort(),
    symbols: [...new Set(data.events.map(item => item.symbol).filter(Boolean))].sort(),
    actions: [...new Set(data.events.map(item => item.action).filter(Boolean))].sort(),
    statuses: [...new Set(data.events.map(item => item.status).filter(Boolean))].sort(),
  }), [data.events])
  return <div className="min-h-full bg-[#060612] px-3 py-5 text-white sm:px-5 lg:px-7">
    <div className="mx-auto max-w-[1700px] space-y-5">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-[#e94560]"><RadioTower size={15} /> TradingView operations</div><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Webhook Intelligence</h1><p className="mt-2 max-w-2xl text-sm text-gray-500">Monitor validated alerts, paper execution, endpoint safety, and operational health from real server records.</p></div><div className="flex flex-wrap items-center gap-3"><div className="text-right text-xs text-gray-500"><p>{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Not updated yet'}</p><p className={stale ? 'text-amber-400' : 'text-emerald-400'}>{stale ? 'Stale data' : document.hidden ? 'Polling paused while hidden' : 'Auto-refresh · 10s'}</p></div><button className={buttonClass} disabled={refreshing} onClick={() => load()}>{refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Refresh</button></div></header>
      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-200"><span className="flex items-center gap-2"><AlertTriangle size={18} />{error}</span><button className={buttonClass} onClick={() => load()}>Retry</button></div>}
      <nav aria-label="Webhook intelligence sections" className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-[#242447] bg-[#0c0c1c] p-1">{TABS.map(name => <button key={name} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)} className={`inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-[#e94560]/40 ${tab === name ? 'bg-[#e94560] text-white shadow-lg shadow-[#e94560]/15' : 'text-gray-500 hover:bg-white/[.04] hover:text-gray-200'}`}>{name}{name === 'Open Positions' && data.positions.length > 0 && <span className="rounded-full bg-sky-400/15 px-1.5 py-0.5 text-[10px] text-sky-300">{data.positions.length}</span>}</button>)}</nav>
      {loading && !lastUpdated ? <Skeleton /> : <main className="animate-fadeIn">{tab === 'Overview' && <Overview overview={data.overview} health={data.health} events={data.events} />}{tab === 'Alert History' && <History events={data.events} options={options} loadHistory={loadHistory} loading={loading} refreshVersion={lastUpdated?.getTime() || 0} />}{tab === 'Open Positions' && <OpenPositions positions={data.positions} />}{tab === 'Analytics' && <Analytics overview={data.overview} events={data.events} positions={data.positions} onViewPositions={() => setTab('Open Positions')} />}{tab === 'Execution Logs' && <Logs executions={data.executions} errors={data.errors} />}{tab === 'Endpoints' && <Endpoints endpoints={data.endpoints} refresh={() => load()} />}{tab === 'Notifications' && <Notifications uid={user?.uid || user?.id} />}</main>}
    </div>
  </div>
}
