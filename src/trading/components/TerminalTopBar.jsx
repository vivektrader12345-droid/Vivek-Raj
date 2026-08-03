import React, { useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  Activity, AreaChart, BarChart3, Bell, Camera, CandlestickChart, ChevronDown,
  GitCompare, Home, LayoutDashboard, LineChart, Maximize2, Minimize2, Moon,
  MoreHorizontal, PanelRight, Play, Redo2, Save, Settings2, Star, Sun, Undo2,
  WalletCards,
} from 'lucide-react'
import useChartStore from '../stores/chartStore'
import useTradingStore from '../stores/tradingStore'
import useSettingsStore from '../stores/settingsStore'
import { formatPrice } from '../types'

const SYMBOLS = [
  { value: 'BTCUSDT', label: 'BTCUSDT', short: 'BTC' },
  { value: 'ETHUSDT', label: 'ETHUSDT', short: 'ETH' },
  { value: 'SOLUSDT', label: 'SOLUSDT', short: 'SOL' },
  { value: 'PAXGUSDT', label: 'GOLD · PAXG', short: 'GOLD' },
  { value: 'BNBUSDT', label: 'BNBUSDT', short: 'BNB' },
  { value: 'XRPUSDT', label: 'XRPUSDT', short: 'XRP' },
  { value: 'DOGEUSDT', label: 'DOGEUSDT', short: 'DOGE' },
  { value: 'ADAUSDT', label: 'ADAUSDT', short: 'ADA' },
]

const PRIORITY_TIMEFRAMES = [
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '1H', value: '1h' },
  { label: '4H', value: '4h' },
  { label: '1D', value: '1d' },
]

const SECONDARY_TIMEFRAMES = [
  { label: '1s', value: '1s' },
  { label: '3m', value: '3m' },
  { label: '30m', value: '30m' },
  { label: '1W', value: '1w' },
  { label: '1M', value: '1M' },
  { label: '5s', disabled: true },
  { label: '15s', disabled: true },
  { label: '30s', disabled: true },
]

const CHART_STYLES = [
  { id: 'candles', label: 'Candlestick', icon: CandlestickChart },
  { id: 'hollow', label: 'Hollow Candle', icon: CandlestickChart },
  { id: 'line', label: 'Line', icon: LineChart },
  { id: 'area', label: 'Area', icon: AreaChart },
  { id: 'baseline', label: 'Baseline', icon: Activity },
  { id: 'heikin', label: 'Heikin Ashi', icon: BarChart3 },
  { id: 'renko', label: 'Renko', icon: BarChart3, disabled: true },
]

const INDICATORS = [
  ['ema', 'EMA'], ['vwap', 'VWAP'], ['rsi', 'RSI'], ['macd', 'MACD'],
  ['bollinger', 'Bollinger Bands'], ['atr', 'ATR'], ['supertrend', 'Supertrend'], ['volume', 'Volume'],
]

const COMPACT_ACCOUNT_UNITS = [
  { threshold: 1_000_000_000_000, suffix: 'T' },
  { threshold: 1_000_000_000, suffix: 'B' },
  { threshold: 1_000_000, suffix: 'M' },
  { threshold: 1_000, suffix: 'K' },
]

function formatCompactAccount(balance) {
  const value = Number(balance)
  if (!Number.isFinite(value)) return '$—'

  const unit = COMPACT_ACCOUNT_UNITS.find(item => Math.abs(value) >= item.threshold)
  if (!unit) return `$${Math.round(value * 100) / 100}`

  const scaled = Math.round((value / unit.threshold) * 10) / 10
  return `$${scaled}${unit.suffix}`
}

function IconButton({ title, onClick, children, active = false, disabled = false, control, className = '' }) {
  return <button
    type="button"
    title={title}
    aria-label={title}
    data-control={control}
    onClick={onClick}
    disabled={disabled}
    className={`terminal-icon-button ${active ? 'terminal-icon-button--active' : ''} ${className}`.trim()}
  >{children}</button>
}

function MoreAction({ icon: Icon, label, onClick, disabled = false, compactOnly = false }) {
  return <button
    type="button"
    role="menuitem"
    disabled={disabled}
    data-support={disabled ? 'unsupported' : 'supported'}
    onClick={onClick}
    className={`terminal-menu-action ${compactOnly ? 'terminal-more-compact-only' : ''}`.trim()}
  >
    <Icon size={14} />
    <span>{label}</span>
    {disabled && <span className="terminal-menu-action__state">Soon</span>}
  </button>
}

export default function TerminalTopBar({
  isFullscreen,
  onToggleFullscreen,
  onOpenOrder,
  onCapture,
  onHome,
  marketLabel,
  accountLabel,
}) {
  const symbol = useChartStore(state => state.symbol)
  const timeframe = useChartStore(state => state.timeframe)
  const candles = useChartStore(state => state.candles)
  const wsConnected = useChartStore(state => state.wsConnected)
  const activeIndicators = useChartStore(state => state.activeIndicators)
  const setSymbol = useChartStore(state => state.setSymbol)
  const setTimeframe = useChartStore(state => state.setTimeframe)
  const toggleIndicator = useChartStore(state => state.toggleIndicator)
  const currentPrice = useTradingStore(state => state.currentPrice)
  const account = useTradingStore(state => state.account)
  const chartStyle = useSettingsStore(state => state.chartStyle)
  const theme = useSettingsStore(state => state.theme)
  const setChartStyle = useSettingsStore(state => state.setChartStyle)
  const setTheme = useSettingsStore(state => state.setTheme)
  const toggleSidebar = useSettingsStore(state => state.toggleSidebar)
  const toggleSetting = useSettingsStore(state => state.toggleSetting)
  const [menu, setMenu] = useState(null)
  const [query, setQuery] = useState('')
  const [favorite, setFavorite] = useState(true)
  const headerRef = useRef(null)

  const selected = SYMBOLS.find(item => item.value === symbol) || SYMBOLS[0]
  const selectedLabel = marketLabel || selected.label
  const compactMarketLabel = selected.short
  const visibleMarketLabel = selectedLabel.length > 20 ? compactMarketLabel : selectedLabel
  const visibleSymbols = SYMBOLS.filter(item => item.label.toLowerCase().includes(query.toLowerCase()))
  const compactAccountLabel = formatCompactAccount(account.balance)
  const fullAccountLabel = accountLabel || `Paper equity $${account.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  const visibleAccountLabel = fullAccountLabel.length > 32 ? compactAccountLabel : fullAccountLabel
  const change = useMemo(() => {
    if (candles.length < 2) return 0
    const first = Number(candles[0]?.open) || 0
    const last = Number(currentPrice || candles.at(-1)?.close) || 0
    return first ? ((last - first) / first) * 100 : 0
  }, [candles, currentPrice])

  useEffect(() => {
    if (!menu) return undefined
    const closeOutside = event => {
      if (!headerRef.current?.contains(event.target)) setMenu(null)
    }
    const closeOnEscape = event => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menu])

  const toggleMenu = name => setMenu(current => current === name ? null : name)
  const runAndClose = action => () => {
    action?.()
    setMenu(null)
  }
  const chooseSymbol = value => {
    setSymbol(value)
    setMenu(null)
    setQuery('')
  }
  const chooseTimeframe = value => {
    if (value) setTimeframe(value)
    setMenu(null)
  }
  const saveLayout = () => toast.success('Terminal layout and preferences saved locally')

  return <header ref={headerRef} className="terminal-topbar select-none" data-terminal-header>
    <div className="terminal-header-row terminal-header-row--primary" data-header-row="primary">
      <div className="terminal-header-cluster terminal-header-cluster--market">
        <IconButton title="Back to dashboard" control="home" onClick={onHome}><Home size={16} /></IconButton>

        <div className="terminal-menu-anchor terminal-market-anchor">
          <button
            type="button"
            data-control="market"
            aria-label={`Select market, current market ${selectedLabel}`}
            aria-haspopup="listbox"
            aria-expanded={menu === 'symbols'}
            aria-controls="terminal-market-menu"
            onClick={() => toggleMenu('symbols')}
            className="terminal-market-button"
          >
            <span className="terminal-market__symbol" aria-hidden="true">{selected.short.slice(0, 2)}</span>
            <span className="terminal-market__copy">
              <span className="terminal-market__label terminal-market__label--full">{visibleMarketLabel}</span>
              <span className="terminal-market__label terminal-market__label--compact">{compactMarketLabel}</span>
              <span className="terminal-market__venue">Binance · Spot</span>
            </span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          {menu === 'symbols' && <div id="terminal-market-menu" role="listbox" aria-label="Markets" className="terminal-popover terminal-menu terminal-menu--markets">
            <label className="terminal-menu-search">
              <span className="sr-only">Search market</span>
              <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search market" />
            </label>
            <div className="terminal-market-options custom-scrollbar">
              {visibleSymbols.map(item => <button
                key={item.value}
                type="button"
                role="option"
                aria-selected={symbol === item.value}
                onClick={() => chooseSymbol(item.value)}
                className={symbol === item.value ? 'terminal-market-option terminal-market-option--active' : 'terminal-market-option'}
              ><span>{item.label}</span><span>USDT</span></button>)}
            </div>
          </div>}
        </div>

        <span
          className={`terminal-live-state ${wsConnected ? 'terminal-live-state--connected' : 'terminal-live-state--offline'}`}
          data-control="live-status"
          role="status"
          aria-live="polite"
        ><span aria-hidden="true" />{wsConnected ? 'LIVE' : 'OFFLINE'}</span>

        <span className="terminal-session-price" aria-label="Current market price and session change">
          <strong>{currentPrice ? formatPrice(currentPrice) : '—'}</strong>
          <span className={change >= 0 ? 'terminal-positive' : 'terminal-negative'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</span>
        </span>
      </div>

      <div className="terminal-header-cluster terminal-header-cluster--actions">
        <span className="terminal-account-summary terminal-primary-desktop" data-control="account" role="status" aria-label={fullAccountLabel}>
          <span className="terminal-account__full">{visibleAccountLabel}</span>
          <span className="terminal-account__compact">{compactAccountLabel}</span>
        </span>
        <IconButton title="Save layout" control="save" className="terminal-primary-desktop" onClick={saveLayout}><Save size={15} /></IconButton>
        <IconButton title="Layout manager" control="layout" className="terminal-primary-desktop" onClick={toggleSidebar}><LayoutDashboard size={15} /></IconButton>
        <IconButton
          title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
          control="fullscreen"
          className="terminal-primary-desktop"
          onClick={onToggleFullscreen}
        >{isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</IconButton>
        <button type="button" data-control="paper-trade" onClick={() => onOpenOrder('buy')} className="terminal-paper-trade">
          <WalletCards size={15} /><span>Paper Trade</span>
        </button>
      </div>
    </div>

    <div className="terminal-header-row terminal-header-row--secondary" data-header-row="secondary">
      <div className="terminal-priority-timeframes" aria-label="Priority timeframes" data-control="priority-timeframes">
        {PRIORITY_TIMEFRAMES.map(item => <button
          key={item.value}
          type="button"
          title={`${item.label} timeframe`}
          aria-pressed={timeframe === item.value}
          onClick={() => setTimeframe(item.value)}
          className={`terminal-chip ${timeframe === item.value ? 'terminal-chip--active' : ''}`}
        >{item.label}</button>)}
      </div>
      <span className="terminal-header-divider" aria-hidden="true" />

      <div className="terminal-menu-anchor">
        <button
          type="button"
          data-control="style"
          aria-haspopup="menu"
          aria-expanded={menu === 'style'}
          aria-controls="terminal-style-menu"
          onClick={() => toggleMenu('style')}
          className="terminal-toolbar-button"
        >
          <CandlestickChart size={14} />
          <span className="terminal-toolbar-label--full">{CHART_STYLES.find(item => item.id === chartStyle)?.label || 'Candlestick'}</span>
          <span className="terminal-toolbar-label--compact">Style</span>
          <ChevronDown size={12} />
        </button>
        {menu === 'style' && <div id="terminal-style-menu" role="menu" aria-label="Chart style" className="terminal-popover terminal-menu terminal-menu--style">
          {CHART_STYLES.map(item => {
            const Icon = item.icon
            return <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={chartStyle === item.id}
              disabled={item.disabled}
              data-support={item.disabled ? 'unsupported' : 'supported'}
              onClick={runAndClose(() => setChartStyle(item.id))}
              className={chartStyle === item.id ? 'terminal-menu-action terminal-menu-action--active' : 'terminal-menu-action'}
            ><Icon size={14} /><span>{item.label}</span>{item.disabled && <span className="terminal-menu-action__state">Soon</span>}</button>
          })}
        </div>}
      </div>

      <div className="terminal-menu-anchor">
        <button
          type="button"
          data-control="indicators"
          aria-haspopup="menu"
          aria-expanded={menu === 'indicators'}
          aria-controls="terminal-indicator-menu"
          onClick={() => toggleMenu('indicators')}
          className="terminal-toolbar-button"
        ><Activity size={14} /><span>Indicators</span><span className="terminal-toolbar-count">{activeIndicators.length}</span></button>
        {menu === 'indicators' && <div id="terminal-indicator-menu" role="menu" aria-label="Indicators" className="terminal-popover terminal-menu terminal-menu--indicators">
          {INDICATORS.map(([id, label]) => <button
            key={id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={activeIndicators.includes(id)}
            onClick={() => toggleIndicator(id)}
            className={activeIndicators.includes(id) ? 'terminal-indicator-option terminal-indicator-option--active' : 'terminal-indicator-option'}
          ><span>{label}</span><span aria-hidden="true">{activeIndicators.includes(id) ? '✓' : ''}</span></button>)}
        </div>}
      </div>

      <div className="terminal-menu-anchor terminal-more-anchor">
        <button
          type="button"
          data-control="more"
          aria-haspopup="menu"
          aria-expanded={menu === 'more'}
          aria-controls="terminal-more-menu"
          onClick={() => toggleMenu('more')}
          className="terminal-toolbar-button terminal-more-button"
        ><MoreHorizontal size={15} /><span>More</span><ChevronDown size={12} /></button>
        {menu === 'more' && <div id="terminal-more-menu" role="menu" aria-label="More chart controls" className="terminal-popover terminal-menu terminal-menu--more">
          <div className="terminal-menu-section-label">More timeframes</div>
          <div className="terminal-more-timeframes">
            {SECONDARY_TIMEFRAMES.map(item => <button
              key={item.label}
              type="button"
              role="menuitemradio"
              aria-checked={Boolean(item.value && timeframe === item.value)}
              disabled={item.disabled}
              data-support={item.disabled ? 'unsupported' : 'supported'}
              title={item.disabled ? 'This interval is not supplied by the Binance kline stream' : `${item.label} timeframe`}
              onClick={() => chooseTimeframe(item.value)}
              className={timeframe === item.value ? 'terminal-more-timeframe terminal-more-timeframe--active' : 'terminal-more-timeframe'}
            >{item.label}{item.disabled && <span>Soon</span>}</button>)}
          </div>
          <div className="terminal-menu-separator" />
          <MoreAction compactOnly icon={Save} label="Save layout" onClick={runAndClose(saveLayout)} />
          <MoreAction compactOnly icon={LayoutDashboard} label="Layout manager" onClick={runAndClose(toggleSidebar)} />
          <MoreAction compactOnly icon={isFullscreen ? Minimize2 : Maximize2} label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={runAndClose(onToggleFullscreen)} />
          <MoreAction icon={Camera} label="Chart screenshot" onClick={runAndClose(onCapture)} />
          <MoreAction icon={theme === 'dark' ? Moon : Sun} label={theme === 'dark' ? 'Graphite theme' : 'Midnight theme'} onClick={runAndClose(() => setTheme(theme === 'dark' ? 'graphite' : 'dark'))} />
          <MoreAction icon={PanelRight} label="Right panel" onClick={runAndClose(toggleSidebar)} />
          <MoreAction icon={Settings2} label="Chart settings" onClick={runAndClose(() => toggleSetting('showGrid'))} />
          <MoreAction icon={Bell} label="Alerts" onClick={runAndClose(() => toast('Use the Alerts section for persisted alerts'))} />
          <MoreAction icon={Star} label={favorite ? 'Remove favorite' : 'Add favorite'} onClick={runAndClose(() => setFavorite(value => !value))} />
          <div className="terminal-menu-separator" />
          <div className="terminal-menu-section-label">Unavailable in this release</div>
          <MoreAction disabled icon={GitCompare} label="Compare markets" />
          <MoreAction disabled icon={Play} label="Chart replay" />
          <MoreAction disabled icon={Undo2} label="Undo drawing" />
          <MoreAction disabled icon={Redo2} label="Redo drawing" />
          <MoreAction disabled icon={BarChart3} label="Financials" />
        </div>}
      </div>
    </div>
  </header>
}
