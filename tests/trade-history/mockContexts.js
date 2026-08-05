const recordCall = (method, args) => {
  window.__tradeHistoryContextCalls ??= []
  window.__tradeHistoryContextCalls.push({ method, args })
}

const tradesApi = () => {
  const trades = window.__tradeHistoryScenario?.trades ?? []
  const wins = trades.filter(trade => Number(trade.pnl) > 0)
  const losses = trades.filter(trade => Number(trade.pnl) < 0)
  const totalPnL = trades.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0)
  return {
    trades,
    tradeError: null,
    loading: false,
    addTrade: async trade => { recordCall('addTrade', [trade]); return { ...trade, id: 'fixture-added' } },
    updateTrade: async (id, trade) => { recordCall('updateTrade', [id, trade]); return { ...trade, id } },
    getTradeById: id => trades.find(trade => trade.id === id),
    deleteTrade: async id => { recordCall('deleteTrade', [id]) },
    deleteAllTrades: async () => { recordCall('deleteAllTrades', []) },
    importTrades: async csvText => {
      recordCall('importTrades', [csvText])
      return {
        totalRows: 1,
        inserted: 1,
        updated: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        rowErrors: [],
        headerWarning: null,
      }
    },
    getStats: () => ({
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: trades.length - wins.length - losses.length,
      winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
      totalPnL,
      avgPnL: trades.length ? totalPnL / trades.length : 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      profitFactor: 0,
      currentStreak: 0,
      longestWinStreak: 0,
      longestLossStreak: 0,
      totalFees: 0,
      expectancy: 0,
    }),
  }
}

export function useTrades() {
  return tradesApi()
}

export function useAuth() {
  return {
    user: { uid: 'fixture-user', fullName: 'Fixture Trader', email: 'fixture@example.test', avatar: 'F' },
    userSettings: { timezone: 'UTC' },
    logout: async () => {},
  }
}

export function useCurrency() {
  return {
    currency: 'USD',
    symbol: '$',
    exchangeRate: 83.5,
    toggleCurrency: () => {},
    formatAmount: value => `$${(Number(value) || 0).toFixed(2)}`,
    convert: value => Number(value) || 0,
  }
}

export function useAlerts() {
  return { alerts: [] }
}

export function useTheme() {
  return { theme: 'dark', toggleTheme: () => {} }
}
