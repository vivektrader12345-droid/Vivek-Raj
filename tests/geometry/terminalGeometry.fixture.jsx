import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ProTrading from '../../src/trading/ProTrading'
import useChartStore from '../../src/trading/stores/chartStore'
import useSettingsStore from '../../src/trading/stores/settingsStore'
import useTradingStore from '../../src/trading/stores/tradingStore'
import '../../src/index.css'

const BASE_TIME = 1_720_000_000
const BASE_PRICE = 65_000
const candles = Array.from({ length: 240 }, (_, index) => {
  const open = BASE_PRICE + Math.sin(index / 8) * 900 + index * 2
  const close = open + Math.cos(index / 5) * 180
  return {
    time: BASE_TIME + index * 60,
    open,
    high: Math.max(open, close) + 120,
    low: Math.min(open, close) - 120,
    close,
    volume: 1_000 + index * 11,
  }
})
const klines = candles.map(candle => [
  candle.time * 1000,
  String(candle.open),
  String(candle.high),
  String(candle.low),
  String(candle.close),
  String(candle.volume),
])

const marketRequests = []
const nativeFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || ''
  if (url.includes('binance.com')) marketRequests.push({ type: 'fetch', url, method: init?.method || 'GET' })
  if (url.startsWith('https://api.binance.com/api/v3/klines')) {
    return Promise.resolve(new Response(JSON.stringify(klines), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
  }
  return nativeFetch(input, init)
}

const NativeWebSocket = window.WebSocket
class BinanceSocketStub {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url) {
    this.url = url
    marketRequests.push({ type: 'websocket', url: String(url), method: 'CONNECT' })
    this.readyState = BinanceSocketStub.CONNECTING
    queueMicrotask(() => {
      if (this.readyState !== BinanceSocketStub.CONNECTING) return
      this.readyState = BinanceSocketStub.OPEN
      this.onopen?.({ type: 'open' })
    })
  }

  close() {
    this.readyState = BinanceSocketStub.CLOSED
    this.onclose?.({ type: 'close' })
  }

  send() {}
  addEventListener(type, handler) { this[`on${type}`] = handler }
  removeEventListener(type, handler) {
    if (this[`on${type}`] === handler) this[`on${type}`] = null
  }
}

function FixtureWebSocket(url, protocols) {
  if (String(url).startsWith('wss://stream.binance.com')) return new BinanceSocketStub(url)
  return new NativeWebSocket(url, protocols)
}
Object.assign(FixtureWebSocket, {
  CONNECTING: NativeWebSocket.CONNECTING,
  OPEN: NativeWebSocket.OPEN,
  CLOSING: NativeWebSocket.CLOSING,
  CLOSED: NativeWebSocket.CLOSED,
})
window.WebSocket = FixtureWebSocket

const defaultAccount = {
  balance: 100_000,
  availableMargin: 100_000,
  usedMargin: 0,
  walletBalance: 100_000,
  dailyPnl: 0,
  totalPnl: 0,
  winRate: 0,
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
}

const placeOrderCalls = []
const originalPlaceOrder = useTradingStore.getState().placeOrder
useTradingStore.setState({
  placeOrder: order => {
    placeOrderCalls.push(order)
    return originalPlaceOrder(order)
  },
})

const position = {
  id: 'geometry-position',
  symbol: 'BTC/USDT',
  side: 'buy',
  status: 'open',
  qty: 2.75,
  entryPrice: 64_500,
  currentPrice: BASE_PRICE,
  markPrice: BASE_PRICE,
  leverage: 25,
  margin: 7_095,
  stopLoss: 62_200,
  takeProfit: 68_900,
  liquidationPrice: 59_000,
  fee: 12.4,
  totalFees: 12.4,
  unrealizedPnl: 1_375,
  roi: 19.38,
  openedAt: Date.now() - 3_600_000,
}

const pendingOrder = {
  id: 'geometry-pending-order',
  symbol: 'BTC/USDT',
  side: 'sell',
  type: 'limit',
  status: 'pending',
  qty: 4.125,
  price: 67_400,
  limitPrice: 67_400,
  leverage: 20,
  margin: 13_901.25,
  fee: 11.12,
  stopLoss: 69_200,
  takeProfit: 63_100,
  createdAt: Date.now() - 900_000,
}

const waitForPaint = (frames = 3) => new Promise(resolve => {
  const next = remaining => requestAnimationFrame(() => remaining <= 1 ? resolve() : next(remaining - 1))
  next(frames)
})

function clickElement(element) {
  if (!element) return false
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  return true
}

function clickByTitle(title) {
  return clickElement([...document.querySelectorAll('button')].find(button => button.title === title))
}

async function resetScenario() {
  placeOrderCalls.length = 0
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  useSettingsStore.setState({
    theme: 'dark',
    chartStyle: 'candles',
    showSidebar: true,
    showOrderPanel: true,
    showConfirmation: true,
    showGrid: true,
    showCrosshair: true,
    showVolume: true,
  })
  useChartStore.setState({
    symbol: 'BTCUSDT',
    symbolDisplay: 'BTC/USDT',
    timeframe: '1m',
    candles,
    currentCandle: candles.at(-1),
    isLoading: false,
    wsConnected: true,
    activeIndicators: ['volume'],
    activeDrawingTool: null,
    drawings: [],
  })
  useTradingStore.setState({
    positions: [],
    pendingOrders: [],
    trades: [],
    account: defaultAccount,
    currentPrice: BASE_PRICE,
    markPrice: BASE_PRICE,
    lastTickTime: Date.now(),
  })
  await waitForPaint()
  if (document.querySelector('.pro-terminal__left-rail[data-collapsed="true"]')) clickByTitle('Expand drawing rail')
  if (document.querySelector('.pro-terminal__right-rail[data-collapsed="true"]')) clickByTitle('Expand action rail')
  const responsiveDrawer = document.querySelector('.pro-terminal-responsive-rail-drawer')
  if (responsiveDrawer) clickElement(responsiveDrawer.querySelector('button[aria-label^="Close"]'))
  const dock = document.querySelector('.trading-dock')
  if (dock && !dock.classList.contains('trading-dock--collapsed')) {
    clickElement(dock.querySelector(':scope > div:first-child > div:last-child button'))
  }
  await waitForPaint()
}

async function setQuoteState(status) {
  await resetScenario()
  if (status === 'current') {
    useChartStore.setState({ wsConnected: true, candles, currentCandle: candles.at(-1) })
    useTradingStore.setState({ currentPrice: BASE_PRICE, markPrice: BASE_PRICE, lastTickTime: Date.now() })
  } else if (status === 'stale') {
    useChartStore.setState({ wsConnected: true, candles, currentCandle: candles.at(-1) })
    useTradingStore.setState({ currentPrice: BASE_PRICE, markPrice: BASE_PRICE, lastTickTime: Date.now() - 11_000 })
  } else if (status === 'unavailable') {
    useChartStore.setState({ wsConnected: false, candles: [], currentCandle: null })
    useTradingStore.setState({ currentPrice: 0, markPrice: 0, lastTickTime: 0 })
  } else {
    throw new Error(`Unknown quote state: ${status}`)
  }
  await waitForPaint(5)
}

async function applyScenario(name) {
  await resetScenario()

  if (name === 'menu-open-near-edge') {
    const chartRegion = document.querySelector('.drawing-toolbar')?.parentElement
    const rect = chartRegion?.getBoundingClientRect()
    chartRegion?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.max(rect?.left || 0, (rect?.right || window.innerWidth) - 1),
      clientY: Math.max(rect?.top || 0, (rect?.bottom || window.innerHeight) - 1),
    }))
  } else if (name === 'rails-collapsed') {
    clickByTitle('Collapse drawing rail')
    clickByTitle('Collapse action rail')
    useSettingsStore.setState({ showSidebar: false })
  } else if (name === 'rails-expanded') {
    useSettingsStore.setState({ showSidebar: true })
  } else if (name === 'dock-expanded') {
    clickElement([...document.querySelectorAll('.dock-tab')].find(tab => tab.textContent.includes('Positions')))
  } else if (name === 'dock-collapsed') {
    // resetScenario establishes the collapsed dock.
  } else if (name === 'paper-order-open') {
    clickElement(document.querySelector('.quick-quote__side--buy'))
  } else if (name === 'order-overlays-present') {
    useTradingStore.setState({
      positions: [position],
      pendingOrders: [pendingOrder],
      account: {
        ...defaultAccount,
        availableMargin: 79_003.75,
        usedMargin: 7_095,
      },
    })
  } else if (name === 'stale-error-state') {
    useChartStore.setState({ candles: [], currentCandle: null, wsConnected: false, isLoading: false })
  } else if (name === 'maximum-label-state') {
    useChartStore.setState({
      symbol: 'PAXGUSDT',
      symbolDisplay: 'EXTREMELY-LONG-MARKET-LABEL/USDT',
      timeframe: '1M',
      candles,
      currentCandle: candles.at(-1),
      wsConnected: false,
      activeIndicators: ['volume', 'ema', 'vwap', 'rsi', 'macd', 'bollinger', 'atr', 'supertrend'],
    })
    useTradingStore.setState({
      positions: [{ ...position, symbol: 'EXTREMELY-LONG-MARKET-LABEL/USDT', qty: 99_999.9999 }],
      pendingOrders: [{ ...pendingOrder, symbol: 'EXTREMELY-LONG-MARKET-LABEL/USDT', qty: 99_999.9999 }],
      account: {
        ...defaultAccount,
        balance: 9_999_999_999.99,
        availableMargin: 8_888_888_888.88,
        usedMargin: 1_111_111_111.11,
      },
    })
  }

  await waitForPaint(5)
}

const rounded = number => Math.round(number * 100) / 100
const rectOf = element => {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return {
    left: rounded(rect.left),
    top: rounded(rect.top),
    right: rounded(rect.right),
    bottom: rounded(rect.bottom),
    width: rounded(rect.width),
    height: rounded(rect.height),
  }
}

const isRendered = element => {
  if (!element) return false
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
}

const elementName = (element, index) => {
  const text = (element.getAttribute('aria-label') || element.title || element.textContent || element.tagName)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
  return `control:${text || element.tagName.toLowerCase()}:${index}`
}

const overlap = (a, b) => a && b && a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5

function collectSnapshot(state) {
  const root = document.querySelector('.pro-terminal')
  const header = document.querySelector('.terminal-topbar')
  const headerRows = header ? [...header.children].filter(isRendered) : []
  const chartRoot = document.querySelector('.pro-terminal .relative.h-full.w-full.overflow-hidden')
  const leftRailElement = document.querySelector('.pro-terminal__left-rail')
  const rightSidebarElement = document.querySelector('.pro-terminal__right-rail')
  const dockElement = document.querySelector('.trading-dock')
  const ohlcElement = chartRoot?.querySelector(':scope > .pointer-events-none.absolute.left-16.top-3')
  const quoteElement = document.querySelector('.quick-quote')
  const rangeElement = document.querySelector('.chart-range-bar')

  const chartRect = rectOf(chartRoot) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  const canvasRects = [...(chartRoot?.querySelectorAll('canvas') || [])].filter(isRendered).map(rectOf)
  const priceScaleRect = canvasRects.find(rect => rect.width < chartRect.width * 0.25 && rect.height > chartRect.height * 0.45 && rect.right >= chartRect.right - 2) || null
  const timeScaleRect = canvasRects.find(rect => rect.height < chartRect.height * 0.25 && rect.width > chartRect.width * 0.45 && rect.bottom >= chartRect.bottom - 2) || null

  const controls = [...document.querySelectorAll('button, input, select, [role="button"], [role="menuitem"], [role="option"]')]
    .filter(isRendered)
    .map((element, index) => ({
      element,
      role: elementName(element, index),
      rect: rectOf(element),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      hasApprovedInternalScroll: false,
    }))

  const surfaceDefinitions = [
    ['terminal-header', header, false],
    ['terminal-header-priority-row', headerRows[0], false],
    ['terminal-header-toolbar-row', headerRows[1], false],
    ['drawing-rail', leftRailElement, true],
    ['right-sidebar', rightSidebarElement, true],
    ['dock-tab-strip', dockElement?.querySelector(':scope > div:first-child > div:first-child'), true],
    ['terminal-status', document.querySelector('.terminal-statusbar'), false],
  ]
  const visibleElements = [
    ...controls.map(({ element, ...control }) => control),
    ...surfaceDefinitions.filter(([, element]) => isRendered(element)).map(([role, element, approved]) => ({
      role,
      rect: rectOf(element),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      hasApprovedInternalScroll: approved,
    })),
  ]

  const menuElements = [...document.querySelectorAll('.terminal-popover, .chart-context-menu')].filter(isRendered)
  const openMenus = menuElements.map((element, index) => {
    const style = getComputedStyle(element)
    return {
      role: `menu:${element.classList.contains('chart-context-menu') ? 'chart-context' : 'application-popover'}:${index}`,
      rect: rectOf(element),
      styledApplicationControl: style.position === 'absolute' && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && !element.matches('select'),
    }
  })

  const escapeCandidates = [
    ...controls.map(({ element, ...control }) => ({ ...control, kind: 'control', inset: 0 })),
    ...openMenus.map(menu => ({ ...menu, kind: 'menu', inset: 8 })),
  ]

  const forbiddenIntersections = []
  const addIntersection = (roleA, rectA, roleB, rectB) => {
    if (overlap(rectA, rectB)) forbiddenIntersections.push({ a: { role: roleA, rect: rectA }, b: { role: roleB, rect: rectB } })
  }

  addIntersection('leftDrawingRail', rectOf(leftRailElement), 'chartCanvas', chartRect)
  addIntersection('chartRangeControls', rectOf(rangeElement), 'timeScale', timeScaleRect)
  addIntersection('paperQuote', rectOf(quoteElement), 'symbolAndOhlc', rectOf(ohlcElement))

  const orderLabels = [...(chartRoot?.querySelectorAll('.pointer-events-auto > div') || [])]
    .filter(element => isRendered(element) && /\b(BUY|SELL|TP|SL|LIMIT|STOP)\b/.test(element.textContent))
    .map((element, index) => ({ role: `paperOrderOverlay:${index}:${element.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)}`, rect: rectOf(element) }))
  orderLabels.forEach(label => {
    addIntersection(label.role, label.rect, 'symbolAndOhlc', rectOf(ohlcElement))
    addIntersection(label.role, label.rect, 'priceScale', priceScaleRect)
  })

  for (let first = 0; first < controls.length; first += 1) {
    for (let second = first + 1; second < controls.length; second += 1) {
      addIntersection(controls[first].role, controls[first].rect, controls[second].role, controls[second].rect)
    }
  }

  const tabs = [...document.querySelectorAll('.dock-tab')].filter(isRendered).map((element, index) => ({
    role: `dockTab:${element.textContent.replace(/\s+/g, ' ').trim()}:${index}`,
    rect: rectOf(element),
  }))
  const adjacentTabGaps = tabs.slice(1).map((tab, index) => ({
    first: tabs[index].role,
    second: tab.role,
    gap: rounded(tab.rect.left - tabs[index].rect.right),
    firstRect: tabs[index].rect,
    secondRect: tab.rect,
  }))

  const leftRailRect = rectOf(leftRailElement)
  const leftRailPosition = leftRailElement ? getComputedStyle(leftRailElement).position : null
  const rightRailRect = rectOf(rightSidebarElement)
  const rightRailPosition = rightSidebarElement ? getComputedStyle(rightSidebarElement).position : null
  const dockRect = rectOf(dockElement)
  const leftCollapsed = leftRailElement?.dataset.collapsed === 'true'
  const rightCollapsed = rightSidebarElement?.dataset.collapsed === 'true'
  const dockCollapsed = dockElement?.classList.contains('trading-dock--collapsed') || false

  const marketSelector = [...document.querySelectorAll('button')].find(button => isRendered(button) && button.textContent.includes('Binance') && button.textContent.includes('Spot'))
  const paperBuy = document.querySelector('.quick-quote__side--buy') || [...document.querySelectorAll('button')].find(button => isRendered(button) && /BUY \/ LONG/.test(button.textContent))
  const paperSell = document.querySelector('.quick-quote__side--sell') || [...document.querySelectorAll('button')].find(button => isRendered(button) && /SELL \/ SHORT/.test(button.textContent))
  const positionStatus = [...document.querySelectorAll('.terminal-statusbar, .trading-dock')].find(element => isRendered(element) && element.textContent.includes('Positions'))

  return {
    state,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
    },
    visibleElements,
    escapeCandidates,
    forbiddenIntersections,
    essentialControls: {
      marketSelector: isRendered(marketSelector),
      activeChartIndicator: isRendered(ohlcElement),
      chartCanvas: Boolean(canvasRects.length && chartRect.width && chartRect.height),
      paperBuy: isRendered(paperBuy),
      paperSell: isRendered(paperSell),
      positionStatus: isRendered(positionStatus),
    },
    desktopHeader: { rect: rectOf(header), height: rectOf(header)?.height || 0, rows: headerRows.map(rectOf) },
    leftRail: {
      visible: isRendered(leftRailElement),
      collapsed: leftCollapsed,
      reserved: isRendered(leftRailElement) && leftRailPosition !== 'absolute' && leftRailPosition !== 'fixed' && !overlap(leftRailRect, chartRect),
      width: leftRailRect?.width || 0,
      position: leftRailPosition,
      rect: leftRailRect,
    },
    rightRail: {
      visible: isRendered(rightSidebarElement),
      collapsed: rightCollapsed,
      reserved: isRendered(rightSidebarElement) && rightRailRect.width <= 44.5 && rightRailPosition !== 'absolute' && rightRailPosition !== 'fixed' && !overlap(rightRailRect, chartRect),
      width: rightRailRect?.width || 0,
      position: rightRailPosition,
      rect: rightRailRect,
    },
    dock: {
      visible: isRendered(dockElement),
      collapsed: dockCollapsed,
      height: dockRect?.height || 0,
      rect: dockRect,
      adjacentTabGaps,
    },
    chart: {
      rect: chartRect,
      width: chartRect.width,
      height: chartRect.height,
      priceScaleVisible: Boolean(priceScaleRect && priceScaleRect.width > 0 && priceScaleRect.height > 0),
      timeScaleVisible: Boolean(timeScaleRect && timeScaleRect.width > 0 && timeScaleRect.height > 0),
      priceScaleRect,
      timeScaleRect,
      ohlcRect: rectOf(ohlcElement),
      orderOverlayLabels: orderLabels,
    },
    sidePanelsCollapsed: leftCollapsed && rightCollapsed && dockCollapsed,
    openMenus,
    rootRect: rectOf(root),
  }
}

function FixtureReady() {
  useEffect(() => {
    waitForPaint(5).then(() => { window.__terminalGeometryFixture.ready = true })
  }, [])
  return null
}

window.__terminalGeometryFixture = {
  ready: false,
  applyScenario,
  setQuoteState,
  snapshot: collectSnapshot,
  placeOrderCalls: () => placeOrderCalls.map(order => ({ ...order })),
  marketRequests: () => marketRequests.map(request => ({ ...request })),
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/pro-trading']}>
    <FixtureReady />
    <ProTrading />
  </MemoryRouter>,
)
