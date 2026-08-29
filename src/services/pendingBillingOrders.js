const STORAGE_PREFIX = 'vmt:billing:pending:v1:'
const MAX_PENDING_ORDERS = 20
const ORDER_ID_RE = /^[A-Za-z0-9_-]{4,128}$/
export const MAX_ENTITLEMENT_TIMEOUT_MS = 2_147_000_000

export function entitlementTimerDelay(expiresAt, now = Date.now()) {
  const expiry = new Date(expiresAt).getTime()
  if (!Number.isFinite(expiry)) return 0
  return Math.max(0, Math.min(expiry - now, MAX_ENTITLEMENT_TIMEOUT_MS))
}

export const TERMINAL_ORDER_STATUSES = Object.freeze(new Set([
  'expired',
  'failed',
  'provider_failed',
  'zero_amount',
]))

function storageFor(storage) {
  if (storage) return storage
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

function keyFor(uid) {
  return `${STORAGE_PREFIX}${String(uid || '')}`
}

function validOrderId(value) {
  return typeof value === 'string' && ORDER_ID_RE.test(value)
}

export function listPendingBillingOrders(uid, storage) {
  if (!uid) return []
  const target = storageFor(storage)
  if (!target) return []
  try {
    const parsed = JSON.parse(target.getItem(keyFor(uid)) || '[]')
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter(validOrderId))].slice(-MAX_PENDING_ORDERS)
  } catch {
    return []
  }
}

export function addPendingBillingOrder(uid, orderId, storage) {
  if (!uid || !validOrderId(orderId)) return []
  const target = storageFor(storage)
  if (!target) return []
  const values = [...listPendingBillingOrders(uid, target).filter(value => value !== orderId), orderId]
    .slice(-MAX_PENDING_ORDERS)
  try {
    target.setItem(keyFor(uid), JSON.stringify(values))
    return values
  } catch {
    return []
  }
}

export function removePendingBillingOrder(uid, orderId, storage) {
  if (!uid || !validOrderId(orderId)) return []
  const target = storageFor(storage)
  if (!target) return []
  const values = listPendingBillingOrders(uid, target).filter(value => value !== orderId)
  try {
    if (values.length) target.setItem(keyFor(uid), JSON.stringify(values))
    else target.removeItem(keyFor(uid))
    return values
  } catch {
    return values
  }
}

export async function reconcilePendingBillingOrders({ uid, getOrderStatus, refresh, storage }) {
  const paid = []
  for (const orderId of listPendingBillingOrders(uid, storage)) {
    try {
      const result = await getOrderStatus(orderId)
      if (result?.status === 'paid' && result.payment) {
        removePendingBillingOrder(uid, orderId, storage)
        paid.push(result)
      } else if (TERMINAL_ORDER_STATUSES.has(result?.status)) {
        removePendingBillingOrder(uid, orderId, storage)
      }
    } catch (error) {
      if (error?.status === 404 && error?.code === 'order_not_found') {
        removePendingBillingOrder(uid, orderId, storage)
      }
    }
  }
  if (paid.length && refresh) await refresh()
  return paid
}
