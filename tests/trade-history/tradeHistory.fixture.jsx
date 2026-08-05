import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from '../../src/components/Layout.jsx'
import Dashboard from '../../src/pages/Dashboard.jsx'
import AddTrade from '../../src/pages/AddTrade.jsx'
import TradeHistory from '../../src/pages/TradeHistory.jsx'
import { getScenario, isBugCondition, scenarioNames } from './tradeHistoryCases.js'
import { getPreservationScenario } from './tradeHistoryPreservationCases.js'

const fixturePath = '/tests/trade-history/tradeHistory.fixture.html'
const scenarioName = new URLSearchParams(location.search).get('case') || 'primary'
const scenario = scenarioName === 'preservation' ? getPreservationScenario() : getScenario(scenarioName)
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

localStorage.removeItem('vmt_custom_strategies')
localStorage.removeItem('vmt_custom_sessions')
for (const [key, value] of Object.entries(scenario.storage)) localStorage.setItem(key, value)
window.__tradeHistoryScenario = scenario
window.__tradeHistoryContextCalls = []
window.__tradeHistoryConfirmations = []
window.__tradeHistoryRawBaseline = JSON.stringify(scenario.trades)
window.confirm = message => {
  window.__tradeHistoryConfirmations.push(message)
  return true
}

const originalAnchorClick = HTMLAnchorElement.prototype.click
const originalCreateObjectURL = URL.createObjectURL.bind(URL)
const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL)
window.__tradeHistoryDownloads = []
window.__tradeHistoryExportBlob = null
URL.createObjectURL = blob => {
  window.__tradeHistoryExportBlob = blob
  return originalCreateObjectURL(blob)
}
URL.revokeObjectURL = url => originalRevokeObjectURL(url)
HTMLAnchorElement.prototype.click = function click() {
  if (this.download) {
    window.__tradeHistoryDownloads.push({ download: this.download, href: this.href })
    return
  }
  return originalAnchorClick.call(this)
}

function SyntheticRenderError() {
  throw new Error('Synthetic unrelated child render failure')
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
  element.dispatchEvent(new Event('change', { bubbles: true }))
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function semanticText(element) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() || ''
}

function textWithout(element, selector) {
  const clone = element.cloneNode(true)
  clone.querySelectorAll(selector).forEach(node => node.remove())
  return semanticText(clone)
}

function observedCalendarDate(cell, trade) {
  const observed = textWithout(cell, 'span')
  if (!trade?.date) return observed
  return observed === new Date(trade.date).toLocaleDateString() ? trade.date : observed
}

function rowObservation(row) {
  const cells = [...row.querySelectorAll('td')]
  const edit = row.querySelector('a[href^="/edit-trade/"]')
  const id = edit ? decodeURIComponent(edit.getAttribute('href').slice('/edit-trade/'.length)) : null
  const trade = scenario.trades.find(candidate => candidate.id === id)
  return {
    id,
    date: {
      calendarDate: observedCalendarDate(cells[0], trade),
      time: semanticText(cells[0]?.querySelector('span')) || null,
    },
    pair: semanticText(cells[1]),
    type: semanticText(cells[2]),
    entry: semanticText(cells[3]),
    exit: semanticText(cells[4]),
    quantity: semanticText(cells[5]),
    pnl: {
      amount: textWithout(cells[6], 'span'),
      percent: semanticText(cells[6]?.querySelector('span')) || null,
    },
    strategy: semanticText(cells[7]),
    rating: semanticText(cells[8]),
    editTarget: edit?.getAttribute('href') || null,
  }
}

function historyRows() {
  return [...document.querySelectorAll('tbody tr')]
    .map(rowObservation)
    .filter(row => row.id)
}

function historySummary() {
  const text = document.body.innerText
  const showing = text.match(/Showing\s+(\d+)\s+of\s+(\d+)\s+trades/)
  const total = text.match(/Total P&L:\s*([^\n]+)/)
  return {
    ids: historyRows().map(row => row.id),
    count: showing ? Number(showing[1]) : 0,
    collectionCount: showing ? Number(showing[2]) : scenario.trades.length,
    total: total?.[1]?.trim() || null,
    empty: text.includes('No trades found'),
  }
}

function selectWithValue(value) {
  return [...document.querySelectorAll('select')].find(select =>
    [...select.options].some(option => option.value === value),
  )
}

function routeTo(path) {
  history.pushState({}, '', path)
  dispatchEvent(new PopStateEvent('popstate'))
}

async function traverseHistory(method) {
  const startingHref = location.href
  history[method]()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await nextFrame()
    if (location.href !== startingHref) return location.pathname
  }
  return location.pathname
}

const fixtureApi = {
  ready: false,
  scenarioName,
  scenarioNames: [...scenarioNames, 'preservation'],
  seed: scenario.seed,
  input: {
    userIsAuthenticated: scenario.userIsAuthenticated,
    navigationTarget: scenario.navigationTarget,
    trades: scenario.trades,
  },
  expectedIdentities: scenario.trades.map(trade => trade.id),
  isBugCondition: scenarioName === 'preservation' ? false : isBugCondition(scenario),
  contextCalls() { return structuredClone(window.__tradeHistoryContextCalls) },
  clearContextCalls() { window.__tradeHistoryContextCalls.length = 0 },
  rawTradesUnchanged() { return JSON.stringify(scenario.trades) === window.__tradeHistoryRawBaseline },
  navigate(path) { routeTo(path) },
  back() { return traverseHistory('back') },
  forward() { return traverseHistory('forward') },
  dashboardSnapshot() {
    const rows = [...document.querySelectorAll('tbody tr')]
    const viewAll = [...document.querySelectorAll('a[href="/history"]')]
      .find(link => link.textContent.includes('View All'))
    return {
      path: location.pathname,
      recentTradesVisible: document.body.innerText.includes('Recent Trades'),
      recentRowCount: rows.length,
      recentPairs: rows.map(row => row.querySelector('td')?.textContent?.trim()),
      viewAllVisible: Boolean(viewAll),
    }
  },
  clickViewAll() {
    const link = [...document.querySelectorAll('a[href="/history"]')]
      .find(candidate => candidate.textContent.includes('View All'))
    if (!link) throw new Error('Dashboard View All link was not found')
    link.click()
  },
  clickSidebar(label) {
    const link = [...document.querySelectorAll('nav a')].find(candidate => candidate.textContent.includes(label))
    if (!link) throw new Error(`Sidebar link was not found: ${label}`)
    link.click()
  },
  historyRows,
  historySummary,
  historySnapshot() {
    const bodyText = document.body.innerText
    return {
      path: location.pathname,
      rows: historyRows(),
      summary: historySummary(),
      strategyOptions: [...(selectWithValue('Breakout')?.options || [])].map(option => ({ value: option.value, label: option.textContent })),
      controls: [...document.querySelectorAll('select')].map(select => select.value),
      applicationShellVisible: bodyText.includes('Vivek Marco'),
      tradeHistoryVisible: bodyText.includes('Trade History'),
    }
  },
  setSearch(value) {
    setNativeValue(document.querySelector('input[placeholder="Search pair, strategy, notes..."]'), value)
  },
  setSelect(value) {
    const select = selectWithValue(value)
    if (!select) throw new Error(`No select contains value: ${value}`)
    setNativeValue(select, value)
  },
  setSelectLabel(label) {
    for (const select of document.querySelectorAll('select')) {
      const option = [...select.options].find(candidate => candidate.textContent.trim() === label)
      if (option) {
        setNativeValue(select, option.value)
        return
      }
    }
    throw new Error(`No select contains label: ${label}`)
  },
  resetSelect(value) {
    const select = [...document.querySelectorAll('select')].find(candidate => candidate.value === value)
    if (!select) throw new Error(`No select currently has value: ${value}`)
    setNativeValue(select, 'all')
  },
  setDateFilter(label, value) {
    const labels = [...document.querySelectorAll('label')]
    const labelNode = labels.find(candidate => candidate.textContent.trim() === label)
    const input = labelNode?.parentElement?.querySelector('input[type="date"]')
    if (!input) throw new Error(`Date filter was not found: ${label}`)
    setNativeValue(input, value)
  },
  viewTrade(id) {
    window.__tradeHistoryViewedId = id
    const row = [...document.querySelectorAll('tbody tr')].find(candidate => candidate.querySelector(`a[href="/edit-trade/${id}"]`))
    row?.querySelector('button[title="View"]')?.click()
  },
  detailSnapshot() {
    const heading = [...document.querySelectorAll('h3')].find(node => node.closest('.fixed'))
    const modal = heading?.closest('.fixed')
    if (!modal) return null

    const fields = Object.fromEntries(
      [...modal.querySelectorAll('.grid > div')].map(card => {
        const [label, value] = card.querySelectorAll('p')
        return [semanticText(label), semanticText(value)]
      }),
    )
    const trade = scenario.trades.find(candidate => candidate.id === window.__tradeHistoryViewedId)
    if (trade?.date && fields.Date === new Date(trade.date).toLocaleDateString()) fields.Date = trade.date

    const notesLabel = [...modal.querySelectorAll('p')].find(node => semanticText(node) === 'Notes')
    return {
      fields,
      notes: semanticText(notesLabel?.nextElementSibling) || null,
    }
  },
  clickEdit(id) {
    document.querySelector(`a[href="/edit-trade/${id}"]`)?.click()
  },
  deleteTrade(id) {
    const row = [...document.querySelectorAll('tbody tr')].find(candidate => candidate.querySelector(`a[href="/edit-trade/${id}"]`))
    row?.querySelector('button[title="Delete"]')?.click()
  },
  clearAll() {
    const clear = [...document.querySelectorAll('button')].find(button => button.textContent.includes('Clear All'))
    clear?.click()
  },
  confirmClearAll() {
    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Delete All')
    confirm?.click()
  },
  exportCsv() {
    const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent.includes('Export CSV'))
    button?.click()
  },
  async exportSnapshot() {
    return {
      downloads: structuredClone(window.__tradeHistoryDownloads),
      csv: window.__tradeHistoryExportBlob ? await window.__tradeHistoryExportBlob.text() : null,
    }
  },
  toggleImport() {
    const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent.includes('Import CSV'))
    button?.click()
  },
  async importCanonicalCsv() {
    const input = document.querySelector('input[type="file"][accept=".csv,.txt"]')
    if (!input) throw new Error('CSV file input is not visible')
    const csv = 'Trading Pair,Direction,Entry Price,Exit Price,Quantity,Date\nBTC/USDT,Long,100,110,1,2026-07-20'
    const file = new File([csv], 'canonical.csv', { type: 'text/csv' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  },
  async fillAndSaveAddTrade() {
    setNativeValue(document.querySelector('select[name="pair"]'), 'BTC/USDT')
    setNativeValue(document.querySelector('input[name="entryPrice"]'), '100')
    setNativeValue(document.querySelector('input[name="exitPrice"]'), '110')
    setNativeValue(document.querySelector('input[name="quantity"]'), '1')
    await nextFrame()
    document.querySelector('form button[type="submit"]').click()
  },
  boundarySnapshot() {
    const bodyText = document.body.innerText
    const heading = [...document.querySelectorAll('h2')]
      .find(node => semanticText(node) === 'Something went wrong')
    const boundaryCard = heading?.parentElement
    return {
      path: location.pathname,
      headingVisible: Boolean(heading),
      messageVisible: bodyText.includes('Synthetic unrelated child render failure'),
      controls: [...(boundaryCard?.querySelectorAll('button') || [])].map(button => button.textContent.trim()),
    }
  },
  routeSnapshot() {
    const editIdentities = [...document.querySelectorAll('a[href^="/edit-trade/"]')]
      .map(link => decodeURIComponent(link.getAttribute('href').slice('/edit-trade/'.length)))
    const bodyText = document.body?.innerText || ''
    const historyHeading = [...document.querySelectorAll('h1')].some(node => node.textContent.includes('Trade History'))
    const boundaryHeading = [...document.querySelectorAll('h2')].some(node => node.textContent.includes('Something went wrong'))
    return {
      url: location.href,
      path: location.pathname,
      applicationShellVisible: bodyText.includes('Vivek Marco') && bodyText.includes('Dashboard'),
      tradeHistoryVisible: historyHeading,
      errorBoundaryActivated: boundaryHeading,
      boundaryMessage: boundaryHeading ? [...document.querySelectorAll('h2')].find(node => node.textContent.includes('Something went wrong'))?.parentElement?.innerText : null,
      representedIdentities: editIdentities,
      allInputTradeIdentitiesRepresented: scenario.trades.every(trade => editIdentities.includes(trade.id)),
      invalidFieldsUseStableFallbacks: scenario.trades.every(trade => trade.type === 'long' || trade.type === 'short') || /Unknown|—/.test(bodyText),
      bodyText: bodyText.slice(0, 4000),
      bodyHtml: document.body?.innerHTML?.slice(0, 8000),
    }
  },
}
window.__tradeHistoryFixture = fixtureApi

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route element={<Layout />}>
        <Route path={fixturePath} element={<Dashboard />} />
        <Route path="/" element={<Dashboard />} />
        <Route path="/history" element={<TradeHistory />} />
        <Route path="/add-trade" element={<AddTrade />} />
        <Route path="/edit-trade/:id" element={<AddTrade />} />
        <Route path="/boundary-probe" element={<SyntheticRenderError />} />
      </Route>
    </Routes>
  </BrowserRouter>,
)

requestAnimationFrame(() => requestAnimationFrame(() => { fixtureApi.ready = true }))
