/**
 * BinanceSync - Binance Futures Testnet Auto Sync Settings & Dashboard
 * Connect API keys, start/stop sync, view open positions, sync status
 */
import React, { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from '../firebase'
import toast from 'react-hot-toast'

const API_BASE = 'https://vivek-raj.onrender.com'

async function authenticatedFetch(url, options = {}) {
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('Authentication required')
  return globalThis.fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  })
}

function BinanceSync() {
  const { user } = useAuth()
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [testnet, setTestnet] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [connected, setConnected] = useState(false)
  const [syncStatus, setSyncStatus] = useState(null)
  const [balance, setBalance] = useState(null)
  const [positions, setPositions] = useState([])
  const [lastSync, setLastSync] = useState(null)
  const [autoSync, setAutoSync] = useState(false)

  // Listen to user's sync status from Firestore
  useEffect(() => {
    if (!user?.uid) return
    const unsubscribe = onSnapshot(doc(db, 'users', user.uid), (snap) => {
      if (snap.exists()) {
        const data = snap.data()
        setConnected(data.binanceConnected || false)
        setLastSync(data.lastSyncTime || null)
        setSyncStatus(data.syncStatus || null)
        if (data.binanceBalance) setBalance(data.binanceBalance)
      }
    })
    return () => unsubscribe()
  }, [user])

  // Connect to Binance
  const handleConnect = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      toast.error('Enter API Key and Secret')
      return
    }
    setConnecting(true)
    try {
      const res = await authenticatedFetch(`${API_BASE}/api/binance/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid, apiKey, apiSecret, testnet }),
      })
      const data = await res.json()
      if (data.status === 'connected') {
        setConnected(true)
        setBalance(data.balance)
        toast.success('Binance Futures Testnet Connected!')
      } else {
        toast.error(data.message || 'Connection failed')
      }
    } catch (e) {
      toast.error('Server error. Make sure backend is running.')
    }
    setConnecting(false)
  }

  // Start auto sync
  const handleStartSync = async () => {
    setSyncing(true)
    try {
      const res = await authenticatedFetch(`${API_BASE}/api/binance/start-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid, apiKey, apiSecret, testnet, interval: 10 }),
      })
      const data = await res.json()
      if (data.status === 'started') {
        setAutoSync(true)
        toast.success('Auto-sync started! Trades will sync every 10 seconds.')
      } else {
        toast.error(data.message || 'Failed to start sync')
      }
    } catch (e) {
      toast.error('Server error')
    }
    setSyncing(false)
  }

  // Stop sync
  const handleStopSync = async () => {
    try {
      await authenticatedFetch(`${API_BASE}/api/binance/stop-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid }),
      })
      setAutoSync(false)
      toast.success('Auto-sync stopped')
    } catch (e) {
      toast.error('Failed to stop sync')
    }
  }

  // Sync now (manual)
  const handleSyncNow = async () => {
    setSyncing(true)
    try {
      const res = await authenticatedFetch(`${API_BASE}/api/binance/sync-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid, apiKey, apiSecret, testnet }),
      })
      const data = await res.json()
      if (data.status === 'synced') {
        toast.success(`Synced! ${data.newTrades} new trades found.`)
      } else {
        toast.error(data.message || 'Sync failed')
      }
    } catch (e) {
      toast.error('Server error')
    }
    setSyncing(false)
  }

  // Fetch positions
  const fetchPositions = async () => {
    if (!apiKey || !apiSecret) return
    try {
      const res = await authenticatedFetch(`${API_BASE}/api/binance/positions/${user.uid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, apiSecret, testnet }),
      })
      const data = await res.json()
      setPositions(data.positions || [])
    } catch (e) {}
  }

  // Poll positions every 10 seconds when connected
  useEffect(() => {
    if (!connected || !apiKey) return
    fetchPositions()
    const interval = setInterval(fetchPositions, 10000)
    return () => clearInterval(interval)
  }, [connected, apiKey])

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          🔗 Binance Futures Testnet
        </h1>
        <p className="text-gray-400 text-sm mt-1">Connect your Binance Futures Testnet API for automatic trade sync</p>
      </div>

      {/* Connection Status */}
      <div className={`glass-card p-5 border-l-4 ${connected ? 'border-emerald-500' : 'border-gray-600'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${connected ? 'bg-emerald-500 animate-pulse' : 'bg-gray-500'}`} />
            <div>
              <p className="text-white font-medium">{connected ? 'Connected' : 'Not Connected'}</p>
              {lastSync && <p className="text-gray-500 text-xs">Last sync: {new Date(lastSync).toLocaleString()}</p>}
            </div>
          </div>
          {connected && balance && (
            <div className="text-right">
              <p className="text-emerald-400 font-bold">${parseFloat(balance.total || 0).toFixed(2)}</p>
              <p className="text-gray-500 text-xs">USDT Balance</p>
            </div>
          )}
        </div>
      </div>

      {/* API Keys Input */}
      <div className="glass-card p-5 space-y-4">
        <h3 className="text-white font-semibold">API Configuration</h3>
        <p className="text-gray-500 text-xs">Get your testnet API keys from: <a href="https://testnet.binancefuture.com" target="_blank" rel="noreferrer" className="text-[#e94560] hover:underline">testnet.binancefuture.com</a></p>

        <div>
          <label className="block text-gray-400 text-xs mb-1">API Key</label>
          <input type="text" value={apiKey} onChange={e => setApiKey(e.target.value)}
            className="input-field text-sm font-mono" placeholder="Enter Binance Futures Testnet API Key" />
        </div>

        <div>
          <label className="block text-gray-400 text-xs mb-1">Secret Key</label>
          <input type="password" value={apiSecret} onChange={e => setApiSecret(e.target.value)}
            className="input-field text-sm font-mono" placeholder="Enter Binance Futures Testnet Secret Key" />
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" checked={testnet} onChange={e => setTestnet(e.target.checked)}
            className="w-4 h-4 rounded" />
          <span className="text-gray-400 text-sm">Testnet Mode (Demo — no real money)</span>
        </div>

        <div className="flex gap-3">
          <button onClick={handleConnect} disabled={connecting}
            className="px-5 py-2.5 rounded-lg bg-[#e94560] text-white text-sm font-medium hover:bg-[#d63851] disabled:opacity-50 transition-all">
            {connecting ? 'Connecting...' : connected ? 'Reconnect' : 'Connect Binance'}
          </button>

          {connected && (
            <>
              <button onClick={handleSyncNow} disabled={syncing}
                className="px-5 py-2.5 rounded-lg bg-blue-500/20 text-blue-400 text-sm font-medium hover:bg-blue-500/30 border border-blue-500/30 disabled:opacity-50">
                {syncing ? 'Syncing...' : 'Sync Now'}
              </button>

              {!autoSync ? (
                <button onClick={handleStartSync} disabled={syncing}
                  className="px-5 py-2.5 rounded-lg bg-emerald-500/20 text-emerald-400 text-sm font-medium hover:bg-emerald-500/30 border border-emerald-500/30 disabled:opacity-50">
                  Start Auto-Sync
                </button>
              ) : (
                <button onClick={handleStopSync}
                  className="px-5 py-2.5 rounded-lg bg-red-500/20 text-red-400 text-sm font-medium hover:bg-red-500/30 border border-red-500/30">
                  Stop Auto-Sync
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Sync Info */}
      {connected && (
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-3">ℹ️ How it works</h3>
          <ul className="text-gray-400 text-sm space-y-1.5">
            <li>✅ Open trades on <a href="https://testnet.binancefuture.com" target="_blank" rel="noreferrer" className="text-[#e94560]">Binance Futures Testnet</a></li>
            <li>✅ Close your position</li>
            <li>✅ Trade automatically appears in your Journal (Dashboard, History, Calendar, Analytics)</li>
            <li>✅ No manual entry needed</li>
            <li>⏱️ Sync every 10 seconds when Auto-Sync is ON</li>
          </ul>
        </div>
      )}

      {/* Open Positions */}
      {positions.length > 0 && (
        <div className="glass-card p-5">
          <h3 className="text-white font-semibold mb-3">📊 Open Positions ({positions.length})</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-[#1e1e3a]">
                  <th className="text-left py-2 px-2">Symbol</th>
                  <th className="text-left py-2 px-2">Side</th>
                  <th className="text-left py-2 px-2">Size</th>
                  <th className="text-left py-2 px-2">Entry</th>
                  <th className="text-left py-2 px-2">Mark</th>
                  <th className="text-left py-2 px-2">PNL</th>
                  <th className="text-left py-2 px-2">ROI</th>
                  <th className="text-left py-2 px-2">Lev</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => (
                  <tr key={i} className="border-b border-[#1e1e3a]/30">
                    <td className="py-2 px-2 text-white font-medium">{p.symbol}</td>
                    <td className={`py-2 px-2 font-bold ${p.side === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>
                      {p.side?.toUpperCase()}
                    </td>
                    <td className="py-2 px-2 text-gray-300">{p.contracts}</td>
                    <td className="py-2 px-2 text-gray-300">${p.entryPrice?.toFixed(2)}</td>
                    <td className="py-2 px-2 text-gray-300">${p.markPrice?.toFixed(2)}</td>
                    <td className={`py-2 px-2 font-bold ${p.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {p.unrealizedPnl >= 0 ? '+' : ''}${p.unrealizedPnl?.toFixed(2)}
                    </td>
                    <td className={`py-2 px-2 ${p.percentage >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {p.percentage?.toFixed(2)}%
                    </td>
                    <td className="py-2 px-2 text-gray-300">{p.leverage}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export default BinanceSync
