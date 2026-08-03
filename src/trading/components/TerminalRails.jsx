import React, { useEffect, useRef, useState } from 'react'
import { BarChart3, ChevronLeft, ChevronRight, PanelRight, WalletCards } from 'lucide-react'
import useSettingsStore from '../stores/settingsStore'
import DrawingToolbar from './DrawingToolbar'
import TerminalFeatureBoundary from './TerminalFeatureBoundary'

function activateFromKeyboard(event, action) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  action()
}

function RailToggle({ side, expanded, onToggle }) {
  const expandsTowardRight = side === 'left'
  const Icon = expanded
    ? (expandsTowardRight ? ChevronLeft : ChevronRight)
    : (expandsTowardRight ? ChevronRight : ChevronLeft)
  const name = side === 'left' ? 'drawing' : 'action'

  return <button
    type="button"
    className="pro-terminal-rail__edge-control"
    aria-controls={`pro-terminal-${name}-rail-content`}
    aria-expanded={expanded}
    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name} rail`}
    title={`${expanded ? 'Collapse' : 'Expand'} ${name} rail`}
    onKeyDown={event => activateFromKeyboard(event, onToggle)}
    onClick={onToggle}
  ><Icon size={14} aria-hidden="true" /></button>
}

function ActionControls({ mode = 'rail', onOpenOrder, onAction }) {
  const showSidebar = useSettingsStore(state => state.showSidebar)
  const showOrderPanel = useSettingsStore(state => state.showOrderPanel)
  const toggleSidebar = useSettingsStore(state => state.toggleSidebar)
  const toggleOrderPanel = useSettingsStore(state => state.toggleOrderPanel)

  const run = action => () => {
    action()
    onAction?.()
  }

  const actions = [
    {
      id: 'panels',
      label: 'Trading panels',
      icon: PanelRight,
      pressed: showSidebar,
      action: toggleSidebar,
    },
    {
      id: 'quotes',
      label: 'Paper quotes',
      icon: BarChart3,
      pressed: showOrderPanel,
      action: toggleOrderPanel,
    },
    {
      id: 'paper-order',
      label: 'Open paper order',
      icon: WalletCards,
      action: () => onOpenOrder?.('buy'),
    },
  ]

  return <div
    id={mode === 'rail' ? 'pro-terminal-action-rail-content' : undefined}
    className={`pro-terminal-action-controls pro-terminal-action-controls--${mode}`}
    aria-label="Trading actions"
  >
    {actions.map(({ id, label, icon: Icon, pressed, action }) => <button
      key={id}
      type="button"
      className="pro-terminal-action-control"
      data-rail-action={id}
      aria-label={label}
      aria-pressed={typeof pressed === 'boolean' ? pressed : undefined}
      title={label}
      onClick={run(action)}
    ><Icon size={16} aria-hidden="true" /><span>{label}</span></button>)}
  </div>
}

export default function TerminalRails({ onOpenOrder }) {
  const [leftExpanded, setLeftExpanded] = useState(true)
  const [rightExpanded, setRightExpanded] = useState(true)
  const [responsiveDrawer, setResponsiveDrawer] = useState(null)
  const toolsTriggerRef = useRef(null)
  const actionsTriggerRef = useRef(null)
  const drawerRef = useRef(null)

  const closeResponsiveDrawer = () => setResponsiveDrawer(null)
  const toggleResponsiveDrawer = name => setResponsiveDrawer(current => current === name ? null : name)

  useEffect(() => {
    if (!responsiveDrawer) return undefined
    const frame = requestAnimationFrame(() => {
      drawerRef.current?.querySelector('button:not([disabled])')?.focus({ preventScroll: true })
    })
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      const trigger = responsiveDrawer === 'tools' ? toolsTriggerRef.current : actionsTriggerRef.current
      setResponsiveDrawer(null)
      requestAnimationFrame(() => trigger?.focus({ preventScroll: true }))
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [responsiveDrawer])

  return <>
    <aside
      className="pro-terminal__left-rail"
      data-terminal-area="leftRail"
      data-collapsed={!leftExpanded}
      aria-label="Chart drawing rail"
    >
      <RailToggle side="left" expanded={leftExpanded} onToggle={() => setLeftExpanded(value => !value)} />
      {leftExpanded && <div id="pro-terminal-drawing-rail-content" className="pro-terminal-rail__content">
        <TerminalFeatureBoundary feature="drawing-tools" label="Drawing tools"><DrawingToolbar mode="rail" /></TerminalFeatureBoundary>
      </div>}
    </aside>

    <aside
      className="pro-terminal__right-rail"
      data-terminal-area="rightRail"
      data-collapsed={!rightExpanded}
      aria-label="Trading action rail"
    >
      <RailToggle side="right" expanded={rightExpanded} onToggle={() => setRightExpanded(value => !value)} />
      {rightExpanded && <div className="pro-terminal-rail__content">
        <ActionControls mode="rail" onOpenOrder={onOpenOrder} />
      </div>}
    </aside>

    <nav className="pro-terminal-responsive-rail-actions" aria-label="Chart tool drawers" data-terminal-area="responsiveRailActions">
      <button
        ref={toolsTriggerRef}
        type="button"
        aria-controls="pro-terminal-responsive-rail-drawer"
        aria-expanded={responsiveDrawer === 'tools'}
        onKeyDown={event => activateFromKeyboard(event, () => toggleResponsiveDrawer('tools'))}
        onClick={() => toggleResponsiveDrawer('tools')}
      ><BarChart3 size={17} aria-hidden="true" /><span>Tools</span></button>
      <button
        ref={actionsTriggerRef}
        type="button"
        aria-controls="pro-terminal-responsive-rail-drawer"
        aria-expanded={responsiveDrawer === 'actions'}
        onKeyDown={event => activateFromKeyboard(event, () => toggleResponsiveDrawer('actions'))}
        onClick={() => toggleResponsiveDrawer('actions')}
      ><PanelRight size={17} aria-hidden="true" /><span>Actions</span></button>
    </nav>

    {responsiveDrawer && <section
      ref={drawerRef}
      id="pro-terminal-responsive-rail-drawer"
      className="pro-terminal-responsive-rail-drawer"
      data-terminal-area="responsiveRailDrawer"
      data-drawer={responsiveDrawer}
      role="region"
      aria-label={responsiveDrawer === 'tools' ? 'Drawing tools drawer' : 'Trading actions drawer'}
    >
      <header className="pro-terminal-responsive-rail-drawer__header">
        <strong>{responsiveDrawer === 'tools' ? 'Drawing tools' : 'Trading actions'}</strong>
        <button type="button" onClick={closeResponsiveDrawer} aria-label={`Close ${responsiveDrawer} drawer`}>Close</button>
      </header>
      <div className="pro-terminal-responsive-rail-drawer__content">
        {responsiveDrawer === 'tools'
          ? <TerminalFeatureBoundary feature="drawing-tools-drawer" label="Drawing tools"><DrawingToolbar mode="drawer" /></TerminalFeatureBoundary>
          : <ActionControls mode="drawer" onOpenOrder={onOpenOrder} onAction={closeResponsiveDrawer} />}
      </div>
    </section>}
  </>
}
