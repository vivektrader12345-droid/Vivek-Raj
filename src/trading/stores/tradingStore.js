/**
 * Trading Store - Zustand
 * Manages positions, orders, trades, and account state
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  OrderSide, OrderType, OrderStatus, PositionStatus, CloseReason,
  createOrder, createPositionFromOrder, createTradeFromPosition,
  calculatePnL, calculateROI, calculateRisk, calculateRiskPercent,
  calculateReward, calculateRewardPercent, calculateProtectionMetrics,
  createDefaultProtection,
} from '../types'

const INITIAL_BALANCE = 100000

function withProtectionMetrics(position, initializeMissing = false) {
  let stopLoss = position.stopLoss
  let takeProfit = position.takeProfit
  if (initializeMissing && !position.protectionInitialized) {
    const defaults = createDefaultProtection(position.entryPrice, position.side)
    stopLoss = stopLoss || defaults.stopLoss
    takeProfit = takeProfit || defaults.takeProfit
  }
  return {
    ...position,
    stopLoss: stopLoss || null,
    takeProfit: takeProfit || null,
    protectionInitialized: true,
    ...calculateProtectionMetrics(position, stopLoss, takeProfit),
  }
}

function withLiveMetrics(position, currentPrice) {
  const protectedPosition = withProtectionMetrics(position)
  const mark = Number(currentPrice) || protectedPosition.currentPrice || protectedPosition.entryPrice
  const unrealizedPnl = calculatePnL(protectedPosition.side, protectedPosition.entryPrice, mark, protectedPosition.qty, protectedPosition.leverage)
  return { ...protectedPosition, currentPrice: mark, markPrice: mark, unrealizedPnl, roi: calculateROI(unrealizedPnl, protectedPosition.margin) }
}

const useTradingStore = create(
  persist(
    (set, get) => ({
      // ==================== STATE ====================
      positions: [],        // Open positions
      pendingOrders: [],    // Pending limit/stop orders
      trades: [],           // Closed trade history
      account: {
        balance: INITIAL_BALANCE,
        availableMargin: INITIAL_BALANCE,
        usedMargin: 0,
        walletBalance: INITIAL_BALANCE,
        dailyPnl: 0,
        totalPnl: 0,
        winRate: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
      },
      currentPrice: 0,
      markPrice: 0,
      lastTickTime: 0,

      // ==================== ACTIONS ====================

      /**
       * Place a new order (market, limit, or stop)
       */
      placeOrder: ({ symbol, side, type, qty, price, leverage, stopLoss, takeProfit, limitPrice }) => {
        const state = get()
        const orderPrice = type === OrderType.MARKET ? state.currentPrice : (limitPrice || price)
        
        if (!orderPrice || orderPrice <= 0) return { success: false, error: 'Invalid price' }

        const defaults = createDefaultProtection(orderPrice, side)
        const resolvedStopLoss = Number(stopLoss) > 0 ? Number(stopLoss) : defaults.stopLoss
        const resolvedTakeProfit = Number(takeProfit) > 0 ? Number(takeProfit) : defaults.takeProfit
        const order = createOrder({
          symbol, side, type, qty,
          price: orderPrice,
          leverage,
          stopLoss: resolvedStopLoss,
          takeProfit: resolvedTakeProfit,
          limitPrice: type !== OrderType.MARKET ? orderPrice : null,
        })

        // Check margin
        if (order.margin > state.account.availableMargin) {
          return { success: false, error: 'Insufficient margin' }
        }

        if (type === OrderType.MARKET) {
          // Execute immediately - create position with chart protection ready.
          const position = withProtectionMetrics(createPositionFromOrder(order), true)
          set(s => ({
            positions: [...s.positions, position],
            account: {
              ...s.account,
              usedMargin: s.account.usedMargin + order.margin,
              availableMargin: s.account.availableMargin - order.margin,
              balance: s.account.balance - order.fee,
            },
          }))
          return { success: true, order, position }
        } else {
          // Add to pending orders
          set(s => ({
            pendingOrders: [...s.pendingOrders, order],
            account: {
              ...s.account,
              availableMargin: s.account.availableMargin - order.margin,
            },
          }))
          return { success: true, order }
        }
      },

      /**
       * Cancel a pending order
       */
      cancelOrder: (orderId) => {
        const state = get()
        const order = state.pendingOrders.find(o => o.id === orderId)
        if (!order) return

        set(s => ({
          pendingOrders: s.pendingOrders.filter(o => o.id !== orderId),
          account: {
            ...s.account,
            availableMargin: s.account.availableMargin + order.margin,
          },
        }))
      },

      /**
       * Modify a pending order's price
       */
      modifyOrder: (orderId, newPrice) => {
        set(s => ({
          pendingOrders: s.pendingOrders.map(o =>
            o.id === orderId ? { ...o, price: newPrice, limitPrice: newPrice, updatedAt: Date.now() } : o
          ),
        }))
      },

      /**
       * Close a position at current price
       */
      closePosition: (positionId, reason = CloseReason.MANUAL) => {
        const state = get()
        const position = state.positions.find(p => p.id === positionId)
        if (!position) return

        const exitPrice = state.currentPrice
        const trade = createTradeFromPosition(position, exitPrice, reason)
        const isWin = trade.netPnl > 0

        set(s => {
          const newTrades = [...s.trades, trade]
          const winCount = s.account.winningTrades + (isWin ? 1 : 0)
          const loseCount = s.account.losingTrades + (isWin ? 0 : 1)
          const totalCount = s.account.totalTrades + 1

          return {
            positions: s.positions.filter(p => p.id !== positionId),
            trades: newTrades,
            account: {
              ...s.account,
              balance: s.account.balance + position.margin + trade.netPnl,
              availableMargin: s.account.availableMargin + position.margin + trade.netPnl,
              usedMargin: s.account.usedMargin - position.margin,
              totalPnl: s.account.totalPnl + trade.netPnl,
              dailyPnl: s.account.dailyPnl + trade.netPnl,
              totalTrades: totalCount,
              winningTrades: winCount,
              losingTrades: loseCount,
              winRate: totalCount > 0 ? (winCount / totalCount) * 100 : 0,
            },
          }
        })
      },

      /**
       * Partial close - close a portion of a position
       */
      partialClose: (positionId, closeQty) => {
        const state = get()
        const position = state.positions.find(p => p.id === positionId)
        if (!position || closeQty >= position.qty) {
          // If closing all, just close normally
          return get().closePosition(positionId, CloseReason.PARTIAL)
        }

        const exitPrice = state.currentPrice
        const ratio = closeQty / position.qty
        const closedMargin = position.margin * ratio

        // Create partial trade
        const partialPosition = { ...position, qty: closeQty, margin: closedMargin }
        const trade = createTradeFromPosition(partialPosition, exitPrice, CloseReason.PARTIAL)
        const isWin = trade.netPnl > 0

        set(s => {
          const winCount = s.account.winningTrades + (isWin ? 1 : 0)
          const loseCount = s.account.losingTrades + (isWin ? 0 : 1)
          const totalCount = s.account.totalTrades + 1

          return {
            positions: s.positions.map(p =>
              p.id === positionId
                ? withProtectionMetrics({ ...p, qty: p.qty - closeQty, margin: p.margin - closedMargin })
                : p
            ),
            trades: [...s.trades, trade],
            account: {
              ...s.account,
              balance: s.account.balance + closedMargin + trade.netPnl,
              availableMargin: s.account.availableMargin + closedMargin + trade.netPnl,
              usedMargin: s.account.usedMargin - closedMargin,
              totalPnl: s.account.totalPnl + trade.netPnl,
              dailyPnl: s.account.dailyPnl + trade.netPnl,
              totalTrades: totalCount,
              winningTrades: winCount,
              losingTrades: loseCount,
              winRate: totalCount > 0 ? (winCount / totalCount) * 100 : 0,
            },
          }
        })
      },

      /**
       * Reverse a position (close current + open opposite)
       */
      reversePosition: (positionId) => {
        const state = get()
        const position = state.positions.find(p => p.id === positionId)
        if (!position) return

        // Close existing
        get().closePosition(positionId, CloseReason.REVERSE)

        // Open opposite
        const newSide = position.side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY
        get().placeOrder({
          symbol: position.symbol,
          side: newSide,
          type: OrderType.MARKET,
          qty: position.qty,
          price: state.currentPrice,
          leverage: position.leverage,
          stopLoss: null,
          takeProfit: null,
        })
      },

      /** Atomically update entry/TP/SL so chart dragging produces one render. */
      modifyPositionProtection: (positionId, changes) => {
        set(s => ({
          positions: s.positions.map(position => position.id === positionId
            ? withLiveMetrics({ ...position, ...changes, updatedAt: Date.now() }, s.currentPrice)
            : position),
        }))
      },

      /** Update the paper position entry anchor from the chart tool. */
      modifyEntryPrice: (positionId, newEntry) => {
        const price = Number(newEntry)
        if (!Number.isFinite(price) || price <= 0) return
        set(s => ({
          positions: s.positions.map(position => position.id === positionId
            ? withLiveMetrics({ ...position, entryPrice: price, updatedAt: Date.now() }, s.currentPrice)
            : position),
        }))
      },

      /** Modify stop loss for a position. Null removes the line. */
      modifyStopLoss: (positionId, newSL) => {
        const price = newSL == null ? null : Number(newSL)
        if (price !== null && (!Number.isFinite(price) || price <= 0)) return
        set(s => ({
          positions: s.positions.map(position => position.id === positionId
            ? withProtectionMetrics({ ...position, stopLoss: price, updatedAt: Date.now() })
            : position),
        }))
      },

      /** Modify take profit for a position. Null removes the line. */
      modifyTakeProfit: (positionId, newTP) => {
        const price = newTP == null ? null : Number(newTP)
        if (price !== null && (!Number.isFinite(price) || price <= 0)) return
        set(s => ({
          positions: s.positions.map(position => position.id === positionId
            ? withProtectionMetrics({ ...position, takeProfit: price, updatedAt: Date.now() })
            : position),
        }))
      },

      /**
       * Update tick price - called on every WebSocket price update
       * Checks SL/TP triggers and updates PnL
       */
      updatePrice: (price) => {
        const state = get()
        if (price === state.currentPrice) {
          set({ markPrice: price, lastTickTime: Date.now() })
          return
        }

        set({ currentPrice: price, markPrice: price, lastTickTime: Date.now() })

        // Update positions PnL
        const updatedPositions = state.positions.map(pos => {
          const pnl = calculatePnL(pos.side, pos.entryPrice, price, pos.qty, pos.leverage)
          const roi = calculateROI(pnl, pos.margin)
          return { ...pos, currentPrice: price, markPrice: price, unrealizedPnl: pnl, roi }
        })

        set({ positions: updatedPositions })

        // Check SL/TP triggers
        updatedPositions.forEach(pos => {
          // Stop Loss check
          if (pos.stopLoss) {
            if (pos.side === OrderSide.BUY && price <= pos.stopLoss) {
              get().closePosition(pos.id, CloseReason.STOP_LOSS)
              return
            }
            if (pos.side === OrderSide.SELL && price >= pos.stopLoss) {
              get().closePosition(pos.id, CloseReason.STOP_LOSS)
              return
            }
          }
          // Take Profit check
          if (pos.takeProfit) {
            if (pos.side === OrderSide.BUY && price >= pos.takeProfit) {
              get().closePosition(pos.id, CloseReason.TAKE_PROFIT)
              return
            }
            if (pos.side === OrderSide.SELL && price <= pos.takeProfit) {
              get().closePosition(pos.id, CloseReason.TAKE_PROFIT)
              return
            }
          }
          // Liquidation check
          if (pos.liquidationPrice) {
            if (pos.side === OrderSide.BUY && price <= pos.liquidationPrice) {
              get().closePosition(pos.id, CloseReason.LIQUIDATION)
              return
            }
            if (pos.side === OrderSide.SELL && price >= pos.liquidationPrice) {
              get().closePosition(pos.id, CloseReason.LIQUIDATION)
              return
            }
          }
        })

        // Check pending orders for trigger
        state.pendingOrders.forEach(order => {
          let triggered = false
          if (order.type === OrderType.LIMIT) {
            if (order.side === OrderSide.BUY && price <= order.price) triggered = true
            if (order.side === OrderSide.SELL && price >= order.price) triggered = true
          } else if (order.type === OrderType.STOP) {
            if (order.side === OrderSide.BUY && price >= order.price) triggered = true
            if (order.side === OrderSide.SELL && price <= order.price) triggered = true
          }

          if (triggered) {
            // Fill the order
            const filledOrder = { ...order, status: OrderStatus.FILLED, filledQty: order.qty, filledAt: Date.now() }
            const position = withProtectionMetrics(createPositionFromOrder(filledOrder), true)

            set(s => ({
              pendingOrders: s.pendingOrders.filter(o => o.id !== order.id),
              positions: [...s.positions, position],
              account: {
                ...s.account,
                usedMargin: s.account.usedMargin + order.margin,
                balance: s.account.balance - order.fee,
              },
            }))
          }
        })
      },

      /**
       * Close all positions
       */
      closeAllPositions: () => {
        const state = get()
        state.positions.forEach(pos => {
          get().closePosition(pos.id, CloseReason.MANUAL)
        })
      },

      /**
       * Cancel all pending orders
       */
      cancelAllOrders: () => {
        const state = get()
        const totalMargin = state.pendingOrders.reduce((sum, o) => sum + o.margin, 0)
        set(s => ({
          pendingOrders: [],
          account: {
            ...s.account,
            availableMargin: s.account.availableMargin + totalMargin,
          },
        }))
      },

      /**
       * Reset account to initial state
       */
      resetAccount: () => {
        set({
          positions: [],
          pendingOrders: [],
          trades: [],
          account: {
            balance: INITIAL_BALANCE,
            availableMargin: INITIAL_BALANCE,
            usedMargin: 0,
            walletBalance: INITIAL_BALANCE,
            dailyPnl: 0,
            totalPnl: 0,
            winRate: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
          },
        })
      },

      /**
       * Get computed values for a position
       */
      getPositionDetails: (positionId) => {
        const state = get()
        const pos = state.positions.find(p => p.id === positionId)
        if (!pos) return null

        const pnl = calculatePnL(pos.side, pos.entryPrice, state.currentPrice, pos.qty, pos.leverage)
        const roi = calculateROI(pnl, pos.margin)
        const risk = calculateRisk(pos.side, pos.entryPrice, pos.stopLoss, pos.qty, pos.leverage)
        const riskPercent = calculateRiskPercent(risk, pos.margin)
        const reward = calculateReward(pos.side, pos.entryPrice, pos.takeProfit, pos.qty, pos.leverage)
        const rewardPercent = calculateRewardPercent(reward, pos.margin)
        const positionSize = pos.entryPrice * pos.qty

        return {
          ...pos,
          pnl,
          roi,
          risk,
          riskPercent,
          reward,
          rewardPercent,
          positionSize,
          currentPrice: state.currentPrice,
          duration: Date.now() - pos.openedAt,
        }
      },
    }),
    {
      name: 'pro-trading-store',
      version: 2,
      migrate: persisted => ({
        ...persisted,
        positions: (persisted?.positions || []).map(position => withProtectionMetrics(position, true)),
      }),
      partialize: (state) => ({
        positions: state.positions,
        pendingOrders: state.pendingOrders,
        trades: state.trades,
        account: state.account,
      }),
    }
  )
)

export default useTradingStore
