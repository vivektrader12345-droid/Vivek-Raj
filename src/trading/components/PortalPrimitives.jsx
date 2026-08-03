import React, {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { computePortalPosition, PORTAL_VIEWPORT_PADDING } from '../utils/portalPositioning'

const PORTAL_ROOT_ID = 'pro-terminal-portal-root'
const THEME_PROPERTIES = [
  '--pro-layer-chart-canvas',
  '--pro-layer-chart-primitives',
  '--pro-layer-drawings',
  '--pro-layer-order-overlays',
  '--pro-layer-tile-hud',
  '--pro-layer-terminal-chrome',
  '--pro-layer-drawers',
  '--pro-layer-popovers',
  '--pro-layer-modal',
  '--pro-layer-toast',
  '--terminal-bg',
  '--terminal-panel',
  '--terminal-panel-2',
  '--terminal-border',
  '--terminal-muted',
]
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const PortalContext = createContext({ root: null })
const MenuContext = createContext(null)
let portalOwnerCount = 0
let nextLayerId = 0
const layerStack = []

function ensurePortalRoot() {
  let root = document.getElementById(PORTAL_ROOT_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = PORTAL_ROOT_ID
    root.className = 'pro-terminal-portal-root pro-terminal-portal-theme'
    root.setAttribute('data-pro-terminal-portal-root', '')
    document.body.appendChild(root)
  }
  return root
}

function propagatePortalTheme(root, source, theme) {
  root.dataset.theme = theme || 'dark'
  root.classList.toggle('pro-terminal-portal-theme--graphite', theme === 'graphite')
  root.classList.toggle('pro-terminal-portal-theme--dark', theme !== 'graphite')
  if (!source) return
  const styles = getComputedStyle(source)
  for (const property of THEME_PROPERTIES) {
    const value = styles.getPropertyValue(property)
    if (value) root.style.setProperty(property, value.trim())
  }
  root.style.colorScheme = styles.colorScheme || 'dark'
  root.style.fontFamily = styles.fontFamily
}

export function PortalProvider({ children, theme = 'dark', themeSourceRef }) {
  const [root, setRoot] = useState(null)

  useLayoutEffect(() => {
    const portalRoot = ensurePortalRoot()
    portalOwnerCount += 1
    setRoot(portalRoot)
    return () => {
      portalOwnerCount = Math.max(0, portalOwnerCount - 1)
      if (portalOwnerCount === 0 && portalRoot.isConnected) portalRoot.remove()
    }
  }, [])

  useLayoutEffect(() => {
    if (!root) return
    propagatePortalTheme(root, themeSourceRef?.current, theme)
  }, [root, theme, themeSourceRef])

  const context = useMemo(() => ({ root }), [root])
  return <PortalContext.Provider value={context}>{children}</PortalContext.Provider>
}

export function PortalLayer({ children }) {
  const { root } = useContext(PortalContext)
  return root ? createPortal(children, root) : null
}

function assignRef(ref, value) {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

function useCombinedRef(...refs) {
  return useCallback(value => {
    for (const ref of refs) assignRef(ref, value)
  }, refs)
}

function currentViewport() {
  const visualViewport = window.visualViewport
  return {
    left: visualViewport?.offsetLeft || 0,
    top: visualViewport?.offsetTop || 0,
    width: visualViewport?.width || window.innerWidth,
    height: visualViewport?.height || window.innerHeight,
  }
}

function resolveAnchorRect(anchorRef, anchorRect) {
  if (typeof anchorRect === 'function') return anchorRect()
  if (anchorRect) return anchorRect
  return anchorRef?.current?.getBoundingClientRect() || null
}

function useFixedPortalPosition({ open, surfaceRef, anchorRef, anchorRect, preferredSide, align, offset, padding }) {
  const [position, setPosition] = useState({ left: padding, top: padding, side: preferredSide, maxWidth: 0, maxHeight: 0, ready: false })

  useLayoutEffect(() => {
    if (!open || !surfaceRef.current) return undefined
    let frame = 0
    let observer
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const surface = surfaceRef.current
        const anchor = resolveAnchorRect(anchorRef, anchorRect)
        if (!surface || !anchor) return
        const rect = surface.getBoundingClientRect()
        const next = computePortalPosition({
          anchorRect: anchor,
          surfaceSize: { width: rect.width, height: rect.height },
          viewport: currentViewport(),
          preferredSide,
          align,
          offset,
          padding,
        })
        setPosition({ ...next, ready: true })
      })
    }
    const visualViewport = window.visualViewport
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    visualViewport?.addEventListener('resize', update)
    visualViewport?.addEventListener('scroll', update)
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update)
      observer.observe(surfaceRef.current)
      if (anchorRef?.current) observer.observe(anchorRef.current)
    }
    update()
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      visualViewport?.removeEventListener('resize', update)
      visualViewport?.removeEventListener('scroll', update)
    }
  }, [open, surfaceRef, anchorRef, anchorRect, preferredSide, align, offset, padding])

  useEffect(() => {
    if (!open) setPosition(current => ({ ...current, ready: false }))
  }, [open])

  return position
}

function isTopLayer(id) {
  return layerStack.at(-1) === id
}

function suppressNextClick() {
  let timeout
  const suppress = event => {
    clearTimeout(timeout)
    event.preventDefault()
    event.stopImmediatePropagation()
    document.removeEventListener('click', suppress, true)
  }
  document.addEventListener('click', suppress, true)
  timeout = window.setTimeout(() => document.removeEventListener('click', suppress, true), 750)
}

function useDismissableLayer({ open, surfaceRef, anchorRef, onDismiss }) {
  const idRef = useRef(`pro-portal-layer-${++nextLayerId}`)
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    if (!open) return undefined
    const id = idRef.current
    layerStack.push(id)
    const handleKeyDown = event => {
      if (event.key !== 'Escape' || !isTopLayer(id)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      dismissRef.current?.('escape', event)
    }
    const handlePointerDown = event => {
      if (!isTopLayer(id)) return
      const surface = surfaceRef.current
      const anchor = anchorRef?.current
      if (surface?.contains(event.target) || anchor?.contains(event.target)) return
      suppressNextClick()
      event.preventDefault()
      event.stopImmediatePropagation()
      dismissRef.current?.('pointer-down-outside', event)
    }
    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      const index = layerStack.lastIndexOf(id)
      if (index >= 0) layerStack.splice(index, 1)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [open, surfaceRef, anchorRef])

  return idRef.current
}

function useReturnFocus(open, returnFocusRef) {
  const returnElementRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    returnElementRef.current = returnFocusRef?.current || document.activeElement
    return () => {
      const element = returnElementRef.current
      queueMicrotask(() => {
        if (element?.isConnected && typeof element.focus === 'function') element.focus({ preventScroll: true })
      })
    }
  }, [open, returnFocusRef])
}

const PortalSurface = forwardRef(function PortalSurface({
  open,
  anchorRef,
  anchorRect,
  onDismiss,
  preferredSide = 'bottom',
  align = 'start',
  offset = 6,
  padding = PORTAL_VIEWPORT_PADDING,
  className = '',
  style,
  children,
  returnFocusRef,
  ...surfaceProps
}, forwardedRef) {
  const { root } = useContext(PortalContext)
  const localRef = useRef(null)
  const combinedRef = useCombinedRef(localRef, forwardedRef)
  const position = useFixedPortalPosition({
    open: open && Boolean(root),
    surfaceRef: localRef,
    anchorRef,
    anchorRect,
    preferredSide,
    align,
    offset,
    padding,
  })
  useDismissableLayer({ open: open && Boolean(root), surfaceRef: localRef, anchorRef, onDismiss })
  useReturnFocus(open && Boolean(root), returnFocusRef || anchorRef)

  if (!open || !root) return null
  return createPortal(
    <div
      {...surfaceProps}
      ref={combinedRef}
      className={`pro-terminal-portal-surface ${className}`.trim()}
      data-side={position.side}
      style={{
        ...style,
        left: position.left,
        top: position.top,
        maxWidth: position.maxWidth || `calc(100vw - ${padding * 2}px)`,
        maxHeight: position.maxHeight || `calc(100dvh - ${padding * 2}px)`,
        visibility: position.ready ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    root,
  )
})

export const Popover = forwardRef(function Popover({ open, onOpenChange, className = '', role = 'dialog', ...props }, ref) {
  return <PortalSurface
    {...props}
    ref={ref}
    open={open}
    role={role}
    className={`pro-terminal-popover-surface ${className}`.trim()}
    onDismiss={reason => onOpenChange?.(false, reason)}
  />
})

function useRovingMenuFocus(open, menuRef) {
  useEffect(() => {
    if (!open) return undefined
    let frame = 0
    const focusWhenPositioned = () => {
      const menu = menuRef.current
      if (!menu || getComputedStyle(menu).visibility === 'hidden') {
        frame = requestAnimationFrame(focusWhenPositioned)
        return
      }
      menu.querySelector('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true })
    }
    frame = requestAnimationFrame(focusWhenPositioned)
    return () => cancelAnimationFrame(frame)
  }, [open, menuRef])

  return event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])]
    if (!items.length) return
    event.preventDefault()
    const current = Math.max(0, items.indexOf(document.activeElement))
    let next = current
    if (event.key === 'ArrowDown') next = (current + 1) % items.length
    if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = items.length - 1
    items[next].focus({ preventScroll: true })
  }
}

export function ContextMenu({ open, point, anchorRef, onOpenChange, label = 'Context menu', className = '', children }) {
  const menuRef = useRef(null)
  const virtualAnchor = useMemo(() => point ? ({
    left: point.x,
    right: point.x,
    top: point.y,
    bottom: point.y,
    width: 0,
    height: 0,
  }) : null, [point?.x, point?.y])
  const handleKeyDown = useRovingMenuFocus(open, menuRef)
  const close = useCallback(reason => onOpenChange?.(false, reason), [onOpenChange])
  const menuContext = useMemo(() => ({ close }), [close])

  return <MenuContext.Provider value={menuContext}>
    <PortalSurface
      ref={menuRef}
      open={open}
      anchorRef={anchorRef}
      anchorRect={virtualAnchor}
      preferredSide="bottom"
      align="start"
      role="menu"
      aria-label={label}
      className={`pro-terminal-context-menu ${className}`.trim()}
      onKeyDown={handleKeyDown}
      onDismiss={close}
      returnFocusRef={anchorRef}
    >
      {children}
    </PortalSurface>
  </MenuContext.Provider>
}

export const ContextMenuItem = forwardRef(function ContextMenuItem({ onSelect, disabled = false, className = '', children, ...props }, ref) {
  const menu = useContext(MenuContext)
  const handleClick = event => {
    if (disabled) return
    onSelect?.(event)
    if (!event.defaultPrevented) menu?.close('selection')
  }
  return <button
    {...props}
    ref={ref}
    type="button"
    role="menuitem"
    tabIndex={-1}
    disabled={disabled}
    className={`pro-terminal-context-menu__item ${className}`.trim()}
    onClick={handleClick}
  >
    {children}
  </button>
})

function visibleFocusableElements(container) {
  return [...(container?.querySelectorAll(FOCUSABLE_SELECTOR) || [])].filter(element => {
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

function useFocusTrap(open, surfaceRef, layerId, initialFocusRef) {
  useEffect(() => {
    if (!open) return undefined
    const frame = requestAnimationFrame(() => {
      const initial = initialFocusRef?.current || visibleFocusableElements(surfaceRef.current)[0] || surfaceRef.current
      initial?.focus({ preventScroll: true })
    })
    const trap = event => {
      if (event.key !== 'Tab' || !isTopLayer(layerId)) return
      const items = visibleFocusableElements(surfaceRef.current)
      if (!items.length) {
        event.preventDefault()
        surfaceRef.current?.focus({ preventScroll: true })
        return
      }
      const first = items[0]
      const last = items.at(-1)
      if (event.shiftKey && (document.activeElement === first || !surfaceRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', trap, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', trap, true)
    }
  }, [open, surfaceRef, layerId, initialFocusRef])
}

export function ModalSheet({
  open,
  onOpenChange,
  title,
  ariaLabel,
  children,
  maxHeight = '85dvh',
  className = '',
  layerClassName = '',
  returnFocusRef,
  initialFocusRef,
  draggable = true,
  portal = true,
}) {
  const { root } = useContext(PortalContext)
  const surfaceRef = useRef(null)
  const [dragOffset, setDragOffset] = useState(0)
  const dragState = useRef(null)
  const close = useCallback(reason => onOpenChange?.(false, reason), [onOpenChange])
  const canRender = open && (!portal || Boolean(root))
  const layerId = useDismissableLayer({ open: canRender, surfaceRef, onDismiss: close })
  useReturnFocus(canRender, returnFocusRef)
  useFocusTrap(canRender, surfaceRef, layerId, initialFocusRef)

  useEffect(() => {
    if (!open) setDragOffset(0)
  }, [open])

  const handlePointerDown = event => {
    if (!draggable) return
    dragState.current = { pointerId: event.pointerId, startY: event.clientY }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const handlePointerMove = event => {
    if (dragState.current?.pointerId !== event.pointerId) return
    setDragOffset(Math.max(0, event.clientY - dragState.current.startY))
  }
  const handlePointerUp = event => {
    if (dragState.current?.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    dragState.current = null
    if (dragOffset > 150) close('drag')
    else setDragOffset(0)
  }

  if (!canRender) return null
  const modal = <div className={`pro-terminal-modal-layer ${layerClassName}`.trim()}>
    <div className="pro-terminal-modal-backdrop" aria-hidden="true" />
    <section
      ref={surfaceRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel || title || 'Dialog'}
      tabIndex={-1}
      className={`pro-terminal-modal-sheet ${className}`.trim()}
      style={{ maxHeight, transform: `translateY(${dragOffset}px)` }}
    >
      {draggable && <button
        type="button"
        className="pro-terminal-modal-sheet__drag-handle"
        aria-label="Drag sheet to dismiss"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      ><span /></button>}
      {title && <header className="pro-terminal-modal-sheet__header"><h2>{title}</h2><button type="button" onClick={() => close('close-button')} aria-label="Close dialog">×</button></header>}
      <div className="pro-terminal-modal-sheet__content">{children}</div>
    </section>
  </div>

  return portal ? createPortal(modal, root) : modal
}

function defaultOptionLabel(option) {
  return option?.label || option?.symbol || option?.value || ''
}

function defaultOptionValue(option) {
  return option?.value || option?.symbol || ''
}

export function SymbolCombobox({
  options,
  value,
  onChange,
  label = 'Market',
  placeholder = 'Search symbol or asset name',
  loading = false,
  error = '',
  getOptionLabel = defaultOptionLabel,
  getOptionValue = defaultOptionValue,
}) {
  const inputRef = useRef(null)
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const selected = options.find(option => getOptionValue(option) === value)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleOptions = useMemo(() => options.filter(option => {
    const searchable = [getOptionLabel(option), option.symbol, option.name, getOptionValue(option)].filter(Boolean).join(' ').toLocaleLowerCase()
    return !normalizedQuery || searchable.includes(normalizedQuery)
  }), [options, normalizedQuery, getOptionLabel, getOptionValue])
  const activeOption = visibleOptions[activeIndex]
  const activeId = activeOption ? `${listboxId}-option-${activeIndex}` : undefined

  useEffect(() => {
    if (!open) setQuery(selected ? getOptionLabel(selected) : '')
  }, [open, selected, getOptionLabel])

  useEffect(() => {
    setActiveIndex(index => Math.min(index, Math.max(0, visibleOptions.length - 1)))
  }, [visibleOptions.length])

  const choose = option => {
    onChange?.(getOptionValue(option), option)
    setQuery(getOptionLabel(option))
    setOpen(false)
  }
  const handleKeyDown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(index => {
        if (!visibleOptions.length) return 0
        return event.key === 'ArrowDown' ? (index + 1) % visibleOptions.length : (index - 1 + visibleOptions.length) % visibleOptions.length
      })
    } else if (event.key === 'Enter' && open && activeOption) {
      event.preventDefault()
      choose(activeOption)
    }
  }

  return <div className="pro-terminal-symbol-combobox">
    <label htmlFor={`${listboxId}-input`}>{label}</label>
    <input
      ref={inputRef}
      id={`${listboxId}-input`}
      type="text"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-activedescendant={open ? activeId : undefined}
      autoComplete="off"
      value={query}
      placeholder={placeholder}
      onFocus={() => setOpen(true)}
      onClick={() => setOpen(true)}
      onChange={event => { setQuery(event.target.value); setActiveIndex(0); setOpen(true) }}
      onKeyDown={handleKeyDown}
    />
    <Popover
      open={open}
      anchorRef={inputRef}
      onOpenChange={setOpen}
      preferredSide="bottom"
      align="start"
      role="presentation"
      className="pro-terminal-symbol-listbox-surface"
    >
      <div id={listboxId} role="listbox" aria-label={`${label} results`} className="pro-terminal-symbol-listbox">
        {loading && <div role="status" className="pro-terminal-symbol-listbox__status">Loading markets…</div>}
        {!loading && error && <div role="status" className="pro-terminal-symbol-listbox__status pro-terminal-symbol-listbox__status--error">{error}</div>}
        {!loading && !error && visibleOptions.length === 0 && <div role="status" className="pro-terminal-symbol-listbox__status">No matching markets</div>}
        {!loading && !error && visibleOptions.map((option, index) => {
          const optionValue = getOptionValue(option)
          return <div
            key={optionValue}
            id={`${listboxId}-option-${index}`}
            role="option"
            aria-selected={optionValue === value}
            className={`pro-terminal-symbol-listbox__option ${index === activeIndex ? 'pro-terminal-symbol-listbox__option--active' : ''}`}
            onPointerMove={() => setActiveIndex(index)}
            onPointerDown={event => event.preventDefault()}
            onClick={() => choose(option)}
          >
            <strong>{getOptionLabel(option)}</strong>
            {option.name && <span>{option.name}</span>}
          </div>
        })}
      </div>
    </Popover>
  </div>
}
