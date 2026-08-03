/**
 * CSV Importer — Production-Ready Trading History Parser
 *
 * Supports the canonical Trading History CSV format and any column-reordered
 * variant of it.  Every column is preserved; empty cells are stored as null.
 *
 * Duplicate detection uses THREE independent keys (any match = duplicate):
 *   1. tradeId  field
 *   2. orderId  field
 *   3. Composite: pair|direction|entryPrice|entryTime
 */

// ---------------------------------------------------------------------------
// COLUMN MAP
// Keys are the canonical internal field names.
// Values are ordered arrays of possible CSV header strings (case-insensitive).
// The FIRST match wins, so put the most specific header first.
// ---------------------------------------------------------------------------
export const COLUMN_MAP = {
  // ── Identity ──────────────────────────────────────────────────────────────
  tradeId:          ['trade id', 'tradeid', 'trade #', 'trade#', 'tid', 'trade no', 'trade no.'],
  orderId:          ['order id', 'orderid', 'order #', 'order#', 'oid', 'order no', 'order no.'],

  // ── Pair / symbol ─────────────────────────────────────────────────────────
  // "Trading Pair" is the EXACT header in the screenshot — list it first
  pair:             ['trading pair', 'pair', 'symbol', 'ticker', 'instrument', 'market', 'contract',
                     'asset', 'coin', 'crypto pair'],

  // ── Direction ─────────────────────────────────────────────────────────────
  // "Direction" is the EXACT header in the screenshot
  direction:        ['direction', 'side', 'type', 'action', 'trade type', 'order type',
                     'buy/sell', 'long/short', 'position'],

  // ── Sizing ────────────────────────────────────────────────────────────────
  quantity:         ['quantity', 'qty', 'size', 'amount', 'contracts', 'volume',
                     'lots', 'position size', 'units', 'no. of units'],
  // "Leverage" is the EXACT header in the screenshot (col I)
  leverage:         ['leverage', 'lev', 'x', 'multiplier'],
  // "Margin" is the EXACT header in the screenshot (col J) — values like "31,952.95 USD"
  // Maps to "Entry Margin ($)" field in the software (entryMargin)
  entryMargin:      ['margin', 'initial margin', 'entry margin', 'collateral',
                     'used margin', 'margin used', 'position margin',
                     'required margin', 'opening margin'],

  // ── Prices ────────────────────────────────────────────────────────────────
  // "Entry Price" is the EXACT header in the screenshot (col D)
  entryPrice:       ['entry price', 'entry', 'avg entry', 'open price', 'buy price',
                     'entry avg', 'open', 'entryprice', 'average entry'],
  exitPrice:        ['exit price', 'exit price', 'exitprice', 'exit', 'avg exit',
                     'close price', 'sell price', 'exit avg', 'close',
                     'average exit', 'closing price', 'exit avg price'],
  // "Take Profit" is the EXACT header in the screenshot (col E)
  takeProfit:       ['take profit', 'takeprofit', 'take-profit', 'tp', 'target',
                     'take profit price', 'tp price', 'profit target'],
  // "Stop Loss" is the EXACT header in the screenshot (col F)
  stopLoss:         ['stop loss', 'stoploss', 'stop-loss', 'sl', 'stop',
                     'stop loss price', 'sl price', 'stop price'],

  // ── PnL ───────────────────────────────────────────────────────────────────
  // "Profit/Loss Amount" is the EXACT header in the screenshot (col G) — values like "+69.15 USD"
  pnlAmount:        ['profit/loss amount', 'profit/loss', 'pnl amount', 'pnl',
                     'p&l', 'profit', 'net profit', 'realized pnl', 'realized profit',
                     'gross profit', 'return', 'net pnl', 'gain/loss', 'gain loss',
                     'profit & loss', 'profit and loss'],
  pnlPercent:       ['pnl %', 'pnl percent', 'pnl percentage', 'profit %',
                     'profit percent', 'return %', '% return', 'roi', 'roi %',
                     '% change', 'gain %', 'profit/loss %', 'profit/loss percent'],

  // ── Capture ───────────────────────────────────────────────────────────────
  capturePoints:    ['capture points', 'points captured', 'points', 'captured points',
                     'pip capture', 'pips', 'point capture'],
  // "Capture%" is the EXACT header in the screenshot (col H) — values like "0.02%"
  capturePercent:   ['capture%', 'capture %', 'capture percent', 'capture percentage',
                     '% capture', 'captured %', 'capture%'],

  // ── Fees ──────────────────────────────────────────────────────────────────
  fees:             ['fees', 'fee', 'commission', 'trading fee', 'total fees',
                     'transaction fee', 'brokerage', 'charges'],

  // ── Timing ────────────────────────────────────────────────────────────────
  entryTime:        ['entry time', 'entry date', 'entry date/time', 'entrytime',
                     'open time', 'open date', 'open date/time',
                     'date/time', 'date', 'time', 'entry datetime', 'opened at',
                     'entry timestamp', 'trade date'],
  exitTime:         ['exit time', 'exit date', 'exit date/time', 'exittime',
                     'close time', 'close date', 'close date/time',
                     'exit datetime', 'closed at', 'exit timestamp'],
  duration:         ['duration', 'hold time', 'holding time', 'time in trade',
                     'trade duration', 'holding period'],

  // ── Status ────────────────────────────────────────────────────────────────
  status:           ['status', 'trade status', 'state', 'result', 'outcome'],

  // ── Extra / passthrough ───────────────────────────────────────────────────
  strategy:         ['strategy', 'strategy name', 'setup', 'signal', 'pattern', 'system'],
  notes:            ['notes', 'note', 'comment', 'comments', 'description', 'remarks', 'memo'],
  exchange:         ['exchange', 'broker', 'platform', 'venue', 'exchange name'],
  session:          ['session', 'trading session', 'market session'],
  timeframe:        ['timeframe', 'time frame', 'tf', 'interval', 'chart timeframe'],
  tags:             ['tags', 'label', 'labels', 'category', 'tag'],
}

// ---------------------------------------------------------------------------
// SANITISATION
// ---------------------------------------------------------------------------

/** Strip characters that could cause XSS; trims whitespace. */
function sanitize(str) {
  if (str === null || str === undefined) return null
  if (typeof str !== 'string') return str
  return str.replace(/[<>&"'`]/g, '').trim()
}

/** Return null for truly-empty strings, otherwise the sanitized value. */
function nullOrString(raw) {
  const s = sanitize(raw)
  return (s === '' || s === null) ? null : s
}

// ---------------------------------------------------------------------------
// CSV PARSING  (handles quoted fields, auto-detects separator)
// ---------------------------------------------------------------------------

function detectSeparator(line) {
  const counts = { ',': 0, ';': 0, '\t': 0 }
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue }
    if (!inQuotes && counts[ch] !== undefined) counts[ch]++
  }
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t'
  if (counts[';'] > counts[',']) return ';'
  return ','
}

function parseCSVLine(line, sep) {
  const result = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++ } // escaped quote
      else inQ = !inQ
    } else if (ch === sep && !inQ) {
      result.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  result.push(cur)
  return result
}

/**
 * Parse raw CSV text into { headers: string[], rows: object[] }
 * Rows are plain objects keyed by the lowercased header name.
 * Each value is a raw string (may be empty).
 */
export function parseCSVText(csvText) {
  const lines = csvText.split(/\r?\n/)
  // Find the first non-empty line as the header
  let headerLineIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) { headerLineIdx = i; break }
  }
  if (headerLineIdx === -1) return { headers: [], rows: [] }

  const sep = detectSeparator(lines[headerLineIdx])
  const headers = parseCSVLine(lines[headerLineIdx], sep).map(h => h.trim().toLowerCase())

  const rows = []
  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const values = parseCSVLine(line, sep)
    // Skip rows where every cell is empty
    if (values.every(v => !v.trim())) continue
    const row = {}
    headers.forEach((h, idx) => {
      row[h] = values[idx] !== undefined ? values[idx].trim() : ''
    })
    rows.push(row)
  }
  return { headers, rows }
}

// ---------------------------------------------------------------------------
// COLUMN MAPPING  (auto-detect which CSV column → which field)
// ---------------------------------------------------------------------------

/**
 * Build a { fieldName → csvHeader } lookup from the parsed headers array.
 * Unknown CSV headers are collected into `unmapped` so they can be stored
 * in trade.rawExtra without any data loss.
 */
export function buildColumnMapping(headers) {
  const mapping = {}          // fieldName → csvHeader
  const usedHeaders = new Set()

  for (const [field, candidates] of Object.entries(COLUMN_MAP)) {
    for (const candidate of candidates) {
      // Exact match first, then "starts with" fallback
      const exact = headers.find(h => h === candidate)
      if (exact) { mapping[field] = exact; usedHeaders.add(exact); break }
      const partial = headers.find(h => h.startsWith(candidate) || candidate.startsWith(h))
      if (partial && !usedHeaders.has(partial)) {
        mapping[field] = partial; usedHeaders.add(partial); break
      }
    }
  }

  // Collect headers not claimed by any canonical field
  const unmapped = headers.filter(h => !usedHeaders.has(h))
  return { mapping, unmapped }
}

// ---------------------------------------------------------------------------
// VALUE PARSERS  (strict — return null on invalid input, never NaN)
// ---------------------------------------------------------------------------

/**
 * Parse a numeric string.
 * Handles all formats seen in the screenshot:
 *   "+69.15 USD"  →  69.15
 *   "-120.00 USD" → -120.00
 *   "31,952.95 USD" → 31952.95
 *   "0.02%"  →  0.02
 *   "63,892"  →  63892
 *   "1"  →  1
 * Returns null (never NaN) for empty or truly unparseable cells.
 */
export function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  let s = String(raw).trim()
  if (s === '' || s.toLowerCase() === 'n/a' || s === '-') return null

  // Strip trailing currency codes (USD, USDT, BTC, ETH, etc.) — case-insensitive
  s = s.replace(/\s+[A-Z]{2,5}$/i, '').trim()

  // Strip currency symbols
  s = s.replace(/[$€£¥₹₿]/g, '').trim()

  // Strip commas used as thousands separators
  s = s.replace(/,/g, '')

  // Strip trailing/leading % (we store the raw number; caller knows it's a percent)
  s = s.replace(/%/g, '').trim()

  // Allow leading + sign
  if (s.startsWith('+')) s = s.slice(1).trim()

  if (s === '') return null
  const n = Number(s)
  return isNaN(n) ? null : n
}

/**
 * Parse a date/time string into an ISO-8601 string.
 * Tries multiple common formats.  Returns null on failure.
 */
export function parseDateTime(raw) {
  if (!raw || raw.trim() === '') return null
  const s = raw.trim()

  // Native Date parse (handles ISO, RFC etc.)
  let d = new Date(s)
  if (!isNaN(d.getTime())) return d.toISOString()

  // DD/MM/YYYY HH:MM or DD-MM-YYYY HH:MM
  const ddmmyyyy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (ddmmyyyy) {
    const [, dd, mm, yyyy, hh = '0', min = '0', ss = '0'] = ddmmyyyy
    const year = yyyy.length === 2 ? `20${yyyy}` : yyyy
    d = new Date(`${year}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T${hh.padStart(2,'0')}:${min.padStart(2,'0')}:${ss.padStart(2,'0')}`)
    if (!isNaN(d.getTime())) return d.toISOString()
  }

  // MM/DD/YYYY
  const mmddyyyy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(.*)/)
  if (mmddyyyy) {
    const [, mm, dd, yyyy, rest] = mmddyyyy
    d = new Date(`${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}${rest.trim()}`)
    if (!isNaN(d.getTime())) return d.toISOString()
  }

  return null   // failed — caller will decide what to do
}

/** Normalise direction to 'long' | 'short' — handles "Long", "Short", "BUY", "SELL" etc. */
function normalizeDirection(raw) {
  if (!raw) return null
  const v = raw.toLowerCase().trim()
  if (['buy', 'long', 'b', 'l', 'buy/long'].includes(v)) return 'long'
  if (['sell', 'short', 's', 'sh', 'sell/short'].includes(v)) return 'short'
  return null
}

/** Compute human-readable duration from two ISO strings */
function calcDuration(start, end) {
  if (!start || !end) return null
  const ms = new Date(end) - new Date(start)
  if (ms <= 0 || isNaN(ms)) return null
  const totalMin = Math.floor(ms / 60000)
  const days = Math.floor(totalMin / 1440)
  const hrs  = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days > 0) return `${days}d ${hrs}h ${mins}m`
  if (hrs  > 0) return `${hrs}h ${mins}m`
  return `${mins}m`
}

// ---------------------------------------------------------------------------
// TIMEZONE HELPERS
// ---------------------------------------------------------------------------

/**
 * Get the current date-only string (YYYY-MM-DD) in the given timezone.
 * Falls back to the system locale if the timezone is invalid.
 * Uses only built-in Intl — zero extra dependencies.
 *
 * @param {string} [timezone]  e.g. 'Asia/Kolkata', 'America/New_York'
 * @returns {string}           e.g. '2026-08-03'
 */
export function todayInTimezone(timezone) {
  try {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
    const parts = new Intl.DateTimeFormat('en-CA', {  // en-CA gives YYYY-MM-DD
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date())
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
    return `${p.year}-${p.month}-${p.day}`
  } catch {
    return new Date().toISOString().split('T')[0]
  }
}

/**
 * Extract HH:MM (24-hour) from an ISO timestamp in the user's timezone.
 * Used to populate the `time`, `entryTime`, and `exitTime` form fields.
 *
 * @param {string} isoString
 * @param {string} [timezone]
 * @returns {string}  e.g. '14:35'
 */
export function isoToLocalTime(isoString, timezone) {
  if (!isoString) return ''
  try {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour:   '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(isoString))
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
    // Normalise "24" → "00" (midnight edge case in some browsers)
    const h = p.hour === '24' ? '00' : p.hour
    return `${h}:${p.minute}`
  } catch {
    // Fallback: extract HH:MM from the ISO string as UTC
    return isoString.substring(11, 16)
  }
}

/**
 * Get the current time as HH:MM in the user's timezone.
 * Used when the CSV has no entryTime column at all.
 *
 * @param {string} [timezone]
 * @returns {string}  e.g. '21:13'
 */
export function nowTimeInTimezone(timezone) {
  return isoToLocalTime(new Date().toISOString(), timezone)
}

/**
 * Given a parsed ISO timestamp, extract the YYYY-MM-DD in the user's timezone.
 * This ensures "date" reflects the local calendar day, not the UTC day.
 *
 * @param {string} isoString
 * @param {string} [timezone]
 * @returns {string}  YYYY-MM-DD
 */
export function isoToLocalDate(isoString, timezone) {
  if (!isoString) return null
  try {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(isoString))
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
    return `${p.year}-${p.month}-${p.day}`
  } catch {
    return isoString.split('T')[0]
  }
}

// ---------------------------------------------------------------------------
// ROW → TRADE OBJECT
// ---------------------------------------------------------------------------

/**
 * Convert one parsed CSV row into a trade object.
 * Every canonical field is set; empty CSV cells become null.
 * Any unmapped CSV columns are stored verbatim in trade.rawExtra.
 *
 * @param {object}   row        - CSV row (header-keyed plain object)
 * @param {object}   mapping    - { fieldName → csvHeader }
 * @param {string[]} unmapped   - CSV headers not in the canonical map
 * @param {number}   rowIndex   - 0-based row index (for error messages)
 * @param {string}   [timezone] - IANA timezone e.g. 'Asia/Kolkata'
 * @returns {{ trade: object|null, errors: string[] }}
 */
export function rowToTrade(row, mapping, unmapped, rowIndex, timezone) {
  const errors = []
  const get = (field) => row[mapping[field]] ?? ''   // '' when the field has no mapping

  // ---- IDENTITY ----
  const tradeId   = nullOrString(get('tradeId'))
  const orderId   = nullOrString(get('orderId'))

  // ---- PAIR ----
  const pair = nullOrString(get('pair'))

  // ---- DIRECTION ----
  const rawDir  = nullOrString(get('direction'))
  const direction = normalizeDirection(rawDir) ?? rawDir   // keep original if unrecognised

  // ---- SIZING ----
  const quantity    = parseNumber(get('quantity'))
  const leverage    = parseNumber(get('leverage'))
  // CSV "Margin" column → stored as entryMargin so it populates "Entry Margin ($)" in the form
  const entryMargin = parseNumber(get('entryMargin'))

  // ---- PRICES (validated — must be positive if present) ----
  const entryPrice  = parseNumber(get('entryPrice'))
  const exitPrice   = parseNumber(get('exitPrice'))
  const takeProfit  = parseNumber(get('takeProfit'))
  const stopLoss    = parseNumber(get('stopLoss'))

  if (entryPrice !== null && entryPrice <= 0) {
    errors.push(`Row ${rowIndex + 2}: entryPrice must be positive (got ${entryPrice})`)
  }
  if (exitPrice !== null && exitPrice <= 0) {
    errors.push(`Row ${rowIndex + 2}: exitPrice must be positive (got ${exitPrice})`)
  }

  // ---- PNL ----
  const pnlAmount  = parseNumber(get('pnlAmount'))
  const pnlPercent = parseNumber(get('pnlPercent'))

  // Derive PnL from prices if not provided
  let computedPnl = pnlAmount
  if (computedPnl === null && entryPrice && exitPrice && quantity) {
    const lev = leverage ?? 1
    const dir = direction === 'long' ? 1 : -1
    computedPnl = dir * (exitPrice - entryPrice) * quantity * lev
    const fee = parseNumber(get('fees')) ?? 0
    computedPnl = parseFloat((computedPnl - fee).toFixed(8))
  }

  let computedPnlPct = pnlPercent
  if (computedPnlPct === null && entryPrice && exitPrice) {
    const lev = leverage ?? 1
    const dir = direction === 'long' ? 1 : -1
    computedPnlPct = parseFloat((dir * ((exitPrice - entryPrice) / entryPrice) * 100 * lev).toFixed(4))
  }

  // ---- CAPTURE ----
  const capturePoints  = parseNumber(get('capturePoints'))
  const capturePercent = parseNumber(get('capturePercent'))

  // ---- FEES ----
  const fees = parseNumber(get('fees'))

  // ---- TIMING ----
  const rawEntryTime = nullOrString(get('entryTime'))
  const rawExitTime  = nullOrString(get('exitTime'))
  const entryTime = rawEntryTime ? parseDateTime(rawEntryTime) : null
  const exitTime  = rawExitTime  ? parseDateTime(rawExitTime)  : null

  if (rawEntryTime && !entryTime) {
    errors.push(`Row ${rowIndex + 2}: Could not parse entryTime "${rawEntryTime}"`)
  }
  if (rawExitTime && !exitTime) {
    errors.push(`Row ${rowIndex + 2}: Could not parse exitTime "${rawExitTime}"`)
  }

  // ---- DATE (local calendar day in user's timezone) ----
  // If the CSV has entryTime → extract the local date from it.
  // If CSV has no entryTime   → use today's date in the user's timezone.
  const localDate = entryTime
    ? isoToLocalDate(entryTime, timezone)
    : todayInTimezone(timezone)

  // ---- TIME FIELDS (HH:MM in user's timezone) ----
  // `time`      — main Time field on the Timing & Strategy tab
  // `entryTime` field in Trade Execution tab (reuse entryTimeHHMM)
  // `exitTime`  field in Trade Execution tab
  //
  // When CSV has no time column → use current time in user's timezone.
  const entryTimeHHMM = entryTime
    ? isoToLocalTime(entryTime, timezone)     // CSV entry timestamp → local HH:MM
    : nowTimeInTimezone(timezone)             // no CSV time → now in user's TZ
  const exitTimeHHMM = exitTime
    ? isoToLocalTime(exitTime, timezone)      // CSV exit timestamp → local HH:MM
    : ''                                      // leave blank if no exit time

  // ---- WEEK DAY (derived from localDate, matches the Week dropdown values) ----
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  const week = localDate
    ? DAYS[new Date(localDate + 'T12:00:00').getDay()]
    : null

  // ---- IMPORT TIMESTAMP ----
  const importTimestamp = new Date().toISOString()

  // ---- DURATION ----
  const rawDuration = nullOrString(get('duration'))
  const duration = rawDuration ?? calcDuration(entryTime, exitTime)

  // ---- STATUS ----
  const status = nullOrString(get('status')) ??
    (exitPrice && exitTime ? 'closed' : 'open')
  // ---- EXTRA FIELDS ----
  const rawExtra = {}
  for (const h of unmapped) {
    const val = nullOrString(row[h])
    if (val !== null) rawExtra[h] = val
  }

  // ---- COMPOSITE DUPLICATE KEY ----
  const compositeKey = [
    (pair ?? '').toUpperCase(),
    (direction ?? '').toLowerCase(),
    entryPrice ?? '',
    entryTime ?? rawEntryTime ?? '',
  ].join('|')

  // ---- STABLE DOCUMENT ID ----
  // We prefer tradeId > orderId > composite, so Firestore setDoc is idempotent.
  const stableId = tradeId
    ? `tid_${tradeId}`.replace(/[^a-zA-Z0-9_-]/g, '_')
    : orderId
    ? `oid_${orderId}`.replace(/[^a-zA-Z0-9_-]/g, '_')
    : `cmp_${btoa(compositeKey).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}`

  const trade = {
    // ---- Stable import id ----
    importId: stableId,

    // ---- Identity ----
    tradeId,
    orderId,

    // ---- Core fields (match AddTrade form schema) ----
    pair,
    type:         direction === 'long' ? 'long' : direction === 'short' ? 'short' : null,
    direction,
    quantity,
    leverage,
    // CSV "Margin" → "Entry Margin ($)" field in software
    entryMargin,
    entryPrice,
    exitPrice,
    takeProfit,
    stopLoss,

    // ---- PnL ----
    pnl:        computedPnl,
    pnlAmount,
    pnlPercent: computedPnlPct,

    // ---- Capture ----
    capturePoints,
    capturePercent,

    // ---- Fees ----
    fees,

    // ---- Timing ----
    entryTimeISO:  entryTime,     // full ISO string (for Firestore / raw storage)
    exitTimeISO:   exitTime,      // full ISO string (for Firestore / raw storage)
    date:          localDate,     // YYYY-MM-DD in user's timezone
    time:          entryTimeHHMM, // HH:MM — main "Time" field (Timing & Strategy tab)
    entryTime:     entryTimeHHMM, // HH:MM — "Entry Time" field (Trade Execution tab)
    exitTime:      exitTimeHHMM,  // HH:MM — "Exit Time" field (Trade Execution tab)
    week,                         // 'Monday'…'Sunday' — matches the Week dropdown
    duration,

    // ---- Status ----
    status,

    // ---- Misc ----
    strategy:   nullOrString(get('strategy')),
    notes:      nullOrString(get('notes')),
    exchange:   nullOrString(get('exchange')),
    session:    nullOrString(get('session')),
    timeframe:  nullOrString(get('timeframe')),
    tags:       nullOrString(get('tags')),

    // ---- Extra columns (nothing is lost) ----
    rawExtra: Object.keys(rawExtra).length > 0 ? rawExtra : null,

    // ---- Metadata ----
    compositeKey,
    source:     'csv_import',
    importedAt: importTimestamp,  // current time in user's timezone
  }

  return { trade, errors }
}

// ---------------------------------------------------------------------------
// DUPLICATE DETECTION HELPERS
// ---------------------------------------------------------------------------

/**
 * Build three lookup Sets from the existing trades array for O(1) checks.
 * @param {object[]} existingTrades
 * @returns {{ byTradeId: Set, byOrderId: Set, byComposite: Set, byImportId: Set }}
 */
export function buildDuplicateSets(existingTrades) {
  const byTradeId   = new Set()
  const byOrderId   = new Set()
  const byComposite = new Set()
  const byImportId  = new Set()

  for (const t of existingTrades) {
    if (t.tradeId)      byTradeId.add(String(t.tradeId).trim())
    if (t.orderId)      byOrderId.add(String(t.orderId).trim())
    if (t.compositeKey) byComposite.add(t.compositeKey)
    if (t.importId)     byImportId.add(t.importId)
    // Legacy: trade might have been saved with id = importId
    if (t.id)           byImportId.add(t.id)
  }

  return { byTradeId, byOrderId, byComposite, byImportId }
}

/**
 * Check whether a freshly-parsed trade matches any existing record.
 * Returns { isDuplicate: boolean, existingTrade: object|null, matchedOn: string|null }
 */
export function findDuplicate(trade, existingTrades, dupSets) {
  const { byTradeId, byOrderId, byComposite, byImportId } = dupSets

  if (trade.importId && byImportId.has(trade.importId)) {
    const existing = existingTrades.find(t =>
      t.importId === trade.importId || t.id === trade.importId)
    return { isDuplicate: true, existingTrade: existing ?? null, matchedOn: 'importId' }
  }
  if (trade.tradeId && byTradeId.has(String(trade.tradeId).trim())) {
    const existing = existingTrades.find(t => String(t.tradeId).trim() === String(trade.tradeId).trim())
    return { isDuplicate: true, existingTrade: existing ?? null, matchedOn: 'tradeId' }
  }
  if (trade.orderId && byOrderId.has(String(trade.orderId).trim())) {
    const existing = existingTrades.find(t => String(t.orderId).trim() === String(trade.orderId).trim())
    return { isDuplicate: true, existingTrade: existing ?? null, matchedOn: 'orderId' }
  }
  if (trade.compositeKey && byComposite.has(trade.compositeKey)) {
    const existing = existingTrades.find(t => t.compositeKey === trade.compositeKey)
    return { isDuplicate: true, existingTrade: existing ?? null, matchedOn: 'composite' }
  }
  return { isDuplicate: false, existingTrade: null, matchedOn: null }
}

// ---------------------------------------------------------------------------
// MERGE (update-if-new-info logic)
// ---------------------------------------------------------------------------

/**
 * Compare incoming trade to existing.
 * Returns a partial object of fields that have genuinely new non-null values,
 * or null if there is nothing new to write.
 */
export function diffTrade(incoming, existing) {
  const updates = {}
  for (const [key, val] of Object.entries(incoming)) {
    if (['importedAt', 'source', 'compositeKey', 'importId'].includes(key)) continue
    // Only update if incoming has a real value and existing is empty/null
    if (val !== null && val !== undefined && val !== '') {
      const cur = existing[key]
      if (cur === null || cur === undefined || cur === '') {
        updates[key] = val
      }
    }
  }
  return Object.keys(updates).length > 0 ? updates : null
}

// ---------------------------------------------------------------------------
// MAIN PARSE FUNCTION  (parse only — no Firestore writes)
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string and return a structured result ready for the Firestore layer.
 *
 * @param {string}   csvText
 * @param {object[]} existingTrades  - trades already in Firestore (for dedup)
 * @param {string}   [timezone]      - IANA timezone e.g. 'Asia/Kolkata'
 * @returns {ImportParseResult}
 */
export function parseImportCSV(csvText, existingTrades = [], timezone) {
  const result = {
    totalRows:    0,
    toInsert:     [],
    toUpdate:     [],
    toSkip:       [],
    parseErrors:  [],
    headerWarning: null,
  }

  if (!csvText || typeof csvText !== 'string' || csvText.trim() === '') {
    result.parseErrors.push({ rowIndex: -1, messages: ['File is empty or unreadable'] })
    return result
  }

  if (csvText.length > 50 * 1024 * 1024) {
    result.parseErrors.push({ rowIndex: -1, messages: ['File exceeds 50 MB limit'] })
    return result
  }

  // --- Parse raw CSV ---
  const { headers, rows } = parseCSVText(csvText)
  result.totalRows = rows.length

  if (headers.length === 0) {
    result.parseErrors.push({ rowIndex: -1, messages: ['No headers found in file'] })
    return result
  }
  if (rows.length === 0) {
    result.parseErrors.push({ rowIndex: -1, messages: ['No data rows found in file'] })
    return result
  }

  // --- Build column mapping ---
  const { mapping, unmapped } = buildColumnMapping(headers)

  // Warn if critical columns are missing (but don't abort)
  const missingCritical = ['pair', 'entryPrice'].filter(f => !mapping[f])
  if (missingCritical.length > 0) {
    result.headerWarning = `Could not detect columns: ${missingCritical.join(', ')}. ` +
      `Check that your CSV headers match the expected format.`
  }

  // --- Build duplicate sets ---
  const dupSets = buildDuplicateSets(existingTrades)

  // --- Process each row ---
  for (let i = 0; i < rows.length; i++) {
    const { trade, errors } = rowToTrade(rows[i], mapping, unmapped, i, timezone)

    if (errors.length > 0) {
      result.parseErrors.push({ rowIndex: i, messages: errors })
      // Still continue — validation errors are non-fatal unless trade is null
    }

    if (!trade) continue

    // Duplicate detection
    const { isDuplicate, existingTrade, matchedOn } = findDuplicate(trade, existingTrades, dupSets)

    if (isDuplicate) {
      const updates = existingTrade ? diffTrade(trade, existingTrade) : null
      if (updates && existingTrade?.id) {
        result.toUpdate.push({ firestoreId: existingTrade.id, updates, rowIndex: i, matchedOn })
      } else {
        result.toSkip.push({ rowIndex: i, matchedOn: matchedOn ?? 'unknown' })
      }
    } else {
      result.toInsert.push({ trade, rowIndex: i })
      // Add to dupSets to catch intra-file duplicates
      if (trade.tradeId)      dupSets.byTradeId.add(String(trade.tradeId))
      if (trade.orderId)      dupSets.byOrderId.add(String(trade.orderId))
      if (trade.compositeKey) dupSets.byComposite.add(trade.compositeKey)
      if (trade.importId)     dupSets.byImportId.add(trade.importId)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// FILE VALIDATION
// ---------------------------------------------------------------------------

export function validateCSVFile(file) {
  if (!file) return { valid: false, error: 'No file selected' }
  const name = file.name.toLowerCase()
  if (!name.endsWith('.csv') && !name.endsWith('.txt')) {
    return { valid: false, error: 'Only .csv files are accepted' }
  }
  if (file.size === 0) return { valid: false, error: 'File is empty' }
  if (file.size > 50 * 1024 * 1024) return { valid: false, error: 'File exceeds 50 MB limit' }
  return { valid: true }
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = (e) => resolve(e.target.result)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file, 'UTF-8')
  })
}
