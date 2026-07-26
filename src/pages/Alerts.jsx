import React, { useState } from 'react'
import { useAlerts } from '../context/AlertContext'
import { Bell, Plus, Trash2, ToggleLeft, ToggleRight, AlertTriangle, CheckCircle2 } from 'lucide-react'
import toast from 'react-hot-toast'

const PAIRS = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT', 'EUR/USD', 'GBP/USD']
const CONDITIONS = [
  { value: 'price_above', label: 'Price goes above' },
  { value: 'price_below', label: 'Price goes below' },
  { value: 'pnl_target', label: 'P&L reaches target' },
  { value: 'loss_limit', label: 'Loss exceeds limit' },
  { value: 'win_streak', label: 'Win streak reaches' },
  { value: 'loss_streak', label: 'Loss streak reaches' },
  { value: 'daily_target', label: 'Daily P&L target met' },
  { value: 'trade_count', label: 'Trade count exceeds' },
]

function Alerts() {
  const { alerts, addAlert, deleteAlert, toggleAlert, clearAllAlerts } = useAlerts()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    name: '',
    pair: '',
    condition: 'price_above',
    value: '',
    message: '',
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!form.name.trim()) {
      toast.error('Please enter alert name')
      return
    }
    if (!form.value) {
      toast.error('Please enter a value')
      return
    }

    addAlert({
      name: form.name.trim(),
      pair: form.pair,
      condition: form.condition,
      value: form.value,
      message: form.message || `Alert: ${form.name}`,
    })

    toast.success('Alert created!')
    setForm({ name: '', pair: '', condition: 'price_above', value: '', message: '' })
    setShowForm(false)
  }

  const handleDelete = (id) => {
    deleteAlert(id)
    toast.success('Alert deleted')
  }

  const activeAlerts = alerts.filter(a => a.active && !a.triggered)
  const triggeredAlerts = alerts.filter(a => a.triggered)
  const inactiveAlerts = alerts.filter(a => !a.active && !a.triggered)

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl lg:text-3xl font-bold text-white flex items-center gap-3">
            <Bell className="text-[#e94560]" /> Alerts
          </h1>
          <p className="text-gray-400 mt-1 text-sm">Set up price alerts and trading reminders</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-[#e94560] to-[#f5a623] text-white font-medium rounded-xl hover:shadow-lg hover:shadow-[#e94560]/20 transition-all text-sm">
            <Plus size={16} /> New Alert
          </button>
          {alerts.length > 0 && (
            <button onClick={() => { if (window.confirm('Clear all alerts?')) { clearAllAlerts(); toast.success('All alerts cleared') } }}
              className="flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 rounded-xl hover:bg-red-500/20 transition-all text-sm">
              <Trash2 size={16} /> Clear All
            </button>
          )}
        </div>
      </div>

      {/* Create Alert Form */}
      {showForm && (
        <div className="glass-card p-6">
          <h2 className="text-white font-semibold mb-4">Create New Alert</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-gray-400 text-sm mb-1.5">Alert Name *</label>
                <input type="text" value={form.name} onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                  className="input-field" placeholder="e.g., BTC above 100K" />
              </div>
              <div>
                <label className="block text-gray-400 text-sm mb-1.5">Trading Pair</label>
                <select value={form.pair} onChange={(e) => setForm(prev => ({ ...prev, pair: e.target.value }))} className="input-field">
                  <option value="">All Pairs</option>
                  {PAIRS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-gray-400 text-sm mb-1.5">Condition *</label>
                <select value={form.condition} onChange={(e) => setForm(prev => ({ ...prev, condition: e.target.value }))} className="input-field">
                  {CONDITIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-gray-400 text-sm mb-1.5">Value *</label>
                <input type="number" value={form.value} onChange={(e) => setForm(prev => ({ ...prev, value: e.target.value }))}
                  step="any" className="input-field" placeholder="Enter value" />
              </div>
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Custom Message (optional)</label>
              <input type="text" value={form.message} onChange={(e) => setForm(prev => ({ ...prev, message: e.target.value }))}
                className="input-field" placeholder="Message when alert triggers" />
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2.5 border border-[#0f3460] text-gray-400 rounded-lg hover:text-white transition-all text-sm">
                Cancel
              </button>
              <button type="submit" className="px-6 py-2.5 bg-gradient-to-r from-[#e94560] to-[#f5a623] text-white font-medium rounded-lg text-sm">
                Create Alert
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Active Alerts */}
      <div className="glass-card p-5">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
          Active Alerts ({activeAlerts.length})
        </h3>
        {activeAlerts.length === 0 ? (
          <p className="text-gray-500 text-sm py-4 text-center">No active alerts</p>
        ) : (
          <div className="space-y-3">
            {activeAlerts.map(alert => (
              <div key={alert.id} className="flex items-center justify-between p-4 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/50 hover:border-[#0f3460] transition-all">
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium text-sm truncate">{alert.name}</p>
                  <p className="text-gray-500 text-xs mt-0.5">
                    {alert.pair && <span className="text-[#f5a623]">{alert.pair} • </span>}
                    {CONDITIONS.find(c => c.value === alert.condition)?.label}: {alert.value}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  <button onClick={() => toggleAlert(alert.id)} className="p-1.5 text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-all" title="Disable">
                    <ToggleRight size={20} />
                  </button>
                  <button onClick={() => handleDelete(alert.id)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all" title="Delete">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Triggered Alerts */}
      {triggeredAlerts.length > 0 && (
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
            <CheckCircle2 size={18} className="text-emerald-400" />
            Triggered ({triggeredAlerts.length})
          </h3>
          <div className="space-y-3">
            {triggeredAlerts.map(alert => (
              <div key={alert.id} className="flex items-center justify-between p-4 bg-emerald-500/5 rounded-xl border border-emerald-500/20">
                <div>
                  <p className="text-white font-medium text-sm">{alert.name}</p>
                  <p className="text-gray-500 text-xs mt-0.5">
                    Triggered {alert.triggeredAt ? new Date(alert.triggeredAt).toLocaleString() : ''}
                  </p>
                </div>
                <button onClick={() => handleDelete(alert.id)} className="p-1.5 text-gray-400 hover:text-red-400 rounded-lg transition-all">
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inactive Alerts */}
      {inactiveAlerts.length > 0 && (
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
            <AlertTriangle size={18} className="text-yellow-400" />
            Disabled ({inactiveAlerts.length})
          </h3>
          <div className="space-y-3">
            {inactiveAlerts.map(alert => (
              <div key={alert.id} className="flex items-center justify-between p-4 bg-[#0a0a1a] rounded-xl border border-[#0f3460]/30 opacity-60">
                <div>
                  <p className="text-white font-medium text-sm">{alert.name}</p>
                  <p className="text-gray-500 text-xs mt-0.5">
                    {CONDITIONS.find(c => c.value === alert.condition)?.label}: {alert.value}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => toggleAlert(alert.id)} className="p-1.5 text-gray-400 hover:text-emerald-400 rounded-lg transition-all" title="Enable">
                    <ToggleLeft size={20} />
                  </button>
                  <button onClick={() => handleDelete(alert.id)} className="p-1.5 text-gray-400 hover:text-red-400 rounded-lg transition-all">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Info */}
      <div className="glass-card p-4 border-blue-500/20">
        <p className="text-gray-400 text-xs">
          💡 <strong className="text-gray-300">Note:</strong> Alerts are stored locally and will trigger based on manual checks. 
          For real-time price alerts, connect to a live exchange API in the future.
        </p>
      </div>
    </div>
  )
}

export default Alerts
