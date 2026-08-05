export const HISTORY_DISPLAY_PLACEHOLDER = '-'

const SUPPORTED_DIRECTIONS = new Set(['long', 'short'])
const SEARCHABLE_FIELDS = ['pair', 'strategy', 'notes']

function safeText(value) {
  return typeof value === 'string' ? value : ''
}

function displayText(value) {
  return value.length > 0 ? value : HISTORY_DISPLAY_PLACEHOLDER
}

function normalizeNumber(rawValue) {
  let value = null
  if (typeof rawValue === 'number') {
    value = Number.isFinite(rawValue) ? rawValue : null
  } else if (typeof rawValue === 'string' && rawValue.trim() !== '') {
    const parsed = Number(rawValue)
    value = Number.isFinite(parsed) ? parsed : null
  }

  return {
    raw: rawValue,
    value,
    isFinite: value !== null,
    display: value === null ? HISTORY_DISPLAY_PLACEHOLDER : String(rawValue),
    exportValue: value === null ? '' : rawValue,
  }
}

function normalizeDate(rawValue) {
  let value = null
  if (rawValue instanceof Date) {
    value = new Date(rawValue.getTime())
  } else if (
    (typeof rawValue === 'string' && rawValue.trim() !== '') ||
    (typeof rawValue === 'number' && Number.isFinite(rawValue))
  ) {
    value = new Date(rawValue)
  }

  const isValid = value !== null && Number.isFinite(value.getTime())
  if (!isValid) {
    return {
      raw: rawValue,
      value: null,
      timestamp: null,
      isValid: false,
      display: HISTORY_DISPLAY_PLACEHOLDER,
      exportValue: '',
      month: null,
      year: null,
      day: null,
      week: null,
    }
  }

  return {
    raw: rawValue,
    value,
    timestamp: value.getTime(),
    isValid: true,
    display: value.toLocaleDateString(),
    exportValue: rawValue instanceof Date ? rawValue.toISOString() : rawValue,
    month: value.getMonth(),
    year: value.getFullYear(),
    day: value.getDay(),
    week: Math.ceil(value.getDate() / 7),
  }
}

function normalizeDirection(rawValue) {
  const isSupported = typeof rawValue === 'string' && SUPPORTED_DIRECTIONS.has(rawValue)
  const value = isSupported ? rawValue : 'unknown'
  return {
    raw: rawValue,
    value,
    isSupported,
    label: isSupported ? rawValue.toUpperCase() : 'Unknown',
    exportValue: value,
  }
}

function normalizeRating(rawValue) {
  const number = normalizeNumber(rawValue)
  const value = number.isFinite
    ? Math.min(5, Math.max(0, Math.trunc(number.value)))
    : 0
  return {
    raw: rawValue,
    value,
    display: '⭐'.repeat(value),
    exportValue: number.isFinite ? value : '',
  }
}

function normalizeTags(rawValue) {
  if (typeof rawValue === 'string') {
    return {
      raw: rawValue,
      values: [rawValue],
      searchText: rawValue.toLowerCase(),
      display: displayText(rawValue),
    }
  }

  if (Array.isArray(rawValue)) {
    const values = rawValue.filter(value => typeof value === 'string')
    const text = values.join(', ')
    return {
      raw: rawValue,
      values,
      searchText: values.join(' ').toLowerCase(),
      display: displayText(text),
    }
  }

  return {
    raw: rawValue,
    values: [],
    searchText: '',
    display: HISTORY_DISPLAY_PLACEHOLDER,
  }
}

/**
 * Projects a Firestore-shaped trade into safe, render-only History values.
 * The source object and its identity are retained by reference and never mutated.
 */
export function normalizeTradeForHistory(rawTrade) {
  const source = rawTrade !== null && typeof rawTrade === 'object' && !Array.isArray(rawTrade)
    ? rawTrade
    : {}

  const text = {
    pair: safeText(source.pair),
    strategy: safeText(source.strategy),
    notes: safeText(source.notes),
    session: safeText(source.session),
    time: safeText(source.time),
    timeframe: safeText(source.timeframe),
    emotion: safeText(source.emotion),
    screenshot: safeText(source.screenshot),
  }
  const direction = normalizeDirection(source.type)
  const date = normalizeDate(source.date)
  const numbers = {
    entryPrice: normalizeNumber(source.entryPrice),
    exitPrice: normalizeNumber(source.exitPrice),
    quantity: normalizeNumber(source.quantity),
    leverage: normalizeNumber(source.leverage),
    pnl: normalizeNumber(source.pnl),
    pnlPercent: normalizeNumber(source.pnlPercent),
    fees: normalizeNumber(source.fees),
  }
  const rating = normalizeRating(source.rating)
  const tags = normalizeTags(source.tags)
  const result = numbers.pnl.isFinite
    ? numbers.pnl.value > 0
      ? 'win'
      : numbers.pnl.value < 0
        ? 'loss'
        : 'breakeven'
    : 'unknown'
  const searchValues = [
    ...SEARCHABLE_FIELDS.map(field => text[field].toLowerCase()),
    tags.searchText,
  ]

  return {
    rawTrade,
    rawReference: rawTrade,
    id: source.id,
    identity: {
      id: source.id,
      reference: rawTrade,
    },
    text,
    direction,
    date,
    numbers,
    rating,
    tags,
    result,
    searchValues,
    searchKey: searchValues.join(' '),
    sortKeys: {
      date: date.timestamp,
      pair: text.pair,
      pnl: numbers.pnl.value,
    },
    totalPnlValue: numbers.pnl.isFinite ? numbers.pnl.value : 0,
    display: {
      id: displayText(safeText(source.id)),
      date: date.display,
      pair: displayText(text.pair),
      type: direction.label,
      entryPrice: numbers.entryPrice.display,
      exitPrice: numbers.exitPrice.display,
      quantity: numbers.quantity.display,
      leverage: numbers.leverage.isFinite
        ? String(source.leverage || 1)
        : '1',
      pnl: numbers.pnl.display,
      pnlPercent: numbers.pnlPercent.isFinite && numbers.pnlPercent.value !== 0
        ? numbers.pnlPercent.value
        : null,
      strategy: displayText(text.strategy),
      session: displayText(text.session),
      time: text.time,
      timeframe: text.timeframe,
      emotion: text.emotion,
      notes: text.notes,
      screenshot: text.screenshot,
      rating: rating.display,
      tags: tags.display,
    },
    exportValues: {
      date: date.exportValue,
      pair: text.pair,
      type: direction.exportValue,
      entryPrice: numbers.entryPrice.exportValue,
      exitPrice: numbers.exitPrice.exportValue,
      quantity: numbers.quantity.exportValue,
      leverage: numbers.leverage.isFinite ? source.leverage || 1 : 1,
      pnl: numbers.pnl.exportValue,
      strategy: text.strategy,
      fees: numbers.fees.isFinite ? source.fees || 0 : 0,
      notes: text.notes,
    },
  }
}

export function normalizeTradesForHistory(trades) {
  return Array.isArray(trades) ? trades.map(normalizeTradeForHistory) : []
}

function parseFilterInteger(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseFilterDate(value) {
  if (typeof value !== 'string' || value === '') return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null
}

export function filterHistoryTrades(viewModels, filters = {}) {
  if (!Array.isArray(viewModels)) return []

  const searchTerm = safeText(filters.searchTerm).toLowerCase()
  const type = safeText(filters.type) || 'all'
  const result = safeText(filters.result) || 'all'
  const strategy = safeText(filters.strategy) || 'all'
  const month = parseFilterInteger(filters.month)
  const year = parseFilterInteger(filters.year)
  const week = parseFilterInteger(filters.week)
  const day = parseFilterInteger(filters.day)
  const session = safeText(filters.session) || 'all'
  const fromDate = parseFilterDate(filters.fromDate)
  const toDate = parseFilterDate(filters.toDate)

  return viewModels.filter(trade => {
    const matchSearch = trade.searchValues.some(value => value.includes(searchTerm))
    const matchType = type === 'all' || trade.direction.value === type
    const matchResult = result === 'all' || trade.result === result
    const matchStrategy = strategy === 'all' || trade.text.strategy === strategy
    const matchMonth = month === null || trade.date.month === month
    const matchYear = year === null || trade.date.year === year
    const matchWeek = week === null || trade.date.week === week
    const matchDay = day === null || trade.date.day === day
    const matchSession = session === 'all' || trade.text.session.toLowerCase().includes(session.toLowerCase())
    const matchFromDate = fromDate === null || (trade.date.isValid && trade.date.timestamp >= fromDate)
    const matchToDate = toDate === null || (trade.date.isValid && trade.date.timestamp <= toDate)

    return matchSearch && matchType && matchResult && matchStrategy && matchMonth &&
      matchYear && matchWeek && matchDay && matchSession && matchFromDate && matchToDate
  })
}

function compareOptionalNumbers(left, right, descending) {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return descending ? right - left : left - right
}

export function sortHistoryTrades(viewModels, sortBy = 'date-desc') {
  if (!Array.isArray(viewModels)) return []
  const sorted = [...viewModels]

  sorted.sort((left, right) => {
    switch (sortBy) {
      case 'date-desc':
        return compareOptionalNumbers(left.sortKeys.date, right.sortKeys.date, true)
      case 'date-asc':
        return compareOptionalNumbers(left.sortKeys.date, right.sortKeys.date, false)
      case 'pnl-desc':
        return compareOptionalNumbers(left.sortKeys.pnl, right.sortKeys.pnl, true)
      case 'pnl-asc':
        return compareOptionalNumbers(left.sortKeys.pnl, right.sortKeys.pnl, false)
      case 'pair':
        return left.sortKeys.pair.localeCompare(right.sortKeys.pair)
      default:
        return 0
    }
  })

  return sorted
}

export function projectHistoryTrades(viewModels, filters = {}, sortBy = 'date-desc') {
  return sortHistoryTrades(filterHistoryTrades(viewModels, filters), sortBy)
}

export function sumHistoryPnl(viewModels) {
  if (!Array.isArray(viewModels)) return 0
  return viewModels.reduce((sum, trade) => sum + trade.totalPnlValue, 0)
}

export function getHistoryStrategies(viewModels) {
  if (!Array.isArray(viewModels)) return []
  return [...new Set(viewModels.map(trade => trade.text.strategy).filter(Boolean))].sort()
}

/**
 * Safely parses local-storage custom options. Non-array or corrupt legacy data
 * is ignored; valid string entries retain their original value and order.
 */
export function parseHistoryCustomOptions(serializedOptions) {
  let parsed
  if (Array.isArray(serializedOptions)) {
    parsed = serializedOptions
  } else if (typeof serializedOptions === 'string') {
    try {
      parsed = JSON.parse(serializedOptions)
    } catch {
      return []
    }
  } else {
    return []
  }

  if (!Array.isArray(parsed) || !parsed.every(option => typeof option === 'string')) {
    return []
  }

  // Return a copy so callers can append options without mutating an array input.
  return [...parsed]
}
