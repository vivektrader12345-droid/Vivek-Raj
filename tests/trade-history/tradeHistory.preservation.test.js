import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  delay,
  startBrowserHarness,
  stopBrowserHarness,
  summarizeEvents,
  waitForPage,
} from './tradeHistoryBrowserHarness.js'
import { canonicalPreservationTrades, preservationSeed } from './tradeHistoryPreservationCases.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const fixturePath = '/tests/trade-history/tradeHistory.fixture.html'
const allIds = canonicalPreservationTrades().map(trade => trade.id)
const initialIds = [
  'tradingview-loss', 'pro-win', 'manual-win', 'csv-loss',
  'manual-loss', 'pro-breakeven', 'tradingview-win', 'csv-win',
]

const expectedControls = {
  searches: {
    'BTC/USDT': { ids: ['manual-win'], total: '+$120.00' },
    Breakout: { ids: ['manual-win', 'csv-win'], total: '+$145.00' },
    'canonical CSV': { ids: ['csv-loss', 'csv-win'], total: '$-20.00' },
    extension: { ids: ['tradingview-loss', 'tradingview-win'], total: '+$29.00' },
  },
  filters: {
    'Long Only': { ids: ['pro-win', 'manual-win', 'manual-loss', 'pro-breakeven'], total: '+$115.00' },
    'Short Only': { ids: ['tradingview-loss', 'csv-loss', 'tradingview-win', 'csv-win'], total: '+$9.00' },
    Wins: { ids: ['pro-win', 'manual-win', 'tradingview-win', 'csv-win'], total: '+$180.00' },
    Losses: { ids: ['tradingview-loss', 'csv-loss', 'manual-loss'], total: '$-56.00' },
    Breakeven: { ids: ['pro-breakeven'], total: '+$0.00' },
    Breakout: { ids: ['manual-win', 'csv-win'], total: '+$145.00' },
    Momentum: { ids: ['tradingview-loss', 'tradingview-win'], total: '+$29.00' },
    July: { ids: ['manual-win', 'csv-loss', 'manual-loss'], total: '+$65.00' },
    '2026': { ids: ['manual-win', 'csv-loss', 'manual-loss', 'pro-breakeven'], total: '+$65.00' },
    'Week 1': { ids: ['manual-loss', 'pro-breakeven'], total: '$-10.00' },
    Monday: { ids: ['manual-win'], total: '+$120.00' },
    'London Session': { ids: ['tradingview-loss', 'manual-win'], total: '+$119.00' },
  },
  dates: {
    from: { ids: ['tradingview-loss', 'pro-win', 'manual-win', 'csv-loss', 'manual-loss'], total: '+$69.00' },
    to: { ids: ['csv-loss', 'manual-loss', 'pro-breakeven', 'tradingview-win', 'csv-win'], total: '+$0.00' },
    range: { ids: ['csv-loss', 'manual-loss'], total: '$-55.00' },
  },
  sorts: {
    'Newest First': initialIds,
    'Oldest First': [...initialIds].reverse(),
    'Highest P&L': ['manual-win', 'tradingview-win', 'csv-win', 'pro-win', 'pro-breakeven', 'tradingview-loss', 'manual-loss', 'csv-loss'],
    'Lowest P&L': ['csv-loss', 'manual-loss', 'tradingview-loss', 'pro-breakeven', 'pro-win', 'csv-win', 'tradingview-win', 'manual-win'],
    'By Pair': ['manual-loss', 'tradingview-loss', 'csv-win', 'manual-win', 'pro-win', 'csv-loss', 'pro-breakeven', 'tradingview-win'],
  },
}

async function freshHistory(client) {
  await client.evaluate(`window.__tradeHistoryFixture.navigate('/')`)
  await waitForPage(client, `location.pathname === '/' && document.body.innerText.includes('Recent Trades')`)
  await client.evaluate(`window.__tradeHistoryFixture.navigate('/history')`)
  await waitForPage(client, `location.pathname === '/history' && document.body.innerText.includes('Trade History')`)
  await delay(80)
}

async function summaryAfter(client, expression) {
  await freshHistory(client)
  if (expression) await client.evaluate(expression)
  await delay(100)
  return client.evaluate('window.__tradeHistoryFixture.historySummary()')
}

function assertSummary(actual, expected, label) {
  assert.deepEqual(actual.ids, expected.ids, `${label} identities/order changed`)
  assert.equal(actual.count, expected.ids.length, `${label} count changed`)
  assert.equal(actual.collectionCount, allIds.length, `${label} source collection count changed`)
  assert.equal(actual.total, expected.total, `${label} total changed`)
}

test('Property 2: Preservation — canonical Trade History and navigation behavior', { timeout: 180_000 }, async () => {
  const harness = await startBrowserHarness('preservation')
  const report = {
    property: 'Property 2: Preservation — Canonical Trade History and Navigation Behavior',
    expectedResultOnUnfixedApplication: 'PASS',
    seed: preservationSeed,
    canonicalOrigins: ['manual', 'csv_import', 'pro_trading', 'tradingview_extension'],
    observations: {},
  }

  try {
    const url = `http://127.0.0.1:${harness.vitePort}${fixturePath}?case=preservation`
    await harness.client.send('Page.navigate', { url })
    await waitForPage(harness.client, `Boolean(window.__tradeHistoryFixture?.ready && window.__tradeHistoryFixture.scenarioName === 'preservation')`)

    const dashboard = await harness.client.evaluate('window.__tradeHistoryFixture.dashboardSnapshot()')
    assert.equal(dashboard.recentRowCount, 7)
    assert.equal(dashboard.viewAllVisible, true)
    assert.deepEqual(await harness.client.evaluate('window.__tradeHistoryFixture.contextCalls()'), [], 'Dashboard render invoked persistence')
    await harness.client.evaluate('window.__tradeHistoryFixture.clickViewAll()')
    await waitForPage(harness.client, `location.pathname === '/history' && document.body.innerText.includes('Trade History')`)

    const initial = await harness.client.evaluate('window.__tradeHistoryFixture.historySnapshot()')
    report.observations.initial = initial
    assert.equal(initial.applicationShellVisible, true)
    assert.equal(initial.tradeHistoryVisible, true)
    assertSummary(initial.summary, { ids: initialIds, total: '+$124.00' }, 'initial history')
    assert.deepEqual(initial.rows.map(row => row.editTarget), initialIds.map(id => `/edit-trade/${id}`))
    assert.deepEqual(initial.rows.find(row => row.id === 'manual-win'), {
      id: 'manual-win',
      date: { calendarDate: '2026-07-20', time: '09:30' },
      pair: 'BTC/USDT',
      type: 'LONG',
      entry: '$100',
      exit: '$112',
      quantity: '10',
      pnl: { amount: '+$120.00', percent: '+12%' },
      strategy: 'Breakout',
      rating: '⭐⭐⭐⭐⭐',
      editTarget: '/edit-trade/manual-win',
    })
    assert.deepEqual(initial.rows.find(row => row.id === 'pro-breakeven'), {
      id: 'pro-breakeven',
      date: { calendarDate: '2026-06-07', time: '08:00' },
      pair: 'SOL/USDT',
      type: 'LONG',
      entry: '$50',
      exit: '$50',
      quantity: '2',
      pnl: { amount: '+$0.000', percent: null },
      strategy: '-',
      rating: '⭐⭐⭐',
      editTarget: '/edit-trade/pro-breakeven',
    })
    assert.deepEqual(await harness.client.evaluate('window.__tradeHistoryFixture.contextCalls()'), [], 'History render invoked persistence')
    assert.equal(await harness.client.evaluate('window.__tradeHistoryFixture.rawTradesUnchanged()'), true, 'History render mutated raw Firestore-shaped records')

    report.observations.searches = {}
    for (const [query, expected] of Object.entries(expectedControls.searches)) {
      const actual = await summaryAfter(harness.client, `window.__tradeHistoryFixture.setSearch(${JSON.stringify(query)})`)
      assertSummary(actual, expected, `search ${query}`)
      report.observations.searches[query] = actual
    }

    report.observations.filters = {}
    for (const [label, expected] of Object.entries(expectedControls.filters)) {
      const actual = await summaryAfter(harness.client, `window.__tradeHistoryFixture.setSelectLabel(${JSON.stringify(label)})`)
      assertSummary(actual, expected, `filter ${label}`)
      report.observations.filters[label] = actual
    }

    report.observations.dates = {}
    report.observations.dates.from = await summaryAfter(harness.client, `window.__tradeHistoryFixture.setDateFilter('From Date', '2026-07-01')`)
    assertSummary(report.observations.dates.from, expectedControls.dates.from, 'from-date filter')
    report.observations.dates.to = await summaryAfter(harness.client, `window.__tradeHistoryFixture.setDateFilter('To Date', '2026-07-14')`)
    assertSummary(report.observations.dates.to, expectedControls.dates.to, 'to-date filter')
    await freshHistory(harness.client)
    await harness.client.evaluate(`window.__tradeHistoryFixture.setDateFilter('From Date', '2026-07-02'); window.__tradeHistoryFixture.setDateFilter('To Date', '2026-07-14')`)
    await delay(100)
    report.observations.dates.range = await harness.client.evaluate('window.__tradeHistoryFixture.historySummary()')
    assertSummary(report.observations.dates.range, expectedControls.dates.range, 'date-range filter')

    report.observations.sorts = {}
    for (const [label, ids] of Object.entries(expectedControls.sorts)) {
      const actual = await summaryAfter(harness.client, label === 'Newest First' ? null : `window.__tradeHistoryFixture.setSelectLabel(${JSON.stringify(label)})`)
      assertSummary(actual, { ids, total: '+$124.00' }, `sort ${label}`)
      report.observations.sorts[label] = actual
    }

    await freshHistory(harness.client)
    await harness.client.evaluate(`window.__tradeHistoryFixture.viewTrade('manual-win')`)
    await delay(80)
    const detail = await harness.client.evaluate('window.__tradeHistoryFixture.detailSnapshot()')
    report.observations.detail = detail
    assert.deepEqual(detail, {
      fields: {
        Type: 'LONG',
        'P&L': '$120',
        'Entry Price': '$100',
        'Exit Price': '$112',
        Quantity: '10',
        Leverage: '1x',
        Date: '2026-07-20',
        Strategy: 'Breakout',
        Timeframe: '1h',
        Emotion: 'calm',
      },
      notes: 'Manual breakout at resistance',
    })

    await freshHistory(harness.client)
    await harness.client.evaluate('window.__tradeHistoryFixture.clearContextCalls()')
    await harness.client.evaluate(`window.__tradeHistoryFixture.deleteTrade('csv-loss')`)
    await delay(50)
    assert.deepEqual(await harness.client.evaluate('window.__tradeHistoryFixture.contextCalls()'), [{ method: 'deleteTrade', args: ['csv-loss'] }])
    assert.deepEqual(await harness.client.evaluate('window.__tradeHistoryConfirmations'), ['Delete trade for ETH/USDT?'])

    await harness.client.evaluate('window.__tradeHistoryFixture.clearContextCalls(); window.__tradeHistoryFixture.clearAll()')
    await delay(50)
    assert.match(await harness.client.evaluate('document.body.innerText'), /permanently delete all 8 trades/)
    await harness.client.evaluate('window.__tradeHistoryFixture.confirmClearAll()')
    await delay(50)
    assert.deepEqual(await harness.client.evaluate('window.__tradeHistoryFixture.contextCalls()'), [{ method: 'deleteAllTrades', args: [] }])

    await freshHistory(harness.client)
    await harness.client.evaluate('window.__tradeHistoryFixture.exportCsv()')
    await delay(50)
    const exported = await harness.client.evaluate('window.__tradeHistoryFixture.exportSnapshot()')
    report.observations.export = exported
    assert.equal(exported.downloads.length, 1)
    assert.match(exported.downloads[0].download, /^vivek-trades-\d{4}-\d{2}-\d{2}\.csv$/)
    assert.match(exported.csv, /^Date,Pair,Type,Entry,Exit,Qty,Leverage,P&L,Strategy,Fees,Notes\n/)
    assert.equal(exported.csv.trim().split('\n').length, 9)
    assert.match(exported.csv, /2026-07-20,BTC\/USDT,long,100,112,10,1,120,Breakout,0,"Manual breakout at resistance"/)

    await harness.client.evaluate('window.__tradeHistoryFixture.clearContextCalls(); window.__tradeHistoryFixture.toggleImport()')
    await delay(80)
    assert.match(await harness.client.evaluate('document.body.innerText'), /Import Trading History CSV/)
    await harness.client.evaluate('window.__tradeHistoryFixture.importCanonicalCsv()')
    await waitForPage(harness.client, `window.__tradeHistoryFixture.contextCalls().some(call => call.method === 'importTrades')`)
    const importCall = await harness.client.evaluate(`window.__tradeHistoryFixture.contextCalls().find(call => call.method === 'importTrades')`)
    assert.match(importCall.args[0], /Trading Pair,Direction,Entry Price/)

    await harness.client.evaluate(`window.__tradeHistoryFixture.navigate(${JSON.stringify(fixturePath)})`)
    await waitForPage(harness.client, `location.pathname === ${JSON.stringify(fixturePath)} && document.body.innerText.includes('Recent Trades')`)
    await harness.client.evaluate('window.__tradeHistoryFixture.clickViewAll()')
    await waitForPage(harness.client, `location.pathname === '/history'`)
    await harness.client.evaluate(`window.__tradeHistoryFixture.clickEdit('manual-win')`)
    await waitForPage(harness.client, `location.pathname === '/edit-trade/manual-win' && document.body.innerText.includes('Edit Trade')`)
    const backToHistory = await harness.client.evaluate('window.__tradeHistoryFixture.back()')
    const backToDashboard = await harness.client.evaluate('window.__tradeHistoryFixture.back()')
    const forwardToHistory = await harness.client.evaluate('window.__tradeHistoryFixture.forward()')
    const forwardToEdit = await harness.client.evaluate('window.__tradeHistoryFixture.forward()')
    report.observations.browserHistory = { backToHistory, backToDashboard, forwardToHistory, forwardToEdit }
    assert.deepEqual(report.observations.browserHistory, {
      backToHistory: '/history',
      backToDashboard: fixturePath,
      forwardToHistory: '/history',
      forwardToEdit: '/edit-trade/manual-win',
    })

    await harness.client.evaluate(`window.__tradeHistoryFixture.navigate('/')`)
    await waitForPage(harness.client, `location.pathname === '/'`)
    await harness.client.evaluate(`window.__tradeHistoryFixture.clickSidebar('Trade History')`)
    await waitForPage(harness.client, `location.pathname === '/history'`)
    await harness.client.evaluate(`window.__tradeHistoryFixture.clickSidebar('Add Trade')`)
    await waitForPage(harness.client, `location.pathname === '/add-trade' && document.body.innerText.includes('Add New Trade')`)
    await harness.client.evaluate('window.__tradeHistoryFixture.clearContextCalls()')
    await harness.client.evaluate('window.__tradeHistoryFixture.fillAndSaveAddTrade()')
    await waitForPage(harness.client, `location.pathname === '/history'`)
    const addCall = await harness.client.evaluate(`window.__tradeHistoryFixture.contextCalls().find(call => call.method === 'addTrade')`)
    assert.equal(addCall.args[0].pair, 'BTC/USDT')
    assert.equal(addCall.args[0].entryPrice, '100')

    assert.equal(await harness.client.evaluate('window.__tradeHistoryFixture.rawTradesUnchanged()'), true, 'Actions mutated the supplied raw records')

    harness.client.events.length = 0
    await harness.client.evaluate(`window.__tradeHistoryFixture.navigate('/boundary-probe')`)
    await waitForPage(harness.client, `document.body.innerText.includes('Something went wrong')`)
    await delay(100)
    const boundary = await harness.client.evaluate('window.__tradeHistoryFixture.boundarySnapshot()')
    const diagnostics = summarizeEvents(harness.client.events)
    report.observations.boundary = { ...boundary, diagnostics }
    assert.deepEqual(boundary, {
      path: '/boundary-probe',
      headingVisible: true,
      messageVisible: true,
      controls: ['Reload App', 'Try Again'],
    })
    assert.equal(diagnostics.some(event => event.kind === 'console-error' && event.text.includes('React Error Boundary caught:')), true)
    assert.equal(diagnostics.some(event => event.text.includes('Synthetic unrelated child render failure')), true)

    report.status = 'passed'
  } finally {
    await stopBrowserHarness(harness)
  }

  const artifactDirectory = path.join(testDirectory, 'artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  const reportPath = path.join(artifactDirectory, 'preservation-report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  assert.equal(report.status, 'passed', `Preservation report was not completed: ${path.relative(repositoryRoot, reportPath)}`)
})
