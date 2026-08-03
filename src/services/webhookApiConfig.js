export const LOCAL_WEBHOOK_API_BASE_URL = 'http://localhost:5000'
export const RENDER_WEBHOOK_API_BASE_URL = 'https://vivek-raj.onrender.com'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

function normalizeApiOrigin(value) {
  const parsed = new URL(String(value).trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('Webhook API URL must use HTTP or HTTPS.')
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('Webhook API URL must not contain credentials.')
  }
  if (!/^\/+$/u.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw new TypeError('Webhook API URL must be an origin without a path, query, or hash.')
  }
  return parsed.origin
}

export function resolveWebhookApiBaseUrl({
  configuredBase,
  hostname = globalThis.location?.hostname,
} = {}) {
  const configured = String(configuredBase || '').trim()
  if (configured) return normalizeApiOrigin(configured)

  return LOCAL_HOSTNAMES.has(String(hostname || '').toLowerCase())
    ? LOCAL_WEBHOOK_API_BASE_URL
    : RENDER_WEBHOOK_API_BASE_URL
}
