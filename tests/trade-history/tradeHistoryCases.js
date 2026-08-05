import { rowToTrade } from '../../src/utils/csvImporter.js'

export const generatedSeed = 0x5eed2026

const canonicalTrade = index => ({
  id: `canonical-${index}`,
  pair: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'DOGE/USDT', 'BNB/USDT'][index - 1],
  type: index % 2 === 0 ? 'short' : 'long',
  entryPrice: 100 + index,
  exitPrice: 102 + index,
  quantity: index,
  pnl: index % 2 === 0 ? -index : index * 2,
  pnlPercent: index % 2 === 0 ? -1.5 : 2.5,
  leverage: 1,
  fees: 0.1,
  date: `2026-07-${String(16 - index).padStart(2, '0')}`,
  time: '09:30',
  strategy: 'Breakout',
  session: 'London',
  notes: `Canonical trade ${index}`,
  tags: 'canonical',
  rating: (index % 5) + 1,
  timeframe: '1h',
  emotion: 'calm',
  screenshot: null,
})

export const canonicalTrades = () => Array.from({ length: 7 }, (_, index) => canonicalTrade(index + 1))

export const primaryLegacyTrade = {
  id: 'legacy-8',
  pair: 'BTC/USDT',
  type: null,
  pnl: 0,
  date: '2026-07-01',
}

const routeConsumedFields = [
  'pair', 'type', 'strategy', 'notes', 'tags', 'session', 'date', 'pnl',
  'entryPrice', 'exitPrice', 'quantity', 'rating', 'time', 'leverage', 'fees',
  'pnlPercent', 'timeframe', 'emotion', 'screenshot',
]

const nonStringValues = {
  pair: 404,
  type: { legacyDirection: 'sideways' },
  strategy: ['Breakout'],
  notes: 9001,
  tags: ['legacy', 'imported'],
  session: { name: 'London' },
  date: { raw: 'not-a-date' },
  pnl: { amount: 12 },
  entryPrice: { value: 100 },
  exitPrice: ['102'],
  quantity: { units: 2 },
  rating: { stars: 5 },
  time: { hour: 9 },
  leverage: ['3'],
  fees: { usd: 1 },
  pnlPercent: ['2.5'],
  timeframe: { label: '1h' },
  emotion: ['calm'],
  screenshot: { url: 'legacy-image' },
}

function generatedTrades(kind) {
  return routeConsumedFields.map((field, index) => {
    const trade = { ...canonicalTrade((index % 7) + 1), id: `generated-${kind}-${field}`, date: `2026-06-${String(28 - index).padStart(2, '0')}` }
    if (kind === 'missing') delete trade[field]
    if (kind === 'null') trade[field] = null
    if (kind === 'non-string') trade[field] = nonStringValues[field]
    return trade
  })
}

function csvOriginTrade() {
  const { trade, errors } = rowToTrade(
    { 'Trading Pair': 'ETH/USDT', Direction: 'sideways' },
    { pair: 'Trading Pair', direction: 'Direction' },
    [],
    0,
    'UTC',
  )
  if (errors.length > 0 || !trade) throw new Error(`CSV fixture generation failed: ${errors.join('; ')}`)
  return { ...trade, id: 'csv-unknown-direction-8', date: '2026-07-01', time: '09:30' }
}

const scenarioFactories = {
  primary: () => ({ trades: [...canonicalTrades(), { ...primaryLegacyTrade }] }),
  'csv-origin': () => ({ trades: [...canonicalTrades(), csvOriginTrade()] }),
  'generated-missing': () => ({ trades: [...canonicalTrades(), { ...primaryLegacyTrade }, ...generatedTrades('missing')] }),
  'generated-null': () => ({ trades: [...canonicalTrades(), { ...primaryLegacyTrade }, ...generatedTrades('null')] }),
  'generated-non-string': () => ({ trades: [...canonicalTrades(), { ...primaryLegacyTrade }, ...generatedTrades('non-string')] }),
  'storage-strategies-malformed': () => ({ trades: canonicalTrades(), storage: { vmt_custom_strategies: '{' } }),
  'storage-strategies-non-array': () => ({ trades: canonicalTrades(), storage: { vmt_custom_strategies: '{"legacy":true}' } }),
  'storage-sessions-malformed': () => ({ trades: canonicalTrades(), storage: { vmt_custom_sessions: '[' } }),
  'storage-sessions-non-array': () => ({ trades: canonicalTrades(), storage: { vmt_custom_sessions: '{"legacy":true}' } }),
}

export const scenarioNames = Object.keys(scenarioFactories)

export function getScenario(name) {
  const factory = scenarioFactories[name]
  if (!factory) throw new Error(`Unknown Trade History scenario: ${name}`)
  return {
    name,
    seed: generatedSeed,
    userIsAuthenticated: true,
    navigationTarget: '/history',
    storage: {},
    ...factory(),
  }
}

function dashboardCanRender(trades) {
  return trades.slice(0, 7).every(trade =>
    typeof trade.pair === 'string' && typeof trade.type === 'string' && trade.type.length > 0,
  )
}

function historyFieldsAreSafelyConsumable(trade) {
  const optionalText = ['pair', 'strategy', 'notes', 'tags', 'session']
  const textSafe = optionalText.every(field => trade[field] == null || typeof trade[field] === 'string')
  const renderSafe = ['entryPrice', 'exitPrice', 'quantity', 'time'].every(field =>
    trade[field] == null || ['string', 'number'].includes(typeof trade[field]),
  )
  return (trade.type === 'long' || trade.type === 'short') && textSafe && renderSafe
}

export function isBugCondition(input) {
  const admittedByInitialFilters = input.trades
  return input.userIsAuthenticated === true &&
    input.navigationTarget === '/history' &&
    dashboardCanRender(input.trades) &&
    admittedByInitialFilters.some(trade => !historyFieldsAreSafelyConsumable(trade))
}

export function minimizedPrimaryInput() {
  return {
    userIsAuthenticated: true,
    navigationTarget: '/history',
    trades: [...canonicalTrades(), { ...primaryLegacyTrade }],
  }
}
