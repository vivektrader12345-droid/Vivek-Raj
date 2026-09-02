const scenario = new URLSearchParams(globalThis.location?.search || '').get('scenario') || 'full'
const calls = []
let getMeCount = 0

const paidFallback = {
  status: 'active', source: 'paid', planId: 'basic', planName: 'Basic', entitlementTier: 'basic',
  lifetime: false, expiresAt: '2999-01-01T00:00:00.000Z',
}

const activeComplimentary = {
  status: 'active', source: 'complimentary', planId: 'pro', planName: 'Pro', entitlementTier: 'pro',
  lifetime: true, validityType: 'lifetime', expiresAt: null,
}

const plans = [
  { id: 'basic', name: 'Basic', entitlementTier: 'basic', features: ['Journal'], active: true },
  { id: 'pro', name: 'Pro', entitlementTier: 'pro', features: ['Analytics', 'Automation'], active: true },
  { id: 'retired', name: 'Retired', entitlementTier: 'elite', features: ['Hidden'], active: false },
]

const grant = (overrides = {}) => ({
  id: 'grant-active', targetUid: 'target-uid', targetEmail: 'person@example.com',
  targetDisplayName: '<img id="unsafe-render-probe" src=x>', planId: 'pro', planName: 'Pro',
  entitlementTier: 'pro', features: ['Analytics', 'Automation'], validityType: 'lifetime',
  lifetime: true, presetDays: null, activationAt: '2026-01-01T00:00:00.000Z', expiresAt: null,
  status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: { uid: 'admin-uid', email: 'admin@example.com' }, reason: 'Support & retention <plain text>',
  endedAt: null, endReason: null, revokedBy: null, supersededByGrantId: null, supersededBy: null,
  ...overrides,
})

let grants = [grant()]

function record(method, payload) {
  calls.push({ method, payload: payload === undefined ? null : structuredClone(payload) })
}

function apiError(message, { status = 503, code = 'billing_unavailable', requestId = 'browser-request-1' } = {}) {
  return Object.assign(new Error(message), { status, code, requestId })
}

function billingMe() {
  if (scenario === 'failclosed') throw apiError('Entitlement service unavailable')
  if (scenario === 'nonadmin') {
    return { subscription: activeComplimentary, isAdmin: false, adminCapabilities: { complimentarySubscriptions: true } }
  }
  if (scenario === 'denied-capability') {
    return { subscription: activeComplimentary, isAdmin: true, adminCapabilities: { complimentarySubscriptions: false } }
  }
  if (scenario === 'finite-expiry') {
    if (getMeCount > 1) {
      return { subscription: { status: 'inactive', source: null, planId: null, entitlementTier: null, lifetime: false, expiresAt: null }, isAdmin: true, adminCapabilities: { complimentarySubscriptions: true } }
    }
    return {
      subscription: { ...activeComplimentary, lifetime: false, validityType: 'preset', expiresAt: new Date(Date.now() + 1200).toISOString() },
      isAdmin: true,
      adminCapabilities: { complimentarySubscriptions: true },
    }
  }
  return { subscription: activeComplimentary, isAdmin: true, adminCapabilities: { complimentarySubscriptions: true } }
}

export const billingService = {
  async getMe() {
    getMeCount += 1
    record('getMe', { count: getMeCount })
    return billingMe()
  },

  async getPlans() {
    record('getPlans')
    return { plans }
  },

  async getOrderStatus(orderId) {
    record('getOrderStatus', { orderId })
    return { status: 'reserved' }
  },

  async lookupBillingUser(email) {
    record('lookupBillingUser', { email })
    if (email.trim().toLowerCase() !== 'person@example.com') {
      throw apiError('No exact Firebase Authentication user was found.', { status: 404, code: 'user_not_found' })
    }
    return {
      user: {
        uid: 'target-uid', email: 'person@example.com', emailVerified: true,
        displayName: 'Target Person', disabled: false, grantEligible: true,
      },
      effectiveEntitlement: activeComplimentary,
      paidFallback,
      requestId: 'lookup-request',
    }
  },

  async listComplimentaryGrants(options = {}) {
    record('listComplimentaryGrants', options)
    if (scenario === 'stale-frontend') {
      throw apiError('Administrative capability is disabled.', { status: 403, code: 'admin_capability_required' })
    }
    if (options.email === 'error@example.com') throw apiError('Grant history is temporarily unavailable.')
    if (options.email === 'empty@example.com') return { grants: [], page: { nextCursor: null, asOf: '2026-01-15T12:00:00.000Z' } }
    if (options.cursor === 'cursor-page-two') {
      return {
        grants: [grant({ id: 'grant-history', status: 'superseded', targetEmail: 'history@example.com', endedAt: '2026-01-10T00:00:00.000Z', endReason: 'Replaced', supersededByGrantId: 'grant-active' })],
        page: { nextCursor: null, asOf: '2026-01-15T12:00:00.000Z' },
      }
    }
    const filtered = grants.filter(item => (!options.email || item.targetEmail === options.email)
      && (!options.planId || item.planId === options.planId)
      && (!options.status || item.status === options.status))
    return { grants: filtered, page: { nextCursor: filtered.length ? 'cursor-page-two' : null, asOf: '2026-01-15T12:00:00.000Z' } }
  },

  async createComplimentaryGrant(payload) {
    record('createComplimentaryGrant', payload)
    const created = grant({
      id: 'grant-created',
      validityType: payload.validity.type,
      lifetime: payload.validity.type === 'lifetime',
      presetDays: payload.validity.type === 'preset' ? payload.validity.days : null,
      expiresAt: payload.validity.type === 'lifetime' ? null : (payload.validity.expiresAt || '2026-02-01T00:00:00.000Z'),
      reason: payload.reason,
    })
    grants = [created, ...grants.map(item => item.status === 'active' ? grant({ ...item, status: 'superseded', supersededByGrantId: created.id }) : item)]
    return { grant: created, effectiveEntitlement: activeComplimentary, paidFallback, duplicate: false, requestId: 'grant-request' }
  },

  async revokeComplimentaryGrant(grantId, payload) {
    record('revokeComplimentaryGrant', { grantId, ...payload })
    const revoked = grant({ ...(grants.find(item => item.id === grantId) || {}), id: grantId, status: 'revoked', endedAt: '2026-01-15T12:01:00.000Z', endReason: payload.reason || null, revokedBy: { uid: 'admin-uid', email: 'admin@example.com' } })
    grants = grants.map(item => item.id === grantId ? revoked : item)
    return { grant: revoked, effectiveEntitlement: paidFallback, paidFallback, duplicate: false, requestId: 'revoke-request' }
  },
}

export function mockBillingSnapshot() {
  return { scenario, getMeCount, calls: structuredClone(calls), grants: structuredClone(grants) }
}
