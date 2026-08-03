import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Bell, CalendarDays, Copy, Crosshair, Layers3, Maximize2, MessageSquare, RadioTower, Settings2, ShoppingCart, Target, X } from 'lucide-react'
import './ProTradingTerminal.css'
import useChartStore from './stores/chartStore'
import useTradingStore from './stores/tradingStore'
import useSettingsStore from './stores/settingsStore'
import { initializeChartData, disconnectWebSocket } from './utils/binanceWS'
import { useTradeBridge } from './useTradeBridge'
import ProChart from './components/ProChart'
import BottomSheet from './components/BottomSheet'
import ProOrderPanel from './components/ProOrderPanel'
import RightSidebar from './components/RightSidebar'
import ChartOrderLines from './components/ChartOrderLines'
import ChartIndicators from './components/ChartIndicators'
import TradeMarkers from './components/TradeMarkers'
import TerminalTopBar from './components/TerminalTopBar'
import TerminalRails from './components/TerminalRails'
import TradingDock from './components/TradingDock'
import TerminalFeatureBoundary from './components/TerminalFeatureBoundary'
import PaperQuoteBox from './components/PaperQuoteBox'
import { ContextMenu, ContextMenuItem, PortalProvider } from './components/PortalPrimitives'
import { createPaperQuote, openPaperOrderDraft as openPaperOrderDraftCommand, QuoteStatus, QUOTE_STALE_AFTER_MS, SINGLE_CHART_TILE_ID } from './paperOrderDraft'
import { formatPrice } from './types'

const RANGE_PRESETS = [
  ['1D', 180], ['5D', 360], ['1M', 520], ['3M', 700], ['6M', 850],
  ['YTD', 920], ['1Y', 960], ['5Y', 990], ['ALL', 1000],
]

function ProTrading() {
  const navigate = useNavigate()
  const symbol = useChartStore(s => s.symbol)
  const symbolDisplay = useChartStore(s => s.symbolDisplay)
  const timeframe = useChartStore(s => s.timeframe)
  const candles = useChartStore(s => s.candles)
  const wsConnected = useChartStore(s => s.wsConnected)
  const currentPrice = useTradingStore(s => s.currentPrice)
  const lastTickTime = useTradingStore(s => s.lastTickTime)
  const positions = useTradingStore(s => s.positions)
  const account = useTradingStore(s => s.account)
  const showSidebar = useSettingsStore(s => s.showSidebar)
  const showOrderPanel = useSettingsStore(s => s.showOrderPanel)
  const theme = useSettingsStore(s => s.theme)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [orderDraft, setOrderDraft] = useState(null)
  const [quoteNow, setQuoteNow] = useState(() => Date.now())
  const [contextMenu, setContextMenu] = useState(null)
  const [activeRange, setActiveRange] = useState('ALL')
  const terminalRef = useRef(null)

  useTradeBridge()

  useEffect(() => {
    const className = 'pro-terminal-page'
    const bodyAlreadyScoped = document.body.classList.contains(className)
    document.body.classList.add(className)
    return () => {
      if (!bodyAlreadyScoped) document.body.classList.remove(className)
    }
  }, [])

  useEffect(() => {
    initializeChartData(symbol, timeframe)
    return () => disconnectWebSocket()
  }, [symbol, timeframe])

  useEffect(() => {
    const now = Date.now()
    setQuoteNow(now)
    if (!wsConnected || !Number.isFinite(lastTickTime) || lastTickTime <= 0) return undefined
    const remaining = QUOTE_STALE_AFTER_MS - (now - lastTickTime)
    if (remaining <= 0) return undefined
    const timer = window.setTimeout(() => setQuoteNow(Date.now()), remaining + 1)
    return () => window.clearTimeout(timer)
  }, [currentPrice, lastTickTime, wsConnected])

  const quote = useMemo(() => createPaperQuote({
    price: currentPrice,
    connected: wsConnected,
    lastTickTime,
    now: quoteNow,
  }), [currentPrice, lastTickTime, quoteNow, wsConnected])

  const openPaperOrderDraft = useCallback(request => openPaperOrderDraftCommand({
    tileId: request?.tileId || SINGLE_CHART_TILE_ID,
    activeTileId: SINGLE_CHART_TILE_ID,
    symbol: request?.symbol || symbol,
    activeSymbol: symbol,
    symbolDisplay,
    side: request?.side || 'buy',
    price: request?.price,
    quoteStatus: request?.quoteStatus,
  }, draft => {
    setOrderDraft(draft)
    setContextMenu(null)
  }), [symbol, symbolDisplay])

  const openOrder = useCallback(side => openPaperOrderDraft({
    tileId: SINGLE_CHART_TILE_ID,
    symbol,
    side,
    price: quote.status === QuoteStatus.CURRENT ? (side === 'sell' ? quote.bid : quote.ask) : undefined,
    quoteStatus: quote.status,
  }), [openPaperOrderDraft, quote, symbol])

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        openOrder('buy')
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        openOrder('sell')
      }
      if (event.shiftKey && event.key === 'Escape') useTradingStore.getState().closeAllPositions()
      if (!event.shiftKey && event.key === 'Escape') { setContextMenu(null); setIsFullscreen(false); setOrderDraft(null) }
      if (event.key.toLowerCase() === 'f' || event.key === 'F11') { event.preventDefault(); setIsFullscreen(value => !value) }
      if (event.key === 'Delete') useChartStore.getState().clearDrawings()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openOrder])

  const selectRange = useCallback((label, bars) => {
    const chart = useChartStore.getState().chartRef
    if (!chart || !candles.length) return
    setActiveRange(label)
    if (label === 'ALL') chart.timeScale().fitContent()
    else chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - bars), to: candles.length + 4 })
  }, [candles])

  const resetChart = useCallback(() => {
    const chart = useChartStore.getState().chartRef
    chart?.timeScale().fitContent()
    chart?.priceScale('right').applyOptions({ autoScale: true })
    setActiveRange('ALL')
    setContextMenu(null)
  }, [])

  const captureChart = useCallback(() => {
    try {
      const canvas = useChartStore.getState().chartRef?.takeScreenshot()
      if (!canvas) throw new Error('Chart is not ready')
      const anchor = document.createElement('a')
      anchor.download = `${symbol}-${timeframe}-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.png`
      anchor.href = canvas.toDataURL('image/png')
      anchor.click()
      toast.success('Chart screenshot saved')
    } catch (error) { toast.error(error.message || 'Unable to capture chart') }
  }, [symbol, timeframe])

  const totalUnrealized = useMemo(() => positions.reduce((sum, item) => sum + (Number(item.unrealizedPnl) || 0), 0), [positions])

  const showContextMenu = event => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY })
  }

  return <PortalProvider theme={theme} themeSourceRef={terminalRef}>
    <div ref={terminalRef} data-pro-terminal className={`pro-terminal pro-terminal--${theme} ${isFullscreen ? 'pro-terminal--fullscreen' : ''}`}>
    <div className="pro-terminal__header" data-terminal-area="header">
      <TerminalTopBar isFullscreen={isFullscreen} onToggleFullscreen={() => setIsFullscreen(value => !value)} onOpenOrder={openOrder} onCapture={captureChart} onHome={() => navigate('/')} />
    </div>

    <div className="pro-terminal__workspace" data-terminal-area="workspace">
      <TerminalRails onOpenOrder={openOrder} />

      <main className="pro-terminal__chart-region" data-terminal-area="chartRegion" onContextMenu={showContextMenu}>
        <ProChart height="100%" />
        <TerminalFeatureBoundary feature="paper-order-lines" label="Pending paper order lines"><ChartOrderLines /></TerminalFeatureBoundary>
        <TerminalFeatureBoundary feature="indicators" label="Indicators"><ChartIndicators /></TerminalFeatureBoundary>
        <TerminalFeatureBoundary feature="trade-markers" label="Trade markers"><TradeMarkers /></TerminalFeatureBoundary>

        {showOrderPanel && !isFullscreen && <PaperQuoteBox
          quote={quote}
          symbol={symbol}
          tileId={SINGLE_CHART_TILE_ID}
          onOpenPaperOrderDraft={openPaperOrderDraft}
        />}
        <ChartRangeBar activeRange={activeRange} onSelect={selectRange} />

        <ChartContextMenu open={Boolean(contextMenu)} point={contextMenu} currentPrice={currentPrice} onOpenChange={open => { if (!open) setContextMenu(null) }} onBuy={() => openOrder('buy')} onSell={() => openOrder('sell')} onReset={resetChart} onCopy={() => { navigator.clipboard?.writeText(String(currentPrice)); toast.success('Price copied'); setContextMenu(null) }} />

        <BottomSheet
          isOpen={Boolean(orderDraft)}
          onClose={() => setOrderDraft(null)}
          maxHeight="88vh"
          title="Paper trading"
          ariaLabel="Review paper order"
          contained
        >
          {orderDraft && <ProOrderPanel
            key={`${orderDraft.symbol}:${orderDraft.side}:${orderDraft.price ?? 'unpriced'}`}
            initialSide={orderDraft.side}
            initialPrice={orderDraft.price}
            initialSymbolDisplay={orderDraft.symbolDisplay}
            quoteStatus={orderDraft.quoteStatus}
            onClose={() => setOrderDraft(null)}
          />}
        </BottomSheet>

        <div className="pointer-events-none absolute right-16 top-14 hidden rounded-lg border border-white/[.06] bg-[#080d18]/72 px-2.5 py-2 backdrop-blur-md lg:block" style={{zIndex: 'var(--pro-layer-order-overlays)', opacity: 0.92}} data-chart-hud="position-summary">
          <div className="flex items-center gap-4 text-[9px]"><span className="text-slate-500">Open positions <strong className="ml-1 text-slate-200">{positions.length}</strong></span><span className="text-slate-500">Unrealized <strong className={totalUnrealized >= 0 ? 'ml-1 text-emerald-400' : 'ml-1 text-rose-400'}>{totalUnrealized >= 0 ? '+' : ''}${totalUnrealized.toFixed(2)}</strong></span><span className="text-slate-500">Free margin <strong className="ml-1 text-slate-200">${account.availableMargin.toFixed(2)}</strong></span></div>
        </div>
      </main>

      <aside className={`pro-terminal__utility-panel ${showSidebar && !isFullscreen ? 'pro-terminal__utility-panel--open' : ''}`} data-terminal-area="utilityPanel" aria-label="Trading utility panel">
        {showSidebar && !isFullscreen && <TerminalFeatureBoundary feature="utility-panel" label="Utility panel"><RightSidebar /></TerminalFeatureBoundary>}
      </aside>
    </div>

    <div className="pro-terminal__dock" data-terminal-area="dock">
      {!isFullscreen && <TerminalFeatureBoundary feature="trading-dock" label="Trading dock"><TradingDock /></TerminalFeatureBoundary>}
    </div>

    <div className="pro-terminal__status" data-terminal-area="status">
      {!isFullscreen && <StatusBar />}
    </div>

    </div>
  </PortalProvider>
}

function ChartRangeBar({ activeRange, onSelect }) {
  return <div className="chart-range-bar">{RANGE_PRESETS.map(([label, bars]) => <button key={label} type="button" onClick={() => onSelect(label, bars)} className={activeRange === label ? 'active' : ''}>{label}</button>)}<span className="mx-1 h-4 w-px bg-white/[.08]" /><button type="button" title="Auto scale" onClick={() => useChartStore.getState().chartRef?.priceScale('right').applyOptions({ autoScale: true })}>AUTO</button><button type="button" title="Reset chart" onClick={() => useChartStore.getState().chartRef?.timeScale().fitContent()}><Crosshair size={12} /></button></div>
}

function ChartContextMenu({ open, point, currentPrice, onOpenChange, onBuy, onSell, onReset, onCopy }) {
  const actions = [
    ['Buy market', ShoppingCart, onBuy, 'text-emerald-300'], ['Sell market', ShoppingCart, onSell, 'text-rose-300'],
    ['Place order', Target, onBuy], ['Add alert', Bell, () => toast('Open Alerts from the main navigation')],
    ['Reset chart', Maximize2, onReset], ['Chart settings', Settings2, () => useSettingsStore.getState().toggleSetting('showGrid')],
    [`Copy price ${currentPrice ? formatPrice(currentPrice) : ''}`, Copy, onCopy],
  ]
  return <ContextMenu open={open} point={point} onOpenChange={onOpenChange} label="Chart actions" className="chart-context-menu">
    {actions.map(([label, Icon, action, tone]) => <ContextMenuItem key={label} onSelect={action} className={tone || ''}><Icon size={14} />{label}</ContextMenuItem>)}
    <div className="pro-terminal-context-menu__separator" role="separator" />
    <ContextMenuItem onSelect={() => useChartStore.getState().clearDrawings()} className="text-rose-300"><X size={14} />Delete all drawings</ContextMenuItem>
  </ContextMenu>
}

function StatusBar() {
  const wsConnected = useChartStore(s => s.wsConnected)
  const symbolDisplay = useChartStore(s => s.symbolDisplay)
  const timeframe = useChartStore(s => s.timeframe)
  const positions = useTradingStore(s => s.positions)
  const account = useTradingStore(s => s.account)
  const { toggleSidebar, toggleOrderPanel } = useSettingsStore()
  return <footer className="terminal-statusbar"><div className="flex items-center gap-3"><span className={wsConnected ? 'text-emerald-400' : 'text-rose-400'}><span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${wsConnected ? 'animate-pulse bg-emerald-400' : 'bg-rose-400'}`} />{wsConnected ? 'Market connected' : 'Reconnecting'}</span><span>{symbolDisplay}</span><span>{timeframe.toUpperCase()}</span><span>Positions <strong>{positions.length}</strong></span></div><div className="flex items-center gap-3"><span className="hidden md:inline">Paper balance <strong>${account.balance.toFixed(2)}</strong></span><button onClick={toggleOrderPanel}>Quotes</button><button onClick={toggleSidebar}>Panels</button><span className="hidden text-slate-600 lg:inline">Ctrl+B Paper Buy · Ctrl+S Paper Sell · F Fullscreen</span></div></footer>
}

export default ProTrading
