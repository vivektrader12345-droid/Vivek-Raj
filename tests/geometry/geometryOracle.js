const RECT_EPSILON = 0.5

export function intersects(a, b) {
  if (!a || !b) return false
  return a.left < b.right - RECT_EPSILON &&
    a.right > b.left + RECT_EPSILON &&
    a.top < b.bottom - RECT_EPSILON &&
    a.bottom > b.top + RECT_EPSILON
}

export function viewportContains(rect, viewport, inset = 0) {
  if (!rect || !viewport) return false
  return rect.left >= inset - RECT_EPSILON &&
    rect.top >= inset - RECT_EPSILON &&
    rect.right <= viewport.width - inset + RECT_EPSILON &&
    rect.bottom <= viewport.height - inset + RECT_EPSILON
}

export function generateSupportedWidths(seed = 0x51f15e, count = 32) {
  const widths = new Set([
    320, 321, 390, 599, 600, 768, 899, 900, 1024,
    1199, 1200, 1366, 1599, 1600, 1920, 2559, 2560,
  ])
  let value = seed >>> 0
  while (widths.size < count) {
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    widths.add(320 + ((value >>> 0) % (2560 - 320 + 1)))
  }
  return [...widths].sort((a, b) => a - b)
}

const violation = (kind, expectedInvariant, details) => ({ kind, expectedInvariant, ...details })

export function evaluateBugCondition(snapshot) {
  const violations = []

  const clipped = snapshot.visibleElements.filter(element =>
    element.scrollWidth > element.clientWidth + RECT_EPSILON && !element.hasApprovedInternalScroll)
  clipped.forEach(element => violations.push(violation(
    'unapproved-clipping',
    'Visible controls and surfaces must not clip unless they own an approved internal scroller.',
    { role: element.role, rect: element.rect, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth },
  )))

  snapshot.escapeCandidates.forEach(element => {
    if (!viewportContains(element.rect, snapshot.viewport, element.inset)) {
      violations.push(violation(
        element.kind === 'menu' ? 'menu-viewport-escape' : 'control-viewport-escape',
        element.kind === 'menu'
          ? 'Styled application menus must remain within an 8px viewport inset.'
          : 'Visible controls must remain inside the viewport.',
        { role: element.role, rect: element.rect, viewport: snapshot.viewport, requiredInset: element.inset },
      ))
    }
  })

  snapshot.forbiddenIntersections.forEach(pair => violations.push(violation(
    'forbidden-rectangle-intersection',
    `${pair.a.role} and ${pair.b.role} must not intersect.`,
    { a: pair.a, b: pair.b },
  )))

  if (snapshot.document.scrollWidth > snapshot.document.clientWidth + RECT_EPSILON) {
    violations.push(violation(
      'document-horizontal-overflow',
      'document.scrollWidth must equal document.clientWidth.',
      { document: snapshot.document },
    ))
  }

  const missingRoles = Object.entries(snapshot.essentialControls)
    .filter(([, reachable]) => !reachable)
    .map(([role]) => role)
  if (missingRoles.length) {
    violations.push(violation(
      'missing-essential-controls',
      'Market selection, active-chart identity, chart canvas, Paper BUY, Paper SELL, and position status must remain reachable.',
      { roles: missingRoles },
    ))
  }

  if (snapshot.viewport.width >= 1024 && (!snapshot.leftRail.reserved || !snapshot.rightRail.reserved)) {
    violations.push(violation(
      'missing-desktop-rail-reservation',
      'Desktop layouts must reserve independent left drawing and right action rail tracks.',
      { leftRail: snapshot.leftRail, rightRail: snapshot.rightRail },
    ))
  }

  snapshot.dock.adjacentTabGaps.forEach(gap => {
    if (gap.gap < 8 - RECT_EPSILON) {
      violations.push(violation(
        'crowded-dock-tabs',
        'Adjacent dock tabs must have a gap of at least 8px.',
        gap,
      ))
    }
  })

  if (snapshot.viewport.width === 1366 && snapshot.viewport.height === 768 && snapshot.sidePanelsCollapsed) {
    const minimumWidth = snapshot.viewport.width * 0.70
    const minimumHeight = snapshot.viewport.height * 0.60
    if (snapshot.chart.width < minimumWidth - RECT_EPSILON || snapshot.chart.height < minimumHeight - RECT_EPSILON) {
      violations.push(violation(
        'inadequate-default-chart-allocation',
        'At 1366x768 with side panels collapsed, the chart must be at least 70vw by 60vh.',
        { chart: snapshot.chart, minimumWidth, minimumHeight },
      ))
    }
  }

  return { isBugCondition: violations.length > 0, violations }
}

export function isBugCondition(snapshot) {
  return evaluateBugCondition(snapshot).isBugCondition
}

export function evaluateExpectedBehavior(snapshot) {
  const bug = evaluateBugCondition(snapshot)
  const violations = [...bug.violations]

  if (snapshot.viewport.width >= 1024 && snapshot.desktopHeader.height > 88 + RECT_EPSILON) {
    violations.push(violation(
      'desktop-header-height-cap',
      'The compact desktop header must be no taller than 88px.',
      { desktopHeader: snapshot.desktopHeader },
    ))
  }

  if (snapshot.leftRail.visible && !snapshot.leftRail.collapsed && snapshot.leftRail.width > 44 + RECT_EPSILON) {
    violations.push(violation(
      'expanded-left-rail-width-cap',
      'The expanded left drawing rail must be no wider than 44px.',
      { leftRail: snapshot.leftRail },
    ))
  }

  if (snapshot.rightRail.visible && !snapshot.rightRail.collapsed && snapshot.rightRail.width > 44 + RECT_EPSILON) {
    violations.push(violation(
      'expanded-right-rail-width-cap',
      'The expanded right action rail must be no wider than 44px.',
      { rightRail: snapshot.rightRail },
    ))
  }

  if (snapshot.dock.collapsed && snapshot.dock.height > 40 + RECT_EPSILON) {
    violations.push(violation(
      'collapsed-dock-height-cap',
      'The collapsed dock must be no taller than 40px.',
      { dock: snapshot.dock },
    ))
  }

  if (!snapshot.dock.collapsed && snapshot.dock.height > 240 + RECT_EPSILON) {
    violations.push(violation(
      'expanded-dock-height-cap',
      'The expanded dock must be no taller than 240px.',
      { dock: snapshot.dock },
    ))
  }

  if (!snapshot.chart.priceScaleVisible || !snapshot.chart.timeScaleVisible) {
    violations.push(violation(
      'missing-price-or-time-scale',
      'The chart price and time scales must both remain visible.',
      { chart: snapshot.chart },
    ))
  }

  snapshot.openMenus.forEach(menu => {
    if (!menu.styledApplicationControl || !viewportContains(menu.rect, snapshot.viewport, 8)) {
      violations.push(violation(
        'unsafe-application-menu',
        'Open menus must be styled application controls contained by an 8px viewport inset.',
        { menu, viewport: snapshot.viewport },
      ))
    }
  })

  return { expectedBehavior: violations.length === 0, violations }
}

export function expectedBehavior(snapshot) {
  return evaluateExpectedBehavior(snapshot).expectedBehavior
}
