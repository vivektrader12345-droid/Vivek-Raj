/**
 * TradeContext - Trade Journal Management
 * Uses Firestore for per-user trade storage (users/{uid}/trades/)
 * Falls back gracefully when user is not authenticated
 */
import React, { createContext, useContext, useState, useEffect } from 'react'
import { useAuth } from './AuthContext'
import {
  getTrades, addTrade as addTradeFS,
  updateTrade as updateTradeFS, deleteTrade as deleteTradeFS,
  subscribeTrades,
} from '../services/firestoreService'

const TradeContext = createContext(null)

export function TradeProvider({ children }) {
  const { user } = useAuth()
  const [trades, setTrades] = useState([])
  const [loading, setLoading] = useState(false)

  // Subscribe to trades when user logs in, clear on logout
  useEffect(() => {
    if (!user || !user.uid) {
      setTrades([])
      return
    }

    setLoading(true)

    // Real-time listener for trades
    const unsubscribe = subscribeTrades(user.uid, (tradesList) => {
      // Convert Firestore timestamps to ISO strings for compatibility
      const formatted = tradesList.map(t => ({
        ...t,
        createdAt: t.createdAt?.toDate?.() ? t.createdAt.toDate().toISOString() : t.createdAt,
        updatedAt: t.updatedAt?.toDate?.() ? t.updatedAt.toDate().toISOString() : t.updatedAt,
      }))
      setTrades(formatted)
      setLoading(false)
    })

    return () => unsubscribe()
  }, [user])

  const addTrade = async (trade) => {
    if (!user) return null
    const pnl = calculatePnL(trade)
    const pnlPercent = calculatePnLPercent(trade)
    const newTrade = {
      ...trade,
      pnl,
      pnlPercent,
      userId: user.uid,
    }
    const docId = await addTradeFS(user.uid, newTrade)
    return { ...newTrade, id: docId }
  }

  const updateTrade = async (id, updatedData) => {
    if (!user) return
    const existing = trades.find(t => t.id === id)
    if (!existing) return
    const merged = { ...existing, ...updatedData }
    const pnl = calculatePnL(merged)
    const pnlPercent = calculatePnLPercent(merged)
    await updateTradeFS(user.uid, id, { ...updatedData, pnl, pnlPercent })
  }

  const deleteTrade = async (id) => {
    if (!user) return
    await deleteTradeFS(user.uid, id)
  }

  const deleteAllTrades = async () => {
    if (!user) return
    // Delete each trade individually
    for (const trade of trades) {
      await deleteTradeFS(user.uid, trade.id)
    }
  }

  const calculatePnL = (trade) => {
    const entry = parseFloat(trade.entryPrice) || 0
    const exit = parseFloat(trade.exitPrice) || 0
    const qty = parseFloat(trade.quantity) || 0
    const fees = parseFloat(trade.fees) || 0
    const leverage = parseFloat(trade.leverage) || 1
    let pnl = 0
    if (trade.type === 'long') pnl = (exit - entry) * qty * leverage
    else pnl = (entry - exit) * qty * leverage
    pnl -= fees
    return parseFloat(pnl.toFixed(2))
  }

  const calculatePnLPercent = (trade) => {
    const entry = parseFloat(trade.entryPrice) || 0
    const exit = parseFloat(trade.exitPrice) || 0
    if (entry === 0) return 0
    let percent = 0
    if (trade.type === 'long') percent = ((exit - entry) / entry) * 100
    else percent = ((entry - exit) / entry) * 100
    const leverage = parseFloat(trade.leverage) || 1
    return parseFloat((percent * leverage).toFixed(2))
  }

  const getStats = () => {
    if (trades.length === 0) {
      return {
        totalTrades: 0, wins: 0, losses: 0, breakeven: 0,
        winRate: 0, totalPnL: 0, avgPnL: 0, avgWin: 0, avgLoss: 0,
        largestWin: 0, largestLoss: 0, profitFactor: 0,
        currentStreak: 0, longestWinStreak: 0, longestLossStreak: 0,
        totalFees: 0, expectancy: 0,
      }
    }
    const wins = trades.filter(t => t.pnl > 0)
    const losses = trades.filter(t => t.pnl < 0)
    const breakeven = trades.filter(t => t.pnl === 0)
    const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0)
    const totalWins = wins.reduce((sum, t) => sum + t.pnl, 0)
    const totalLosses = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0))
    const totalFees = trades.reduce((sum, t) => sum + (parseFloat(t.fees) || 0), 0)

    let longestWinStreak = 0, longestLossStreak = 0, tempWin = 0, tempLoss = 0
    const sorted = [...trades].sort((a, b) => new Date(a.date || a.createdAt) - new Date(b.date || b.createdAt))
    sorted.forEach(t => {
      if (t.pnl > 0) { tempWin++; tempLoss = 0; longestWinStreak = Math.max(longestWinStreak, tempWin) }
      else if (t.pnl < 0) { tempLoss++; tempWin = 0; longestLossStreak = Math.max(longestLossStreak, tempLoss) }
    })

    let currentStreak = 0
    for (let i = 0; i < trades.length; i++) {
      if (i === 0) currentStreak = trades[i].pnl > 0 ? 1 : -1
      else { if (currentStreak > 0 && trades[i].pnl > 0) currentStreak++; else if (currentStreak < 0 && trades[i].pnl < 0) currentStreak--; else break }
    }

    const winRate = (wins.length / trades.length) * 100
    const avgWin = wins.length > 0 ? totalWins / wins.length : 0
    const avgLoss = losses.length > 0 ? totalLosses / losses.length : 0
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0
    const expectancy = (winRate / 100 * avgWin) - ((1 - winRate / 100) * avgLoss)

    return {
      totalTrades: trades.length, wins: wins.length, losses: losses.length, breakeven: breakeven.length,
      winRate: parseFloat(winRate.toFixed(1)), totalPnL: parseFloat(totalPnL.toFixed(2)),
      avgPnL: parseFloat((totalPnL / trades.length).toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(2)), avgLoss: parseFloat(avgLoss.toFixed(2)),
      largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
      profitFactor: profitFactor === Infinity ? '∞' : parseFloat(profitFactor.toFixed(2)),
      currentStreak, longestWinStreak, longestLossStreak,
      totalFees: parseFloat(totalFees.toFixed(2)), expectancy: parseFloat(expectancy.toFixed(2)),
    }
  }

  const getTradeById = (id) => trades.find(t => t.id === id)

  return (
    <TradeContext.Provider value={{ trades, loading, addTrade, updateTrade, deleteTrade, deleteAllTrades, getStats, getTradeById }}>
      {children}
    </TradeContext.Provider>
  )
}

export function useTrades() {
  const context = useContext(TradeContext)
  if (!context) throw new Error('useTrades must be used within TradeProvider')
  return context
}
