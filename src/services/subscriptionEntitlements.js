import {
  entitlementTimerDelay,
  MAX_ENTITLEMENT_TIMEOUT_MS,
} from './pendingBillingOrders.js'

export const PLAN_RANK = Object.freeze({ basic: 1, pro: 2, elite: 3 })
export const INACTIVE_SUBSCRIPTION = Object.freeze({
  status: 'inactive',
  planId: null,
  entitlementTier: null,
  expiresAt: null,
  source: null,
  validityType: null,
  lifetime: false,
})
export const DISABLED_ADMIN_CAPABILITIES = Object.freeze({ complimentarySubscriptions: false })

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function expirationMilliseconds(expiresAt) {
  if ((typeof expiresAt !== 'string' && typeof expiresAt !== 'number') || expiresAt === '') return null
  const milliseconds = new Date(expiresAt).getTime()
  return Number.isFinite(milliseconds) ? milliseconds : null
}

export function isEffectiveEntitlementActive(subscription, now = Date.now()) {
  if (!isRecord(subscription) || subscription.status !== 'active') return false
  if (subscription.lifetime === true) return true

  const expiresAt = expirationMilliseconds(subscription.expiresAt)
  return expiresAt !== null && expiresAt > now
}

export function entitlementTierRank(tier) {
  return typeof tier === 'string' ? (PLAN_RANK[tier] || 0) : 0
}

export function hasEffectivePlan(subscription, requiredPlan, now = Date.now()) {
  const requiredRank = entitlementTierRank(requiredPlan)
  if (requiredRank === 0 || !isEffectiveEntitlementActive(subscription, now)) return false
  return entitlementTierRank(subscription.entitlementTier || subscription.planId) >= requiredRank
}

export function entitlementFormattingInputs(subscription) {
  const record = isRecord(subscription) ? subscription : INACTIVE_SUBSCRIPTION
  const source = record.source === 'paid' || record.source === 'complimentary' ? record.source : null
  const lifetime = record.lifetime === true
  const expiresAt = lifetime || expirationMilliseconds(record.expiresAt) === null ? null : record.expiresAt

  return {
    source,
    complimentary: source === 'complimentary',
    lifetime,
    validityType: lifetime ? 'lifetime' : (expiresAt !== null ? 'finite' : null),
    expiresAt,
  }
}

export function normalizeAdminCapabilities(value, isAdmin) {
  if (isAdmin !== true || !isRecord(value)) return { ...DISABLED_ADMIN_CAPABILITIES }
  return { complimentarySubscriptions: value.complimentarySubscriptions === true }
}

export function canAccessAdminCapability(isAdmin, adminCapabilities, requiredCapability) {
  if (isAdmin !== true) return false
  if (!requiredCapability) return true
  return isRecord(adminCapabilities) && adminCapabilities[requiredCapability] === true
}

export function entitlementSourceLabel(subscription) {
  const { source } = entitlementFormattingInputs(subscription)
  if (source === 'complimentary') return 'Complimentary access'
  if (source === 'paid') return 'Paid subscription'
  return 'Subscription'
}

export function formatEntitlementValidity(subscription, {
  locale = 'en-IN',
  timeZone,
} = {}) {
  const { lifetime, expiresAt } = entitlementFormattingInputs(subscription)
  if (lifetime) return 'Lifetime'
  if (expiresAt === null) return null

  const options = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }
  return `Valid until ${new Intl.DateTimeFormat(locale, options).format(new Date(expiresAt))}`
}

export function normalizeBillingMe(payload) {
  const record = isRecord(payload) ? payload : {}
  const isAdmin = record.isAdmin === true
  return {
    subscription: isRecord(record.subscription) ? record.subscription : INACTIVE_SUBSCRIPTION,
    isAdmin,
    adminCapabilities: normalizeAdminCapabilities(record.adminCapabilities, isAdmin),
  }
}

export function entitlementTimerDecision(subscription, now = Date.now()) {
  if (!isRecord(subscription) || subscription.status !== 'active' || subscription.lifetime === true) return null

  const expiresAt = expirationMilliseconds(subscription.expiresAt)
  if (expiresAt === null || expiresAt <= now) return null

  const remaining = expiresAt - now
  return {
    expiresAt,
    delay: entitlementTimerDelay(expiresAt, now),
    refreshOnFire: remaining <= MAX_ENTITLEMENT_TIMEOUT_MS,
  }
}

export function scheduleEntitlementRefresh(subscription, {
  now = Date.now(),
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  onTick,
  onRefresh,
} = {}) {
  const decision = entitlementTimerDecision(subscription, now)
  if (!decision) return () => {}

  const timer = setTimeoutFn(() => {
    onTick?.()
    if (decision.refreshOnFire) onRefresh?.()
  }, decision.delay)
  return () => clearTimeoutFn(timer)
}
