(() => {
  if (window.__VMT_CANVAS_BRIDGE__) return
  window.__VMT_CANVAS_BRIDGE__ = true

  const EVENT_SOURCE = 'vivek-marco-trader-extension'
  const MAX_ITEM_AGE_MS = 5_000
  const MAX_ITEMS = 800
  const items = new Map()
  let lastRenderAt = 0

  const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim()

  function prune(now = Date.now()) {
    for (const [key, item] of items) {
      if (now - item.timestamp > MAX_ITEM_AGE_MS) items.delete(key)
    }
    while (items.size > MAX_ITEMS) items.delete(items.keys().next().value)
  }

  function recordText(context, value, x, y, stroke = false) {
    const text = cleanText(value)
    const canvas = context?.canvas
    const rect = canvas?.getBoundingClientRect?.()
    if (!text || !rect || rect.width <= 0 || rect.height <= 0) return

    const transform = context.getTransform?.()
    const point = transform?.transformPoint
      ? transform.transformPoint(new DOMPoint(Number(x) || 0, Number(y) || 0))
      : { x: Number(x) || 0, y: Number(y) || 0 }
    const scaleX = rect.width / Math.max(canvas.width, 1)
    const scaleY = rect.height / Math.max(canvas.height, 1)
    const metrics = context.measureText?.(text)
    const fontSize = Number(String(context.font || '').match(/([\d.]+)px/)?.[1]) || 12
    const width = Math.max(1, Number(metrics?.width) || text.length * fontSize * 0.5) * scaleX
    const height = Math.max(1, fontSize * scaleY)
    const left = rect.left + point.x * scaleX
    const top = rect.top + point.y * scaleY - height
    const style = stroke ? context.strokeStyle : context.fillStyle
    const color = typeof style === 'string' ? style : ''
    const timestamp = Date.now()
    lastRenderAt = timestamp
    const key = `${text}|${Math.round(left)}|${Math.round(top)}|${color}`

    items.set(key, { text, left, top, width, height, color, timestamp })
    prune(timestamp)
  }

  function wrap(methodName, stroke) {
    const original = CanvasRenderingContext2D.prototype[methodName]
    if (typeof original !== 'function') return
    CanvasRenderingContext2D.prototype[methodName] = function wrappedCanvasText(value, x, y, ...rest) {
      const result = original.call(this, value, x, y, ...rest)
      try { recordText(this, value, x, y, stroke) } catch { /* capture must never break chart rendering */ }
      return result
    }
  }

  wrap('fillText', false)
  wrap('strokeText', true)

  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== EVENT_SOURCE || event.data.type !== 'VMT_REQUEST_CANVAS_TEXT') return
    const responseAt = Date.now()
    prune(responseAt)
    window.postMessage({
      source: EVENT_SOURCE,
      type: 'VMT_CANVAS_TEXT',
      items: Array.from(items.values()),
      timestamp: lastRenderAt,
      responseAt,
    }, window.location.origin)
  })

  window.postMessage({ source: EVENT_SOURCE, type: 'VMT_BRIDGE_READY', timestamp: Date.now() }, window.location.origin)
})()
