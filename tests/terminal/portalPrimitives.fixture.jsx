import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
  ContextMenu,
  ContextMenuItem,
  ModalSheet,
  Popover,
  PortalProvider,
  SymbolCombobox,
} from '../../src/trading/components/PortalPrimitives'
import '../../src/trading/ProTradingTerminal.css'

const symbols = [
  { value: 'BTCUSDT', symbol: 'BTCUSDT', label: 'BTC / USDT', name: 'Bitcoin' },
  { value: 'ETHUSDT', symbol: 'ETHUSDT', label: 'ETH / USDT', name: 'Ethereum' },
  { value: 'SOLUSDT', symbol: 'SOLUSDT', label: 'SOL / USDT', name: 'Solana' },
]
const waitForPaint = (frames = 3) => new Promise(resolve => {
  const next = remaining => requestAnimationFrame(() => remaining <= 1 ? resolve() : next(remaining - 1))
  next(frames)
})
const rectOf = element => {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
}

function PortalFixture() {
  const terminalRef = useRef(null)
  const popoverTriggerRef = useRef(null)
  const contextTriggerRef = useRef(null)
  const modalTriggerRef = useRef(null)
  const [anchor, setAnchor] = useState({ x: 20, y: 20, width: 28, height: 28 })
  const [preferredSide, setPreferredSide] = useState('bottom')
  const [contentSize, setContentSize] = useState({ width: 220, height: 120 })
  const [zoomed, setZoomed] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [contextPoint, setContextPoint] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [actionCount, setActionCount] = useState(0)
  const [symbol, setSymbol] = useState('BTCUSDT')

  useEffect(() => {
    window.__portalFixture = {
      ready: true,
      openPopover(config = {}) {
        setAnchor(current => ({ ...current, ...config }))
        setPreferredSide(config.side || 'bottom')
        setContentSize({ width: config.contentWidth || 220, height: config.contentHeight || 120 })
        setZoomed(Boolean(config.zoomed))
        requestAnimationFrame(() => {
          popoverTriggerRef.current?.focus()
          setPopoverOpen(true)
        })
      },
      moveAnchor(next) {
        setAnchor(current => ({ ...current, ...next }))
        requestAnimationFrame(() => window.dispatchEvent(new Event('scroll')))
      },
      openContext(point = { x: 40, y: 40 }) {
        contextTriggerRef.current?.focus()
        setContextPoint(point)
      },
      openModal() {
        modalTriggerRef.current?.focus()
        setModalOpen(true)
      },
      snapshot() {
        const portalRoot = document.getElementById('pro-terminal-portal-root')
        const popover = portalRoot?.querySelector('[data-testid="edge-popover"]')
        const contextMenu = portalRoot?.querySelector('[role="menu"]')
        const dialog = portalRoot?.querySelector('.pro-terminal-modal-sheet[role="dialog"]')
        const combobox = document.querySelector('[role="combobox"]')
        return {
          portalRootCount: document.querySelectorAll('#pro-terminal-portal-root').length,
          portalParentIsBody: portalRoot?.parentElement === document.body,
          portalTheme: portalRoot?.dataset.theme,
          popoverOpen: Boolean(popover),
          popoverRect: rectOf(popover),
          popoverPosition: popover ? getComputedStyle(popover).position : null,
          popoverParentId: popover?.parentElement?.id || null,
          contextOpen: Boolean(contextMenu),
          dialogOpen: Boolean(dialog),
          dialogContainsFocus: Boolean(dialog?.contains(document.activeElement)),
          focusedId: document.activeElement?.id || null,
          focusedText: document.activeElement?.textContent?.trim() || '',
          actionCount: Number(document.getElementById('underlying-action')?.dataset.count || 0),
          selectedSymbol: document.getElementById('selected-symbol')?.textContent || '',
          comboboxExpanded: combobox?.getAttribute('aria-expanded'),
          comboboxActiveDescendant: combobox?.getAttribute('aria-activedescendant') || null,
        }
      },
      waitForPaint,
    }
  })

  return <PortalProvider theme="dark" themeSourceRef={terminalRef}>
    <main ref={terminalRef} data-pro-terminal className="pro-terminal">
      <button id="underlying-action" data-count={actionCount} type="button" onClick={() => setActionCount(count => count + 1)}>Underlying action</button>
      <button id="context-trigger" ref={contextTriggerRef} type="button" onClick={() => setContextPoint({ x: 80, y: 80 })}>Open context</button>
      <button id="modal-trigger" ref={modalTriggerRef} type="button" onClick={() => setModalOpen(true)}>Open modal</button>
      <div id="overflow-ancestor" style={{ position: 'fixed', left: anchor.x, top: anchor.y, width: anchor.width, height: anchor.height, overflow: 'hidden', transform: 'translateZ(0)' }}>
        <button id="popover-trigger" ref={popoverTriggerRef} type="button" style={{ width: anchor.width, height: anchor.height }} onClick={() => setPopoverOpen(open => !open)}>Open popover</button>
        <Popover
          open={popoverOpen}
          anchorRef={popoverTriggerRef}
          onOpenChange={setPopoverOpen}
          preferredSide={preferredSide}
          align="start"
          data-testid="edge-popover"
          aria-label="Edge test popover"
        >
          <div style={{ width: contentSize.width, height: contentSize.height, padding: 8, fontSize: zoomed ? '2rem' : '1rem' }}>
            Zoom-safe portal content with deliberately long labels
            <button id="nested-modal-trigger" type="button" onClick={() => setModalOpen(true)}>Open nested modal</button>
          </div>
        </Popover>
      </div>

      <ContextMenu open={Boolean(contextPoint)} point={contextPoint} onOpenChange={open => { if (!open) setContextPoint(null) }} label="Fixture actions">
        <ContextMenuItem onSelect={() => {}}>First action</ContextMenuItem>
        <ContextMenuItem onSelect={() => {}}>Second action</ContextMenuItem>
        <ContextMenuItem onSelect={() => {}}>Third action</ContextMenuItem>
      </ContextMenu>

      <ModalSheet open={modalOpen} onOpenChange={setModalOpen} title="Fixture modal">
        <button id="modal-first" type="button">First modal control</button>
        <button id="modal-last" type="button">Last modal control</button>
      </ModalSheet>

      <div style={{ position: 'fixed', left: 100, top: 140, width: 260 }}>
        <SymbolCombobox options={symbols} value={symbol} onChange={setSymbol} label="Symbol" />
        <output id="selected-symbol">{symbol}</output>
      </div>
    </main>
  </PortalProvider>
}

window.__portalFixture = { ready: false }
ReactDOM.createRoot(document.getElementById('root')).render(<PortalFixture />)
waitForPaint(5).then(() => { window.__portalFixture.ready = true })
