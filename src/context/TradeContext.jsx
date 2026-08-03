/**
 * TradeContext - Trade Journal Management
 * Uses Firestore for per-user trade storage (users/{uid}/trades/)
 * Falls back gracefully when user is not authenticated
 */
import React, { createContext, useContext, useState, useEffect } from 'react'
import { useAuth } from './AuthContext'
import { auth } from '../firebase'
import {
  getTrades, addTrade as addTradeFS,
  updateTrade as updateTradeFS, deleteTrade as deleteTradeFS,
  subscribeTrades, batchImportTrades,
} from '../services/firestoreService'
import { parseImportCSV } from '../utils/csvImporter'

const TradeContext = createContext(null)

export function TradeProvider({ children }) {
  const { user, userSettings } = useAuth()
  const [trades, setTrades] = useState([])
  const [loading, setLoading] = useState(false)
  const [tradeError, setTradeError] = useState(null)
  const uid = auth.currentUser?.uid || user?.uid || user?.id || null

  // Subscribe using Firebase Auth's authoritative UID, never a profile field.
  useEffect(() => {
    if (!user || !uid) {
      setTrades([])
      setTradeError(null)
      return
    }

    setLoading(true)
    setTradeError(null)

    let cancelled = false
    const formatTrades = (tradesList) => tradesList.map(t => ({
      ...t,
      createdAt: t.createdAt?.toDate?.() ? t.createdAt.toDate().toISOString() : t.createdAt,
      updatedAt: t.updatedAt?.toDate?.() ? t.updatedAt.toDate().toISOString() : t.updatedAt,
    }))
    const applyTrades = (tradesList) => {
      if (cancelled) return
      setTrades(formatTrades(tradesList))
      setTradeError(null)
      setLoading(false)
    }
    const handleError = (error) => {
      if (cancelled) return
      console.error('Trade synchronization failed:', error)
      setTradeError(error?.message || 'Unable to load trades from Firestore')
      setLoading(false)
    }
    const refreshTrades = () => getTrades(uid).then(applyTrades).catch(handleError)

    const unsubscribe = subscribeTrades(uid, applyTrades, handleError)
    refreshTrades()
    const refreshInterval = setInterval(refreshTrades, 10000)
    window.addEventListener('focus', refreshTrades)

    return () => {
      cancelled = true
      unsubscribe()
      clearInterval(refreshInterval)
      window.removeEventListener('focus', refreshTrades)
    }
  }, [user, uid])

  const addTrade = async (trade) => {
    if (!user) return null
    const pnl = calculatePnL(trade)
    const pnlPercent = calculatePnLPercent(trade)
    const newTrade = {
      ...trade,
      pnl,
      pnlPercent,
      userId: uid,
    }
    const docId = await addTradeFS(uid, newTrade)
    return { ...newTrade, id: docId }
  }

  const updateTrade = async (id, updatedData) => {
    if (!user) return
    const existing = trades.find(t => t.id === id)
    if (!existing) return
    const merged = { ...existing, ...updatedData }
    const pnl = calculatePnL(merged)
    const pnlPercent = calculatePnLPercent(merged)
    await updateTradeFS(uid, id, { ...updatedData, pnl, pnlPercent })
  }

  const deleteTrade = async (id) => {
    if (!user || !id) return
    try {
      const { collection: col, getDocs, deleteDoc: delDoc, doc: docRef } = await import('firebase/firestore')
      const { db: fireDb } = await import('../firebase')

      // Get ALL trades and find the one matching this id
      const tradesRef = col(fireDb, 'users', uid, 'trades')
      const snap = await getDocs(tradesRef)

      let deleted = false
      for (const docSnap of snap.docs) {
        if (docSnap.id === id || docSnap.data().tradeId === id || docSnap.data().id === id) {
          await delDoc(docSnap.ref)
          deleted = true
          break
        }
      }

      if (!deleted) {
        // Last resort — try direct delete
        await delDoc(docRef(fireDb, 'users', uid, 'trades', id))
      }

      // Force update local state
      setTrades(prev => prev.filter(t => t.id !== id))
    } catch (err) {
      console.error('Delete failed:', err)
      // Force remove from UI anyway
      setTrades(prev => prev.filter(t => t.id !== id))
    }
  }

  const deleteAllTrades = async () => {
    if (!user) return
    try {
      // Direct Firestore batch delete — most reliable
      const { collection, getDocs, writeBatch } = await import('firebase/firestore')
      const { db } = await import('../firebase')
      const tradesRef = collection(db, 'users', uid, 'trades')
      const snap = await getDocs(tradesRef)
      if (snap.empty) {
        setTrades([])
        return
      }
      const { writeBatch: createBatch } = await import('firebase/firestore')
      const batch = writeBatch(db)
      snap.docs.forEach(docSnap => batch.delete(docSnap.ref))
      await batch.commit()
      setTrades([])
    } catch (err) {
      console.error('Delete all error:', err)
      // Force clear local state anyway
      setTrades([])
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

  /**
   * importTrades — full CSV import pipeline
   *
   * 1. Parses the CSV text using the auto-mapping importer.
   * 2. Runs duplicate detection against the current `trades` state.
   * 3. Writes new trades (setDoc with importId key) and updates existing ones
   *    via batchImportTrades, which respects Firestore's 500-op batch limit.
   * 4. Returns an ImportResult the UI can show as a summary.
   *    The real-time Firestore listener in this context automatically re-syncs
   *    all pages (Dashboard, Analytics, Calendar, History) after the batch commit.
   *
   * @param {string}   csvText
   * @param {function(number):void} [onProgress]  0-100 callback
   * @returns {Promise<ImportResult>}
   *
   * ImportResult {
   *   totalRows:    number,
   *   inserted:     number,
   *   updated:      number,
   *   skipped:      number,
   *   failed:       number,
   *   errors:       string[],   // parse-level errors
   *   rowErrors:    { rowIndex: number, messages: string[] }[],
   *   headerWarning: string|null,
   * }
   */
  const importTrades = async (csvText, onProgress) => {
    if (!user || !uid) {
      return {
        totalRows: 0, inserted: 0, updated: 0, skipped: 0, failed: 0,
        errors: ['Not authenticated'], rowErrors: [], headerWarning: null,
      }
    }

    // Step 1 – Parse & classify (pure, no network)
    // Resolve timezone: user settings → browser locale → UTC fallback
    const timezone = userSettings?.timezone
      || Intl.DateTimeFormat().resolvedOptions().timeZone
      || 'UTC'

    onProgress?.(5)
    const parseResult = parseImportCSV(csvText, trades, timezone)
    onProgress?.(20)

    const { toInsert, toUpdate, toSkip, parseErrors, headerWarning, totalRows } = parseResult

    // Build top-level error strings from parse errors
    const errors = parseErrors.flatMap(e => e.messages)

    // If nothing to do, return early
    if (toInsert.length === 0 && toUpdate.length === 0) {
      onProgress?.(100)
      return {
        totalRows,
        inserted:     0,
        updated:      0,
        skipped:      toSkip.length,
        failed:       parseErrors.filter(e => e.rowIndex >= 0).length,
        errors,
        rowErrors:    parseErrors,
        headerWarning,
      }
    }

    // Step 2 – Enrich each trade (pnl, pnlPercent, userId) exactly like addTrade does
    // This ensures exitPrice, entryPrice, type etc. all produce correct computed values
    const enrichedInserts = toInsert.map(({ trade, rowIndex }) => {
      const enriched = {
        ...trade,
        pnl:        calculatePnL(trade),
        pnlPercent: calculatePnLPercent(trade),
        userId:     uid,
      }
      return { trade: enriched, rowIndex }
    })

    // Step 3 – Write to Firestore
    // Map progress from 20→95 while batchImportTrades runs
    const wrappedProgress = (pct) => onProgress?.(20 + Math.round(pct * 0.75))

    const writeResult = await batchImportTrades(uid, enrichedInserts, toUpdate, wrappedProgress)
    onProgress?.(100)

    // Collect write-level errors
    const writeErrors = [
      ...writeResult.insertErrors,
      ...writeResult.updateErrors,
    ]

    return {
      totalRows,
      inserted:     writeResult.inserted,
      updated:      writeResult.updated,
      skipped:      toSkip.length,
      failed:       writeResult.failed + parseErrors.filter(e => e.rowIndex >= 0).length,
      errors:       [...errors, ...writeErrors],
      rowErrors:    parseErrors,
      headerWarning,
    }
  }

  return (
    <TradeContext.Provider value={{ trades, loading, tradeError, addTrade, updateTrade, deleteTrade, deleteAllTrades, getStats, getTradeById, importTrades }}>
      {children}
    </TradeContext.Provider>
  )
}

export function useTrades() {
  const context = useContext(TradeContext)
  if (!context) throw new Error('useTrades must be used within TradeProvider')
  return context
}
