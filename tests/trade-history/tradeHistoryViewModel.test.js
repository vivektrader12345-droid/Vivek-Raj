import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HISTORY_DISPLAY_PLACEHOLDER,
  filterHistoryTrades,
  getHistoryStrategies,
  normalizeTradeForHistory,
  normalizeTradesForHistory,
  parseHistoryCustomOptions,
  projectHistoryTrades,
  sortHistoryTrades,
  sumHistoryPnl,
} from '../../src/utils/tradeHistoryViewModel.js'

const canonicalTrade = () => ({
  id: 'manual-win',
  pair: 'BTC/USDT',
  type: 'long',
  entryPrice: 100,
  exitPrice: 112,
  quantity: 10,
  leverage: 1,
  pnl: 120,
  pnlPercent: 12,
  fees: 0,
  date: '2026-07-20',
  time: '09:30',
  strategy: 'Breakout',
  session: 'London',
  notes: 'Manual breakout at resistance',
  tags: 'manual,alpha',
  rating: 5,
  timeframe: '1h',
  emotion: 'calm',
  screenshot: null,
})

test('canonical trade projection preserves observed History semantics and raw identity', () => {
  const rawTrade = canonicalTrade()
  const before = structuredClone(rawTrade)
  const viewModel = normalizeTradeForHistory(rawTrade)

  assert.strictEqual(viewModel.rawTrade, rawTrade)
  assert.strictEqual(viewModel.rawReference, rawTrade)
  assert.deepEqual(viewModel.identity, { id: 'manual-win', reference: rawTrade })
  assert.equal(viewModel.direction.value, 'long')
  assert.equal(viewModel.direction.label, 'LONG')
  assert.equal(viewModel.result, 'win')
  assert.deepEqual(viewModel.display, {
    id: 'manual-win',
    date: new Date(rawTrade.date).toLocaleDateString(),
    pair: 'BTC/USDT',
    type: 'LONG',
    entryPrice: '100',
    exitPrice: '112',
    quantity: '10',
    leverage: '1',
    pnl: '120',
    pnlPercent: 12,
    strategy: 'Breakout',
    session: 'London',
    time: '09:30',
    timeframe: '1h',
    emotion: 'calm',
    notes: 'Manual breakout at resistance',
    screenshot: '',
    rating: '⭐⭐⭐⭐⭐',
    tags: 'manual,alpha',
  })
  assert.deepEqual(viewModel.sortKeys, {
    date: new Date(rawTrade.date).getTime(),
    pair: 'BTC/USDT',
    pnl: 120,
  })
  assert.equal(viewModel.searchKey, 'btc/usdt breakout manual breakout at resistance manual,alpha')
  assert.equal(viewModel.totalPnlValue, 120)
  assert.deepEqual(viewModel.exportValues, {
    date: '2026-07-20',
    pair: 'BTC/USDT',
    type: 'long',
    entryPrice: 100,
    exitPrice: 112,
    quantity: 10,
    leverage: 1,
    pnl: 120,
    strategy: 'Breakout',
    fees: 0,
    notes: 'Manual breakout at resistance',
  })
  assert.deepEqual(rawTrade, before, 'normalization must not mutate Firestore-shaped input')
})

test('unsupported and malformed fields receive stable safe values', () => {
  const rawTrade = {
    id: 'legacy-8',
    pair: 404,
    type: 'sideways',
    entryPrice: { value: 100 },
    exitPrice: Infinity,
    quantity: null,
    leverage: NaN,
    pnl: { amount: 12 },
    pnlPercent: '-Infinity',
    fees: undefined,
    date: { raw: 'not-a-date' },
    strategy: ['Breakout'],
    session: { name: 'London' },
    notes: 9001,
    tags: ['legacy', 17, 'imported'],
    rating: 1000,
    time: { hour: 9 },
    timeframe: false,
    emotion: Symbol('legacy'),
    screenshot: { url: 'legacy-image' },
  }

  const viewModel = normalizeTradeForHistory(rawTrade)

  assert.strictEqual(viewModel.rawReference, rawTrade)
  assert.equal(viewModel.identity.id, 'legacy-8')
  assert.deepEqual(viewModel.direction, {
    raw: 'sideways',
    value: 'unknown',
    isSupported: false,
    label: 'Unknown',
    exportValue: 'unknown',
  })
  assert.equal(viewModel.display.pair, HISTORY_DISPLAY_PLACEHOLDER)
  assert.equal(viewModel.display.strategy, HISTORY_DISPLAY_PLACEHOLDER)
  assert.equal(viewModel.display.date, HISTORY_DISPLAY_PLACEHOLDER)
  assert.equal(viewModel.display.entryPrice, HISTORY_DISPLAY_PLACEHOLDER)
  assert.equal(viewModel.display.exitPrice, HISTORY_DISPLAY_PLACEHOLDER)
  assert.equal(viewModel.display.quantity, HISTORY_DISPLAY_PLACEHOLDER)
  assert.equal(viewModel.display.pnl, HISTORY_DISPLAY_PLACEHOLDER)
  assert.equal(viewModel.display.rating, '⭐⭐⭐⭐⭐')
  assert.equal(viewModel.tags.display, 'legacy, imported')
  assert.equal(viewModel.tags.searchText, 'legacy imported')
  assert.equal(viewModel.result, 'unknown')
  assert.deepEqual(viewModel.sortKeys, { date: null, pair: '', pnl: null })
  assert.equal(viewModel.totalPnlValue, 0)
  assert.deepEqual(viewModel.exportValues, {
    date: '',
    pair: '',
    type: 'unknown',
    entryPrice: '',
    exitPrice: '',
    quantity: '',
    leverage: 1,
    pnl: '',
    strategy: '',
    fees: 0,
    notes: '',
  })
})

test('generated unsafe values remain total across every route-consumed field', () => {
  const routeConsumedFields = [
    'pair', 'type', 'strategy', 'notes', 'tags', 'session', 'date', 'pnl',
    'entryPrice', 'exitPrice', 'quantity', 'rating', 'time', 'leverage', 'fees',
    'pnlPercent', 'timeframe', 'emotion', 'screenshot',
  ]
  const unsafeValues = [
    undefined,
    null,
    42,
    true,
    {},
    [],
    ['legacy'],
    Number.NaN,
    Number.POSITIVE_INFINITY,
    7n,
    Symbol('legacy'),
  ]
  const inputs = []

  for (const field of routeConsumedFields) {
    for (const value of unsafeValues) {
      const rawTrade = { ...canonicalTrade(), id: `${field}-${inputs.length}`, [field]: value }
      inputs.push(rawTrade)
      assert.doesNotThrow(() => normalizeTradeForHistory(rawTrade), `${field}=${String(value)}`)
    }
  }

  const viewModels = normalizeTradesForHistory(inputs)
  assert.equal(viewModels.length, inputs.length)
  viewModels.forEach((viewModel, index) => {
    assert.strictEqual(viewModel.rawReference, inputs[index])
    assert.equal(viewModel.identity.id, inputs[index].id)
    assert.equal(typeof viewModel.searchKey, 'string')
    assert.equal(typeof viewModel.display.pair, 'string')
    assert.equal(typeof viewModel.display.type, 'string')
    assert.equal(typeof viewModel.display.notes, 'string')
    assert.equal(typeof viewModel.exportValues.notes, 'string')
    assert.equal(Number.isFinite(viewModel.totalPnlValue), true)
  })
  assert.doesNotThrow(() => projectHistoryTrades(viewModels, { searchTerm: 'btc' }, 'pair'))
  assert.equal(Number.isFinite(sumHistoryPnl(viewModels)), true)
})

test('collection filtering, sorting, totals, and strategies retain canonical behavior', () => {
  const rawTrades = [
    canonicalTrade(),
    { ...canonicalTrade(), id: 'short-loss', pair: 'ETH/USDT', type: 'short', pnl: -45, date: '2026-07-14', strategy: 'Mean Reversion', tags: 'csv,beta' },
    { ...canonicalTrade(), id: 'breakeven', pair: 'SOL/USDT', pnl: 0, date: '2026-06-07', strategy: '' },
    { ...canonicalTrade(), id: 'legacy', pair: null, type: null, pnl: Infinity, date: 'invalid', strategy: null },
  ]
  const viewModels = normalizeTradesForHistory(rawTrades)

  assert.deepEqual(filterHistoryTrades(viewModels, { type: 'short' }).map(trade => trade.id), ['short-loss'])
  assert.deepEqual(filterHistoryTrades(viewModels, { result: 'breakeven' }).map(trade => trade.id), ['breakeven'])
  assert.deepEqual(filterHistoryTrades(viewModels, { searchTerm: 'beta' }).map(trade => trade.id), ['short-loss'])
  assert.deepEqual(sortHistoryTrades(viewModels, 'date-desc').map(trade => trade.id), ['manual-win', 'short-loss', 'breakeven', 'legacy'])
  assert.deepEqual(sortHistoryTrades(viewModels, 'pnl-asc').map(trade => trade.id), ['short-loss', 'breakeven', 'manual-win', 'legacy'])
  assert.equal(sumHistoryPnl(viewModels), 75)
  assert.deepEqual(getHistoryStrategies(viewModels), ['Breakout', 'Mean Reversion'])
  assert.deepEqual(rawTrades.map(trade => trade.id), ['manual-win', 'short-loss', 'breakeven', 'legacy'])
})

test('custom option parsing preserves valid arrays and rejects corrupt or invalid shapes', () => {
  const valid = ['Breakout', 'Custom Strategy', '', 'Breakout']
  assert.deepEqual(parseHistoryCustomOptions(JSON.stringify(valid)), valid)

  const direct = ['London', 'New York']
  const parsedDirect = parseHistoryCustomOptions(direct)
  assert.deepEqual(parsedDirect, direct)
  assert.notStrictEqual(parsedDirect, direct)

  for (const value of [null, undefined, '', '{', '[', '{}', 'null', '42', '"Breakout"', '["Breakout", 7]']) {
    assert.deepEqual(parseHistoryCustomOptions(value), [], `expected [] for ${String(value)}`)
  }
})
