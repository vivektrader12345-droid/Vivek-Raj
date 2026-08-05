export const preservationSeed = 0x2f2026

const trade = (id, overrides) => ({
  id,
  pair: 'BTC/USDT',
  type: 'long',
  entryPrice: 100,
  exitPrice: 110,
  quantity: 1,
  leverage: 1,
  pnl: 10,
  pnlPercent: 10,
  fees: 0,
  date: '2026-07-20',
  time: '09:30',
  strategy: 'Breakout',
  session: 'London',
  notes: 'Canonical manual record',
  tags: 'canonical,manual',
  rating: 4,
  timeframe: '1h',
  emotion: 'calm',
  screenshot: null,
  status: 'closed',
  source: 'manual',
  ...overrides,
})

export function canonicalPreservationTrades() {
  return [
    trade('manual-win', {
      pair: 'BTC/USDT', pnl: 120, pnlPercent: 12, date: '2026-07-20', time: '09:30',
      entryPrice: 100, exitPrice: 112, quantity: 10, strategy: 'Breakout', session: 'London',
      notes: 'Manual breakout at resistance', tags: 'manual,alpha', rating: 5,
    }),
    trade('csv-loss', {
      pair: 'ETH/USDT', type: 'short', pnl: -45, pnlPercent: -4.5, date: '2026-07-14', time: '14:15',
      entryPrice: 200, exitPrice: 209, quantity: 5, strategy: 'Mean Reversion', session: 'New York',
      notes: 'Imported from canonical CSV', tags: 'csv,beta', rating: 2, source: 'csv_import',
    }),
    trade('pro-breakeven', {
      pair: 'SOL/USDT', pnl: 0, pnlPercent: 0, date: '2026-06-07', time: '08:00',
      entryPrice: '50', exitPrice: '50', quantity: '2', leverage: '3', strategy: '', session: 'Tokyo',
      notes: 'Auto-saved from Pro Trading. Reason: manual', tags: '', rating: 3,
      exchange: 'Pro Trading', source: 'pro_trading', tradeId: 'pro_closed-1',
    }),
    trade('tradingview-win', {
      pair: 'XRP/USDT', type: 'short', pnl: 30, pnlPercent: 3, date: '2025-12-26', time: '16:45',
      entryPrice: 2, exitPrice: 1.7, quantity: 100, strategy: 'Momentum', session: 'Overlap',
      notes: 'TradingView overlay close', tags: 'extension,gamma', rating: 4,
      exchange: 'TradingView Paper', captureSource: 'tradingview_chart_overlay', source: 'tradingview_extension',
    }),
    trade('manual-loss', {
      pair: 'ADA/USDT', pnl: -10, pnlPercent: -1, date: '2026-07-02', time: '11:10',
      entryPrice: 1, exitPrice: 0.9, quantity: 100, strategy: 'Scalping', session: 'Sydney',
      notes: 'Manual range scalp', tags: 'manual,delta', rating: 1,
    }),
    trade('csv-win', {
      pair: 'BNB/USDT', type: 'short', pnl: 25, pnlPercent: 2.5, date: '2024-01-10', time: '07:05',
      entryPrice: 300, exitPrice: 295, quantity: 5, strategy: 'Breakout', session: 'Pre-Market',
      notes: 'Canonical CSV winner', tags: 'csv,epsilon', rating: 5, source: 'csv_import',
    }),
    trade('pro-win', {
      pair: 'DOGE/USDT', pnl: 5, pnlPercent: 0.5, date: '2027-08-28', time: '20:20',
      entryPrice: '0.1', exitPrice: '0.11', quantity: '500', leverage: '2', strategy: '', session: 'After Hours',
      notes: 'Auto-saved from Pro Trading. Reason: take-profit', tags: '', rating: 3,
      exchange: 'Pro Trading', source: 'pro_trading', tradeId: 'pro_closed-2',
    }),
    trade('tradingview-loss', {
      pair: 'AVAX/USDT', type: 'short', pnl: -1, pnlPercent: -0.1, date: '2028-09-29', time: '18:00',
      entryPrice: 40, exitPrice: 41, quantity: 1, strategy: 'Momentum', session: 'London',
      notes: 'TradingView stopped overlay', tags: 'extension,zeta', rating: 2,
      exchange: 'TradingView Paper', captureSource: 'tradingview_chart_overlay', source: 'tradingview_extension',
    }),
  ]
}

export function getPreservationScenario() {
  return {
    name: 'preservation',
    seed: preservationSeed,
    userIsAuthenticated: true,
    navigationTarget: '/history',
    storage: {
      vmt_custom_strategies: JSON.stringify(['Custom Canonical']),
      vmt_custom_sessions: JSON.stringify(['Asia Custom']),
    },
    trades: canonicalPreservationTrades(),
  }
}
