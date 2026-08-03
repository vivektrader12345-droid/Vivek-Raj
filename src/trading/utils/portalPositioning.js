export const PORTAL_VIEWPORT_PADDING = 8
export const PORTAL_SURFACE_OFFSET = 6

const SIDES = new Set(['top', 'right', 'bottom', 'left'])
const ALIGNMENTS = new Set(['start', 'center', 'end'])

export function clampPortalCoordinate(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum
  if (maximum < minimum) return minimum
  return Math.min(Math.max(value, minimum), maximum)
}

function normalizeRect(rect = {}) {
  const left = Number(rect.left) || 0
  const top = Number(rect.top) || 0
  const width = Number.isFinite(Number(rect.width)) ? Number(rect.width) : Math.max(0, (Number(rect.right) || left) - left)
  const height = Number.isFinite(Number(rect.height)) ? Number(rect.height) : Math.max(0, (Number(rect.bottom) || top) - top)
  return {
    left,
    top,
    width: Math.max(0, width),
    height: Math.max(0, height),
    right: Number.isFinite(Number(rect.right)) ? Number(rect.right) : left + Math.max(0, width),
    bottom: Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + Math.max(0, height),
  }
}

function availableSpace(side, anchor, viewport, padding, offset) {
  if (side === 'top') return anchor.top - viewport.top - padding - offset
  if (side === 'bottom') return viewport.top + viewport.height - padding - anchor.bottom - offset
  if (side === 'left') return anchor.left - viewport.left - padding - offset
  return viewport.left + viewport.width - padding - anchor.right - offset
}

function oppositeSide(side) {
  return { top: 'bottom', right: 'left', bottom: 'top', left: 'right' }[side]
}

function alignedCoordinate(alignment, anchorStart, anchorSize, surfaceSize) {
  if (alignment === 'end') return anchorStart + anchorSize - surfaceSize
  if (alignment === 'center') return anchorStart + (anchorSize - surfaceSize) / 2
  return anchorStart
}

/**
 * Computes a fixed-position portal surface location. The returned max dimensions
 * are part of the contract: CSS must constrain oversized content before the final
 * position is measured and clamped.
 */
export function computePortalPosition({
  anchorRect,
  surfaceSize,
  viewport,
  preferredSide = 'bottom',
  align = 'start',
  padding = PORTAL_VIEWPORT_PADDING,
  offset = PORTAL_SURFACE_OFFSET,
}) {
  const anchor = normalizeRect(anchorRect)
  const viewportRect = {
    left: Number(viewport?.left) || 0,
    top: Number(viewport?.top) || 0,
    width: Math.max(0, Number(viewport?.width) || 0),
    height: Math.max(0, Number(viewport?.height) || 0),
  }
  const requestedSide = SIDES.has(preferredSide) ? preferredSide : 'bottom'
  const alignment = ALIGNMENTS.has(align) ? align : 'start'
  const width = Math.max(0, Number(surfaceSize?.width) || 0)
  const height = Math.max(0, Number(surfaceSize?.height) || 0)
  const maxWidth = Math.max(0, viewportRect.width - padding * 2)
  const maxHeight = Math.max(0, viewportRect.height - padding * 2)
  const primarySize = requestedSide === 'top' || requestedSide === 'bottom' ? height : width
  const alternate = oppositeSide(requestedSide)
  const preferredSpace = availableSpace(requestedSide, anchor, viewportRect, padding, offset)
  const alternateSpace = availableSpace(alternate, anchor, viewportRect, padding, offset)
  const side = primarySize > preferredSpace && alternateSpace > preferredSpace ? alternate : requestedSide

  let left
  let top
  if (side === 'top' || side === 'bottom') {
    left = alignedCoordinate(alignment, anchor.left, anchor.width, width)
    top = side === 'bottom' ? anchor.bottom + offset : anchor.top - height - offset
  } else {
    left = side === 'right' ? anchor.right + offset : anchor.left - width - offset
    top = alignedCoordinate(alignment, anchor.top, anchor.height, height)
  }

  const minimumLeft = viewportRect.left + padding
  const minimumTop = viewportRect.top + padding
  const maximumLeft = viewportRect.left + viewportRect.width - padding - width
  const maximumTop = viewportRect.top + viewportRect.height - padding - height

  return {
    left: clampPortalCoordinate(left, minimumLeft, maximumLeft),
    top: clampPortalCoordinate(top, minimumTop, maximumTop),
    side,
    maxWidth,
    maxHeight,
  }
}
