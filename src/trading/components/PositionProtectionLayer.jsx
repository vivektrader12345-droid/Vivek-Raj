import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LineStyle } from 'lightweight-charts'
import useTradingStore from '../stores/tradingStore'
import { ContextMenu, ContextMenuItem } from './PortalPrimitives'
import { OrderSide, calculateProtectionMetrics, formatPrice } from '../types'

const COLORS = {
  entry: '#2196f3',
  takeProfit: '#22c997',
  stopLoss: '#f45b78',
  rewardFill: 'rgba(34, 201, 151, 0.16)',
  riskFill: 'rgba(244, 91, 120, 0.16)',
}
const normalizeSymbol = value => String(value || '').replace('/', '').toUpperCase()
const finitePrice = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null
const priceStep = price => price >= 1000 ? 0.01 : price >= 1 ? 0.0001 : 0.000001

function lineOptions(price, color, title, width = 2, style = LineStyle.Solid) {
  return {
    price,
    color,
    lineWidth: width,
    lineStyle: style,
    lineVisible: true,
    axisLabelVisible: true,
    title,
    axisLabelColor: color,
    axisLabelTextColor: '#ffffff',
  }
}

function fillSeriesOptions(entry, fill) {
  return {
    baseValue: { type: 'price', price: entry },
    topFillColor1: fill,
    topFillColor2: fill,
    bottomFillColor1: fill,
    bottomFillColor2: fill,
    topLineColor: 'rgba(0,0,0,0)',
    bottomLineColor: 'rgba(0,0,0,0)',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  }
}

function PositionProtectionLayer({ chart, series, containerRef, candles, symbol }) {
  const allPositions = useTradingStore(state => state.positions)
  const modifyPositionProtection = useTradingStore(state => state.modifyPositionProtection)
  const modifyEntryPrice = useTradingStore(state => state.modifyEntryPrice)
  const modifyStopLoss = useTradingStore(state => state.modifyStopLoss)
  const modifyTakeProfit = useTradingStore(state => state.modifyTakeProfit)
  const [menu, setMenu] = useState(null)
  const resourcesRef = useRef(new Map())
  const positionsRef = useRef([])
  const dragRef = useRef(null)
  const touchPendingRef = useRef(null)
  const frameRef = useRef(0)

  const positions = useMemo(() => allPositions.filter(position => normalizeSymbol(position.symbol) === normalizeSymbol(symbol)), [allPositions, symbol])
  useEffect(() => { positionsRef.current = positions }, [positions])

  const removeResource = useCallback(resource => {
    if (!resource) return
    for (const key of ['entryLine', 'tpLine', 'slLine']) {
      if (resource[key]) {
        try { series.removePriceLine(resource[key]) } catch {}
      }
    }
    for (const key of ['rewardSeries', 'riskSeries', 'labelSeries']) {
      if (resource[key]) {
        try { chart.removeSeries(resource[key]) } catch {}
      }
    }
  }, [chart, series])

  useEffect(() => () => {
    cancelAnimationFrame(frameRef.current)
    resourcesRef.current.forEach(removeResource)
    resourcesRef.current.clear()
  }, [removeResource])

  useEffect(() => {
    if (!chart || !series) return
    const activeIds = new Set(positions.map(position => position.id))
    resourcesRef.current.forEach((resource, id) => {
      if (!activeIds.has(id)) {
        removeResource(resource)
        resourcesRef.current.delete(id)
      }
    })

    const times = candles.map(candle => candle.time).filter(Boolean)
    const hasRange = times.length >= 2
    const startTime = hasRange ? times[Math.max(0, times.length - 48)] : null
    const endTime = hasRange ? times.at(-1) : null
    const labelTime = hasRange ? times[Math.max(0, times.length - 12)] : null

    positions.forEach(position => {
      let resource = resourcesRef.current.get(position.id)
      if (!resource) {
        resource = {
          entryLine: series.createPriceLine(lineOptions(position.entryPrice, COLORS.entry, 'Entry')),
          tpLine: null,
          slLine: null,
          rewardSeries: chart.addBaselineSeries(fillSeriesOptions(position.entryPrice, COLORS.rewardFill)),
          riskSeries: chart.addBaselineSeries(fillSeriesOptions(position.entryPrice, COLORS.riskFill)),
          labelSeries: chart.addLineSeries({ color: 'rgba(0,0,0,0)', lineVisible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
        }
        resourcesRef.current.set(position.id, resource)
      }

      const metrics = calculateProtectionMetrics(position)
      resource.entryLine.applyOptions(lineOptions(
        position.entryPrice,
        COLORS.entry,
        `Entry  ${formatPrice(position.entryPrice)}`,
        2,
      ))

      if (position.takeProfit) {
        if (!resource.tpLine) resource.tpLine = series.createPriceLine(lineOptions(position.takeProfit, COLORS.takeProfit, 'TP'))
        resource.tpLine.applyOptions(lineOptions(
          position.takeProfit,
          COLORS.takeProfit,
          `TP  ${formatPrice(position.takeProfit)}  +$${metrics.expectedProfit.toFixed(2)}  +${metrics.profitPercent.toFixed(2)}%`,
          2,
          LineStyle.Dashed,
        ))
      } else if (resource.tpLine) {
        try { series.removePriceLine(resource.tpLine) } catch {}
        resource.tpLine = null
      }

      if (position.stopLoss) {
        if (!resource.slLine) resource.slLine = series.createPriceLine(lineOptions(position.stopLoss, COLORS.stopLoss, 'SL'))
        resource.slLine.applyOptions(lineOptions(
          position.stopLoss,
          COLORS.stopLoss,
          `SL  ${formatPrice(position.stopLoss)}  -$${metrics.expectedLoss.toFixed(2)}  -${metrics.lossPercent.toFixed(2)}%`,
          2,
          LineStyle.Dashed,
        ))
      } else if (resource.slLine) {
        try { series.removePriceLine(resource.slLine) } catch {}
        resource.slLine = null
      }

      resource.rewardSeries.applyOptions(fillSeriesOptions(position.entryPrice, COLORS.rewardFill))
      resource.riskSeries.applyOptions(fillSeriesOptions(position.entryPrice, COLORS.riskFill))
      resource.rewardSeries.setData(hasRange && position.takeProfit ? [{ time: startTime, value: position.takeProfit }, { time: endTime, value: position.takeProfit }] : [])
      resource.riskSeries.setData(hasRange && position.stopLoss ? [{ time: startTime, value: position.stopLoss }, { time: endTime, value: position.stopLoss }] : [])

      if (labelTime && position.takeProfit && position.stopLoss) {
        const labelPrice = (position.takeProfit + position.stopLoss) / 2
        resource.labelSeries.setData([{ time: labelTime, value: labelPrice }])
        resource.labelSeries.setMarkers([{
          time: labelTime,
          position: 'inBar',
          color: 'rgba(15, 23, 42, 0.94)',
          shape: 'circle',
          size: 1,
          text: `R:R 1:${metrics.riskRewardRatio.toFixed(2)}   +$${metrics.expectedProfit.toFixed(2)} / -$${metrics.expectedLoss.toFixed(2)}`,
        }])
      } else {
        resource.labelSeries.setData([])
        resource.labelSeries.setMarkers([])
      }
    })
  }, [candles, chart, positions, removeResource, series])

  const nearestLine = useCallback((clientY, threshold = 10) => {
    const element = containerRef.current
    if (!element || !series) return null
    const y = clientY - element.getBoundingClientRect().top
    let nearest = null
    for (const position of positionsRef.current) {
      const candidates = [
        ['entry', position.entryPrice],
        ['tp', position.takeProfit],
        ['sl', position.stopLoss],
      ]
      for (const [type, price] of candidates) {
        if (!price) continue
        const coordinate = series.priceToCoordinate(price)
        if (coordinate == null) continue
        const distance = Math.abs(coordinate - y)
        if (distance <= threshold && (!nearest || distance < nearest.distance)) nearest = { type, position, distance }
      }
    }
    return nearest
  }, [containerRef, series])

  const setInteractionMode = useCallback(active => {
    const element = containerRef.current
    if (element) {
      element.style.cursor = active ? 'ns-resize' : ''
      element.style.touchAction = active ? 'none' : ''
    }
    chart?.applyOptions({
      handleScroll: { mouseWheel: true, pressedMouseMove: !active, horzTouchDrag: !active, vertTouchDrag: !active },
      handleScale: { mouseWheel: true, pinch: !active, axisPressedMouseMove: !active, axisDoubleClickReset: true },
    })
  }, [chart, containerRef])

  const startDrag = useCallback((event, hit) => {
    const position = positionsRef.current.find(item => item.id === hit.position.id)
    if (!position) return
    dragRef.current = {
      pointerId: event.pointerId,
      type: hit.type,
      positionId: position.id,
      initialEntry: position.entryPrice,
      initialTP: position.takeProfit,
      initialSL: position.stopLoss,
      latestY: event.clientY,
    }
    try { containerRef.current?.setPointerCapture(event.pointerId) } catch {}
    setInteractionMode(true)
  }, [containerRef, setInteractionMode])

  const applyDrag = useCallback(() => {
    frameRef.current = 0
    const drag = dragRef.current
    const element = containerRef.current
    const position = positionsRef.current.find(item => item.id === drag?.positionId)
    if (!drag || !element || !position || !series) return
    const price = finitePrice(series.coordinateToPrice(drag.latestY - element.getBoundingClientRect().top))
    if (!price) return
    const step = priceStep(position.entryPrice)
    const direction = position.side === OrderSide.BUY ? 1 : -1
    if (drag.type === 'entry') {
      const delta = price - drag.initialEntry
      modifyPositionProtection(position.id, {
        entryPrice: price,
        takeProfit: drag.initialTP ? Math.max(step, drag.initialTP + delta) : null,
        stopLoss: drag.initialSL ? Math.max(step, drag.initialSL + delta) : null,
      })
    } else if (drag.type === 'tp') {
      const clamped = direction > 0 ? Math.max(position.entryPrice + step, price) : Math.min(position.entryPrice - step, price)
      modifyTakeProfit(position.id, clamped)
    } else {
      const clamped = direction > 0 ? Math.min(position.entryPrice - step, price) : Math.max(position.entryPrice + step, price)
      modifyStopLoss(position.id, Math.max(step, clamped))
    }
  }, [containerRef, modifyPositionProtection, modifyStopLoss, modifyTakeProfit, series])

  useEffect(() => {
    const element = containerRef.current
    if (!element || !chart || !series) return undefined
    const cancelTouchPending = () => {
      if (touchPendingRef.current?.timer) clearTimeout(touchPendingRef.current.timer)
      touchPendingRef.current = null
    }
    const onPointerDown = event => {
      if (event.button !== 0) return
      const hit = nearestLine(event.clientY, event.pointerType === 'touch' ? 18 : 10)
      if (!hit) return
      if (event.pointerType === 'touch') {
        const pending = { x: event.clientX, y: event.clientY, hit, event, timer: 0 }
        pending.timer = window.setTimeout(() => {
          touchPendingRef.current = null
          startDrag(event, hit)
          navigator.vibrate?.(20)
        }, 360)
        touchPendingRef.current = pending
        return
      }
      event.preventDefault()
      event.stopPropagation()
      startDrag(event, hit)
    }
    const onPointerMove = event => {
      const pending = touchPendingRef.current
      if (pending && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8) cancelTouchPending()
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      drag.latestY = event.clientY
      if (!frameRef.current) frameRef.current = requestAnimationFrame(applyDrag)
    }
    const finishDrag = event => {
      cancelTouchPending()
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      drag.latestY = event.clientY
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      applyDrag()
      dragRef.current = null
      setInteractionMode(false)
      try { element.releasePointerCapture(event.pointerId) } catch {}
    }
    const onContextMenu = event => {
      const hit = nearestLine(event.clientY, 12)
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      setMenu({ x: event.clientX, y: event.clientY, positionId: hit.position.id, type: hit.type })
    }
    element.addEventListener('pointerdown', onPointerDown, true)
    element.addEventListener('pointermove', onPointerMove, { capture: true, passive: false })
    element.addEventListener('pointerup', finishDrag, true)
    element.addEventListener('pointercancel', finishDrag, true)
    element.addEventListener('contextmenu', onContextMenu, true)
    return () => {
      cancelTouchPending()
      cancelAnimationFrame(frameRef.current)
      element.removeEventListener('pointerdown', onPointerDown, true)
      element.removeEventListener('pointermove', onPointerMove, true)
      element.removeEventListener('pointerup', finishDrag, true)
      element.removeEventListener('pointercancel', finishDrag, true)
      element.removeEventListener('contextmenu', onContextMenu, true)
      setInteractionMode(false)
    }
  }, [applyDrag, chart, containerRef, nearestLine, series, setInteractionMode, startDrag])

  const updateFromPrompt = useCallback((mode, valueType) => {
    const position = positionsRef.current.find(item => item.id === menu?.positionId)
    if (!position) return
    const current = mode === 'tp' ? position.takeProfit : mode === 'sl' ? position.stopLoss : position.entryPrice
    const label = valueType === 'price' ? `${mode.toUpperCase()} price` : valueType === 'percent' ? `${mode.toUpperCase()} distance (%)` : `${mode.toUpperCase()} expected amount ($)`
    const raw = window.prompt(label, valueType === 'price' ? String(current || position.entryPrice) : '')
    const value = finitePrice(raw)
    if (!value) return
    const direction = position.side === OrderSide.BUY ? 1 : -1
    let price = value
    if (valueType === 'percent') price = position.entryPrice * (1 + (mode === 'tp' ? direction : -direction) * value / 100)
    if (valueType === 'amount') {
      const delta = value / Math.max(Number(position.qty) * Number(position.leverage), Number.EPSILON)
      price = position.entryPrice + (mode === 'tp' ? direction : -direction) * delta
    }
    if (mode === 'tp') modifyTakeProfit(position.id, price)
    else if (mode === 'sl') modifyStopLoss(position.id, price)
    else modifyEntryPrice(position.id, price)
  }, [menu, modifyEntryPrice, modifyStopLoss, modifyTakeProfit])

  const selectedPosition = positions.find(position => position.id === menu?.positionId)
  return <ContextMenu open={Boolean(menu)} point={menu} onOpenChange={open => { if (!open) setMenu(null) }} label="Position line actions" className="position-protection-menu">
    {menu?.type === 'entry' && <>
      <ContextMenuItem onSelect={() => updateFromPrompt('entry', 'price')}>Edit Entry</ContextMenuItem>
      <ContextMenuItem onSelect={() => updateFromPrompt('entry', 'price')}>Set Entry by Price</ContextMenuItem>
    </>}
    {menu?.type === 'tp' && <>
      <ContextMenuItem onSelect={() => updateFromPrompt('tp', 'price')}>Edit TP</ContextMenuItem>
      <ContextMenuItem onSelect={() => modifyTakeProfit(menu.positionId, null)} className="text-rose-300">Delete TP</ContextMenuItem>
      <ContextMenuItem onSelect={() => updateFromPrompt('tp', 'price')}>Set TP by Price</ContextMenuItem>
      <ContextMenuItem onSelect={() => updateFromPrompt('tp', 'percent')}>Set TP by %</ContextMenuItem>
      <ContextMenuItem onSelect={() => updateFromPrompt('tp', 'amount')}>Set TP by $</ContextMenuItem>
    </>}
    {menu?.type === 'sl' && <>
      <ContextMenuItem onSelect={() => updateFromPrompt('sl', 'price')}>Edit SL</ContextMenuItem>
      <ContextMenuItem onSelect={() => modifyStopLoss(menu.positionId, null)} className="text-rose-300">Delete SL</ContextMenuItem>
      <ContextMenuItem onSelect={() => selectedPosition && modifyStopLoss(selectedPosition.id, selectedPosition.entryPrice)}>Move Stop Loss to Break Even</ContextMenuItem>
      <ContextMenuItem onSelect={() => updateFromPrompt('sl', 'percent')}>Set SL by %</ContextMenuItem>
      <ContextMenuItem onSelect={() => updateFromPrompt('sl', 'amount')}>Set SL by $</ContextMenuItem>
    </>}
  </ContextMenu>
}

export default React.memo(PositionProtectionLayer)
