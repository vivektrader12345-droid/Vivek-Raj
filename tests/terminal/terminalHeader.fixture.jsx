import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/trading/ProTradingTerminal.css'
import TerminalTopBar from '../../src/trading/components/TerminalTopBar'
import useChartStore from '../../src/trading/stores/chartStore'
import useTradingStore from '../../src/trading/stores/tradingStore'

const stressLabels = new URLSearchParams(window.location.search).has('stress')
const account = useTradingStore.getState().account

useChartStore.setState({
  symbol: 'PAXGUSDT',
  symbolDisplay: 'PAXG/USDT',
  timeframe: '1m',
  wsConnected: true,
  candles: [
    { time: 1, open: 2300, close: 2300 },
    { time: 2, open: 2300, close: 2345.67 },
  ],
})
useTradingStore.setState({
  currentPrice: 2345.67,
  account: { ...account, balance: 123456789012345.67 },
})

createRoot(document.getElementById('root')).render(
  <div data-pro-terminal className="pro-terminal pro-terminal--dark">
    <div className="pro-terminal__header" data-terminal-area="header">
      <TerminalTopBar
        isFullscreen={false}
        onToggleFullscreen={() => {}}
        onOpenOrder={() => {}}
        onCapture={() => {}}
        onHome={() => {}}
        marketLabel={stressLabels ? 'INTERNATIONAL GOLD SETTLEMENT MARKET · PAXGUSDT' : undefined}
        accountLabel={stressLabels ? 'Paper equity $123,456,789,012,345.67 available for simulated trading' : undefined}
      />
    </div>
    <div className="pro-terminal__workspace" data-terminal-area="workspace" />
    <div className="pro-terminal__dock" data-terminal-area="dock" />
    <div className="pro-terminal__status" data-terminal-area="status" />
  </div>,
)
