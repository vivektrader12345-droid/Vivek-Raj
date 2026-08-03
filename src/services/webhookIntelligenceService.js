import { signOut } from 'firebase/auth'
import { auth } from '../firebase'
import {
  AuthenticatedFetchError,
  createFirebaseAuthenticatedFetch,
  shouldSignOutForAuthenticationError,
} from './firebaseAuthenticatedFetch'
import { resolveWebhookApiBaseUrl } from './webhookApiConfig'

export const WEBHOOK_API_BASE_URL = resolveWebhookApiBaseUrl({
  configuredBase: import.meta.env?.VITE_WEBHOOK_API_URL,
})
export const DEFAULT_TIMEOUT_MS = 15000

const authenticatedFetch = createFirebaseAuthenticatedFetch({
  auth,
  reauthenticate: async ({ user, code }) => {
    // Ambiguous invalid/expired responses can be caused by a mixed deployment
    // or backend configuration issue. Keep access blocked, but only destroy the
    // Firebase session when the backend definitively reports revocation/disable.
    if (
      shouldSignOutForAuthenticationError(code)
      && auth.currentUser === user
      && auth.currentUser?.uid === user.uid
    ) {
      await signOut(auth)
    }
  },
})

export class WebhookApiError extends Error {
  constructor(message, {
    code = 'request_failed',
    status = 0,
    details = null,
    requestId = null,
    payload = null,
    cause = null,
  } = {}) {
    super(message)
    this.name = 'WebhookApiError'
    this.code = code
    this.status = status
    this.details = details
    this.requestId = requestId
    this.payload = payload
    this.cause = cause
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      details: this.details,
      requestId: this.requestId,
    }
  }
}

function queryValue(value) {
  return value instanceof Date ? value.toISOString() : String(value)
}

export function buildQuery(params = {}) {
  const query = new URLSearchParams()

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return

    if (Array.isArray(value)) {
      value.forEach(item => {
        if (item !== undefined && item !== null && item !== '') {
          query.append(key, queryValue(item))
        }
      })
      return
    }

    query.set(key, queryValue(value))
  })

  const encoded = query.toString()
  return encoded ? `?${encoded}` : ''
}

function pathId(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new TypeError(`${label} is required.`)
  }
  return encodeURIComponent(String(value))
}

async function parseJsonResponse(response) {
  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch (cause) {
    const details = { contentType: response.headers.get('content-type') || null }

    if (!response.ok) {
      const apiNotDeployed = response.status === 404
      return {
        error: {
          code: apiNotDeployed ? 'api_not_deployed' : 'invalid_response',
          message: apiNotDeployed
            ? `Webhook Intelligence API is not deployed on the configured server (${WEBHOOK_API_BASE_URL}).`
            : `The webhook server returned a non-JSON error response (HTTP ${response.status}).`,
          details,
        },
      }
    }

    throw new WebhookApiError('The server returned invalid JSON.', {
      code: 'invalid_response',
      status: response.status,
      details,
      cause,
    })
  }
}

function authenticatedErrorMessage(error, timeout) {
  switch (error.code) {
    case 'authentication_required':
      return 'Sign in is required to access webhook intelligence.'
    case 'token_acquisition_failed':
      return 'Unable to obtain your authentication token.'
    case 'token_refresh_failed':
      return 'Unable to refresh your authentication token. Sign in again.'
    case 'token_revoked':
    case 'user_disabled':
    case 'invalid_token':
    case 'reauthentication_required':
      return error.message || 'Your session is no longer valid. Sign in again.'
    case 'request_timeout':
      return `The webhook intelligence server at ${WEBHOOK_API_BASE_URL} did not respond within ${Math.round(timeout / 1000)} seconds.`
    case 'network_error':
      return `Unable to reach the webhook intelligence server at ${WEBHOOK_API_BASE_URL}. Verify that the configured backend is deployed and running.`
    default:
      return error.message || 'The webhook intelligence request failed.'
  }
}

export async function webhookRequest(path, {
  method = 'GET',
  query,
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS

  try {
    const response = await authenticatedFetch(
      `${WEBHOOK_API_BASE_URL}${path}${buildQuery(query)}`,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      { timeoutMs: timeout },
    )
    const payload = await parseJsonResponse(response)

    if (!response.ok) {
      const serverError = payload?.error
      throw new WebhookApiError(
        serverError?.message || `Request failed with status ${response.status}.`,
        {
          code: serverError?.code || 'http_error',
          status: response.status,
          details: serverError?.details ?? null,
          requestId: payload?.requestId ?? response.headers.get('x-request-id'),
          payload,
        },
      )
    }

    if (payload === null) {
      throw new WebhookApiError('The server returned an empty response.', {
        code: 'invalid_response',
        status: response.status,
      })
    }

    return payload
  } catch (error) {
    if (error instanceof WebhookApiError) throw error

    if (error instanceof AuthenticatedFetchError) {
      throw new WebhookApiError(authenticatedErrorMessage(error, timeout), {
        code: error.code,
        status: error.status,
        details: error.details,
        requestId: error.requestId,
        payload: error.payload,
        cause: error.cause,
      })
    }

    throw new WebhookApiError('Unable to prepare the webhook intelligence request.', {
      code: 'request_failed',
      cause: error,
    })
  }
}

const apiRoot = '/api/v1/webhooks'

const health = options => webhookRequest(`${apiRoot}/health`, options)
const overview = options => webhookRequest(`${apiRoot}/overview`, options)
const endpoints = options => webhookRequest(`${apiRoot}/endpoints`, options)
const events = (query, options = {}) => webhookRequest(`${apiRoot}/events`, { ...options, query })
const eventDetail = (eventId, options) => webhookRequest(`${apiRoot}/events/${pathId(eventId, 'eventId')}`, options)
const errors = (query, options = {}) => webhookRequest(`${apiRoot}/errors`, { ...options, query })
const executions = (query, options = {}) => webhookRequest(`${apiRoot}/executions`, { ...options, query })
const trades = (query, options = {}) => webhookRequest(`${apiRoot}/trades`, { ...options, query })
const createEndpoint = (data, options = {}) => webhookRequest(`${apiRoot}/endpoints`, { ...options, method: 'POST', body: data })
const updateEndpoint = (endpointId, data, options = {}) => webhookRequest(`${apiRoot}/endpoints/${pathId(endpointId, 'endpointId')}`, { ...options, method: 'PATCH', body: data })
const rotateEndpointSecret = (endpointId, options = {}) => webhookRequest(`${apiRoot}/endpoints/${pathId(endpointId, 'endpointId')}/rotate-secret`, { ...options, method: 'POST' })
const enableEndpoint = (endpointId, options = {}) => webhookRequest(`${apiRoot}/endpoints/${pathId(endpointId, 'endpointId')}/enable`, { ...options, method: 'POST' })
const disableEndpoint = (endpointId, options = {}) => webhookRequest(`${apiRoot}/endpoints/${pathId(endpointId, 'endpointId')}/disable`, { ...options, method: 'POST' })
const deleteEndpoint = (endpointId, options = {}) => webhookRequest(`${apiRoot}/endpoints/${pathId(endpointId, 'endpointId')}`, { ...options, method: 'DELETE' })

export const webhookIntelligenceService = {
  health,
  getHealth: health,
  overview,
  getOverview: overview,
  endpoints,
  listEndpoints: endpoints,
  events,
  listEvents: events,
  eventDetail,
  getEvent: eventDetail,
  errors,
  listErrors: errors,
  executions,
  listExecutions: executions,
  trades,
  listTrades: trades,
  createEndpoint,
  updateEndpoint,
  rotateEndpointSecret,
  enableEndpoint,
  disableEndpoint,
  deleteEndpoint,
}

export const ALERT_EXPORT_COLUMNS = Object.freeze([
  { key: 'receivedTimestamp', label: 'Received' },
  { key: 'triggerTimestamp', label: 'Triggered' },
  { key: 'strategy', label: 'Strategy' },
  { key: 'symbol', label: 'Symbol' },
  { key: 'action', label: 'Action' },
  { key: 'direction', label: 'Direction' },
  { key: 'price', label: 'Price' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'status', label: 'Status' },
  { key: 'tradeStatus', label: 'Trade Status' },
  { key: 'endpointName', label: 'Endpoint' },
  { key: 'message', label: 'Message' },
])

function valueAt(row, column) {
  const value = typeof column.value === 'function' ? column.value(row) : row?.[column.key]
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return '[Unserializable value]'
    }
  }
  return String(value)
}

function preventFormulaInjection(value) {
  const clean = String(value).replace(/\0/g, '')
  return /^\s*[=+\-@]/u.test(clean) || /^[\t\r\n]/u.test(clean) ? `'${clean}` : clean
}

function csvCell(value) {
  const safe = preventFormulaInjection(value)
  return `"${safe.replace(/"/g, '""')}"`
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizedExportInput(rows, columns) {
  return {
    rows: Array.isArray(rows) ? rows : [],
    columns: Array.isArray(columns) && columns.length ? columns : ALERT_EXPORT_COLUMNS,
  }
}

function downloadBlob(content, type, filename) {
  const blob = content instanceof Blob ? content : new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function createSafeCsv(rows, columns = ALERT_EXPORT_COLUMNS) {
  const data = normalizedExportInput(rows, columns)
  const header = data.columns.map(column => csvCell(column.label ?? column.key ?? '')).join(',')
  const body = data.rows
    .map(row => data.columns.map(column => csvCell(valueAt(row, column))).join(','))
    .join('\r\n')
  return `\uFEFF${header}${body ? `\r\n${body}` : ''}`
}

export function downloadCsv(rows, columns = ALERT_EXPORT_COLUMNS, filename = 'webhook-alerts.csv') {
  downloadBlob(createSafeCsv(rows, columns), 'text/csv;charset=utf-8', filename)
}

export function createExcelHtml(rows, columns = ALERT_EXPORT_COLUMNS, title = 'Webhook Alerts') {
  const data = normalizedExportInput(rows, columns)
  const headings = data.columns
    .map(column => `<th>${escapeHtml(column.label ?? column.key ?? '')}</th>`)
    .join('')
  const cells = data.rows
    .map(row => `<tr>${data.columns.map(column => `<td style="mso-number-format:'\\@'">${escapeHtml(preventFormulaInjection(valueAt(row, column)))}</td>`).join('')}</tr>`)
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>table{border-collapse:collapse}th,td{border:1px solid #999;padding:6px;text-align:left;vertical-align:top}th{background:#eee}</style></head><body><table><thead><tr>${headings}</tr></thead><tbody>${cells}</tbody></table></body></html>`
}

export function downloadExcel(rows, columns = ALERT_EXPORT_COLUMNS, filename = 'webhook-alerts.xls') {
  const html = createExcelHtml(rows, columns)
  downloadBlob(`\uFEFF${html}`, 'application/vnd.ms-excel;charset=utf-8', filename)
}

export function createPrintableReport(rows, columns = ALERT_EXPORT_COLUMNS, {
  title = 'Webhook Intelligence Report',
  subtitle = '',
  generatedAt = new Date(),
} = {}) {
  const data = normalizedExportInput(rows, columns)
  const headings = data.columns
    .map(column => `<th>${escapeHtml(column.label ?? column.key ?? '')}</th>`)
    .join('')
  const cells = data.rows
    .map(row => `<tr>${data.columns.map(column => `<td>${escapeHtml(valueAt(row, column))}</td>`).join('')}</tr>`)
    .join('')
  const emptyRow = `<tr><td colspan="${Math.max(data.columns.length, 1)}">No alert rows in the loaded filtered result.</td></tr>`
  const generatedLabel = generatedAt instanceof Date ? generatedAt.toLocaleString() : String(generatedAt)

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>@page{size:landscape;margin:12mm}body{font:12px Arial,sans-serif;color:#111}h1{font-size:20px;margin:0 0 4px}p{color:#555;margin:0 0 16px}table{width:100%;border-collapse:collapse;table-layout:auto}th,td{border:1px solid #bbb;padding:6px;vertical-align:top;word-break:break-word}th{background:#eee;text-align:left}footer{margin-top:12px;color:#666;font-size:10px}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><h1>${escapeHtml(title)}</h1>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}<table><thead><tr>${headings}</tr></thead><tbody>${cells || emptyRow}</tbody></table><footer>Generated ${escapeHtml(generatedLabel)}</footer></body></html>`
}

export function printReport(rows, columns = ALERT_EXPORT_COLUMNS, options = {}) {
  const html = createPrintableReport(rows, columns, options)
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
  const frame = document.createElement('iframe')
  frame.setAttribute('title', 'Printable webhook report')
  frame.style.position = 'fixed'
  frame.style.width = '1px'
  frame.style.height = '1px'
  frame.style.opacity = '0'
  frame.style.pointerEvents = 'none'
  frame.src = url
  document.body.appendChild(frame)

  frame.onload = () => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    globalThis.setTimeout(() => {
      frame.remove()
      URL.revokeObjectURL(url)
    }, 1000)
  }
}

export const downloadAlertsCsv = (rows, filename = 'webhook-alerts.csv') => downloadCsv(rows, ALERT_EXPORT_COLUMNS, filename)
export const downloadAlertsExcel = (rows, filename = 'webhook-alerts.xls') => downloadExcel(rows, ALERT_EXPORT_COLUMNS, filename)
export const printAlertsReport = (rows, options = {}) => printReport(rows, ALERT_EXPORT_COLUMNS, options)
export const printAlertsPdf = printAlertsReport

export default webhookIntelligenceService
