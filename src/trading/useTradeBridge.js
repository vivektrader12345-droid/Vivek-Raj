/**
 * Trade Bridge - Connects Pro Trading (Zustand) with TradeContext (Firestore)
 * 
 * When Pro Trading closes a position, this bridge automatically saves
 * the completed trade to the central Trade History (Firestore).
 * 
 * This ensures ALL pages (Dashboard, Analytics, Calendar, History)
 * see the same data from a single source of truth.
 */
import { useEffect, useRef } from 'react'
import useTradingStore from './stores/tradingStore'
import { useTrades } from '../context/TradeContext'

export function useTradeBridge() {
  const { addTrade } = useTrades()
  const addTradeRef = useRef(addTrade)
  const prevTradesCountRef = useRef(0)

  // Keep the latest Firestore writer without rebuilding the store subscription.
  useEffect(() => {
    addTradeRef.current = addTrade
  }, [addTrade])

  useEffect(() => {
    // Existing persisted Pro Trading history is the baseline. Only trades closed
    // while this bridge is mounted should be copied into the central journal.
    prevTradesCountRef.current = useTradingStore.getState().trades.length

    const unsubscribe = useTradingStore.subscribe((state) => {
      const currentCount = state.trades.length
      const prevCount = prevTradesCountRef.current

      // Account reset clears local history. Reset the baseline as well so the
      // first trade closed after a reset is still synchronized.
      if (currentCount < prevCount) {
        prevTradesCountRef.current = currentCount
        return
      }

      if (currentCount === prevCount) return

      // Advance the baseline before starting asynchronous writes so another
      // store update cannot enqueue the same closed trade twice.
      prevTradesCountRef.current = currentCount

      // Process every newly appended trade, including the first 0 -> 1 close.
      // Slicing also protects against a future action appending several trades
      // in one store update.
      state.trades.slice(prevCount, currentCount).forEach((closedTrade) => {
        if (!closedTrade) return

        addTradeRef.current({
          pair: closedTrade.symbol || 'BTC/USDT',
          symbol: closedTrade.symbol || 'BTC/USDT',
          exchange: 'Pro Trading',
          type: closedTrade.side === 'buy' ? 'long' : 'short',
          side: closedTrade.side,
          entryPrice: closedTrade.entryPrice?.toString() || '0',
          exitPrice: closedTrade.exitPrice?.toString() || '0',
          quantity: closedTrade.qty?.toString() || '1',
          leverage: closedTrade.leverage?.toString() || '1',
          margin: closedTrade.margin?.toString() || '0',
          stopLoss: closedTrade.stopLoss?.toString() || '',
          takeProfit: closedTrade.takeProfit?.toString() || '',
          fees: closedTrade.fee?.toString() || '0',
          pnl: closedTrade.netPnl ?? closedTrade.pnl ?? 0,
          pnlPercent: closedTrade.roi ?? 0,
          strategy: '',
          notes: `Auto-saved from Pro Trading. Reason: ${closedTrade.closeReason || 'manual'}`,
          date: closedTrade.openedAt ? new Date(closedTrade.openedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
          entryDate: closedTrade.openedAt ? new Date(closedTrade.openedAt).toISOString() : new Date().toISOString(),
          exitDate: closedTrade.closedAt ? new Date(closedTrade.closedAt).toISOString() : new Date().toISOString(),
          duration: closedTrade.duration || '',
          status: 'closed',
          source: 'pro_trading',
          tradeId: `pro_${closedTrade.id}`,
        }).then((savedTrade) => {
          if (!savedTrade) {
            console.error('[TradeBridge] Save skipped because no authenticated user was available')
          }
        }).catch((err) => console.error('[TradeBridge] Save failed:', err))
      })
    })

    return () => unsubscribe()
  }, [])
}
