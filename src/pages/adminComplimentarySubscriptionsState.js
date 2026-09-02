export const PRESET_DAYS = Object.freeze([7, 30, 90, 365])
export const GRANT_STATUSES = Object.freeze(['active', 'expired', 'revoked', 'superseded'])
export const MAX_REASON_LENGTH = 500

export const EMPTY_GRANT_FORM = Object.freeze({
  planId: '',
  validityType: 'preset',
  presetDays: '30',
  customExpiresAt: '',
  reason: '',
})

export const EMPTY_FILTERS = Object.freeze({ email: '', planId: '', status: '' })

export function initialComplimentaryAdminState() {
  return {
    plans: [],
    plansLoading: true,
    plansError: '',
    grants: [],
    listLoading: true,
    listError: '',
    page: { nextCursor: null, asOf: null },
    filters: { ...EMPTY_FILTERS },
    appliedFilters: { ...EMPTY_FILTERS },
    lookupEmail: '',
    selectedUser: null,
    lookupEffectiveEntitlement: null,
    lookupPaidFallback: null,
    lookupLoading: false,
    lookupError: '',
    grantForm: { ...EMPTY_GRANT_FORM },
    grantConfirmation: null,
    grantAttempt: null,
    creating: false,
    createError: '',
    mutationResult: null,
    revokeConfirmation: null,
    revokeReason: '',
    revokeAttempt: null,
    revokingGrantId: null,
    revokeError: '',
    accessDenied: '',
  }
}

function replaceGrant(grants, authoritativeGrant, { prepend = false } = {}) {
  if (!authoritativeGrant?.id) return grants
  const index = grants.findIndex(grant => grant.id === authoritativeGrant.id)
  if (index < 0) return prepend ? [authoritativeGrant, ...grants] : grants
  return grants.map(grant => grant.id === authoritativeGrant.id ? authoritativeGrant : grant)
}

function clearTargetState(state) {
  return {
    ...state,
    selectedUser: null,
    lookupEffectiveEntitlement: null,
    lookupPaidFallback: null,
    lookupError: '',
    grantConfirmation: null,
    grantAttempt: null,
    createError: '',
  }
}

export function complimentaryAdminReducer(state, action) {
  switch (action.type) {
    case 'PLANS_LOADING':
      return { ...state, plansLoading: true, plansError: '' }
    case 'PLANS_SUCCESS':
      return { ...state, plansLoading: false, plansError: '', plans: action.plans }
    case 'PLANS_ERROR':
      return { ...state, plansLoading: false, plansError: action.error }
    case 'LIST_LOADING':
      return { ...state, listLoading: true, listError: '' }
    case 'LIST_SUCCESS': {
      const incoming = action.grants || []
      const grants = action.append
        ? [...state.grants, ...incoming.filter(next => !state.grants.some(current => current.id === next.id))]
        : incoming
      return {
        ...state,
        grants,
        listLoading: false,
        listError: '',
        page: { nextCursor: action.page?.nextCursor || null, asOf: action.page?.asOf || state.page.asOf || null },
      }
    }
    case 'LIST_ERROR':
      return { ...state, listLoading: false, listError: action.error }
    case 'FILTER_CHANGED':
      return { ...state, filters: { ...state.filters, [action.field]: action.value } }
    case 'FILTERS_APPLIED':
      return { ...state, appliedFilters: { ...state.filters }, grants: [], page: { nextCursor: null, asOf: null } }
    case 'FILTERS_RESET':
      return { ...state, filters: { ...EMPTY_FILTERS }, appliedFilters: { ...EMPTY_FILTERS }, grants: [], page: { nextCursor: null, asOf: null } }
    case 'LOOKUP_EMAIL_CHANGED':
      return { ...clearTargetState(state), lookupEmail: action.value }
    case 'LOOKUP_LOADING':
      return { ...state, lookupLoading: true, lookupError: '', accessDenied: '' }
    case 'LOOKUP_SUCCESS':
      return {
        ...state,
        lookupLoading: false,
        lookupError: '',
        selectedUser: action.payload.user,
        lookupEffectiveEntitlement: action.payload.effectiveEntitlement || null,
        lookupPaidFallback: action.payload.paidFallback || null,
      }
    case 'LOOKUP_ERROR':
      return { ...clearTargetState(state), lookupLoading: false, lookupError: action.error }
    case 'GRANT_FORM_CHANGED':
      return {
        ...state,
        grantForm: { ...state.grantForm, [action.field]: action.value },
        grantConfirmation: null,
        grantAttempt: null,
        createError: '',
      }
    case 'OPEN_GRANT_CONFIRMATION':
      return { ...state, grantConfirmation: action.summary, createError: '' }
    case 'CLOSE_GRANT_CONFIRMATION':
      return { ...state, grantConfirmation: null }
    case 'CREATE_STARTED':
      return { ...state, creating: true, createError: '', grantAttempt: action.attempt }
    case 'CREATE_ERROR':
      return { ...state, creating: false, createError: action.error }
    case 'CREATE_SUCCESS':
      return {
        ...clearTargetState(state),
        lookupEmail: '',
        grantForm: { ...EMPTY_GRANT_FORM },
        creating: false,
        grants: replaceGrant(state.grants, action.result.grant, { prepend: true }),
        mutationResult: { operation: 'grant', ...action.result },
      }
    case 'OPEN_REVOKE_CONFIRMATION':
      return {
        ...state,
        revokeConfirmation: action.grant,
        revokeReason: '',
        revokeAttempt: null,
        revokeError: '',
      }
    case 'REVOKE_REASON_CHANGED':
      return { ...state, revokeReason: action.value, revokeAttempt: null, revokeError: '' }
    case 'CLOSE_REVOKE_CONFIRMATION':
      return { ...state, revokeConfirmation: null, revokeReason: '', revokeAttempt: null, revokeError: '' }
    case 'REVOKE_STARTED':
      return { ...state, revokingGrantId: action.grantId, revokeError: '', revokeAttempt: action.attempt }
    case 'REVOKE_ERROR':
      return { ...state, revokingGrantId: null, revokeError: action.error }
    case 'REVOKE_SUCCESS':
      return {
        ...state,
        grants: replaceGrant(state.grants, action.result.grant),
        revokingGrantId: null,
        revokeConfirmation: null,
        revokeReason: '',
        revokeAttempt: null,
        revokeError: '',
        mutationResult: { operation: 'revoke', ...action.result },
      }
    case 'ACCESS_DENIED':
      return {
        ...clearTargetState(state),
        grants: [],
        page: { nextCursor: null, asOf: null },
        listLoading: false,
        lookupLoading: false,
        creating: false,
        revokingGrantId: null,
        revokeConfirmation: null,
        revokeAttempt: null,
        mutationResult: null,
        accessDenied: action.error,
      }
    default:
      return state
  }
}

export function normalizeReasonInput(value) {
  const reason = String(value ?? '')
  if (reason.length > MAX_REASON_LENGTH) throw new Error(`Reason must be ${MAX_REASON_LENGTH} characters or fewer.`)
  if (/[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(reason)) {
    throw new Error('Reason must be plain text without markup or control characters.')
  }
  return reason.trim()
}

export function buildGrantValidity(form) {
  if (form.validityType === 'preset') {
    const days = Number(form.presetDays)
    if (!PRESET_DAYS.includes(days)) throw new Error('Choose an approved preset validity.')
    return { type: 'preset', days }
  }
  if (form.validityType === 'lifetime') return { type: 'lifetime' }
  if (form.validityType !== 'custom' || !form.customExpiresAt) throw new Error('Choose a custom expiration date and time.')
  const expiresAt = new Date(form.customExpiresAt)
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error('Custom expiration must be a valid future date and time.')
  }
  return { type: 'custom', expiresAt: expiresAt.toISOString() }
}

export function buildGrantPayload(state) {
  if (!state.selectedUser?.grantEligible) throw new Error('Look up an eligible verified user before creating a grant.')
  const plan = state.plans.find(value => value.id === state.grantForm.planId && value.active !== false)
  if (!plan) throw new Error('Choose an active canonical plan.')
  return {
    targetEmail: state.selectedUser.email,
    planId: plan.id,
    validity: buildGrantValidity(state.grantForm),
    reason: normalizeReasonInput(state.grantForm.reason),
  }
}

export function mutationFingerprint(payload) {
  return JSON.stringify(payload)
}

export function secureIdempotencyKey(prefix = 'complimentary') {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return `${prefix}-${cryptoApi.randomUUID()}`
  if (typeof cryptoApi?.getRandomValues !== 'function') throw new Error('Secure random operation keys are unavailable in this browser.')
  const bytes = cryptoApi.getRandomValues(new Uint8Array(18))
  const token = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${prefix}-${token}`
}

export function mutationAttempt(existingAttempt, payload, keyFactory = secureIdempotencyKey, prefix = 'complimentary') {
  const fingerprint = mutationFingerprint(payload)
  if (existingAttempt?.fingerprint === fingerprint && existingAttempt.key) return existingAttempt
  return { fingerprint, key: keyFactory(prefix) }
}

export function isAuthorizationDenial(error) {
  return error?.status === 401 || error?.status === 403 || [
    'authentication_required', 'invalid_token', 'token_expired', 'token_revoked',
    'otp_required', 'admin_required', 'admin_capability_required',
  ].includes(error?.code)
}

export function formatLocalTimestampWithZone(value, { locale = 'en-IN', timeZone } = {}) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short', ...(timeZone ? { timeZone } : {}),
  }).format(date)
}

export function formatGrantValidity(value, options) {
  if (value?.lifetime === true || value?.validityType === 'lifetime') return 'Lifetime'
  const formatted = formatLocalTimestampWithZone(value?.expiresAt, options)
  if (formatted === '—') return 'Finite expiration unavailable'
  if (value?.validityType === 'preset' && PRESET_DAYS.includes(Number(value?.presetDays))) {
    return `${value.presetDays} days · ${formatted}`
  }
  return `Until ${formatted}`
}

export function validityPreview(form, { now = Date.now(), ...formatOptions } = {}) {
  if (form.validityType === 'lifetime') return 'Lifetime'
  if (form.validityType === 'preset') {
    const days = Number(form.presetDays)
    if (!PRESET_DAYS.includes(days)) return 'Invalid preset'
    return `Approximately ${formatLocalTimestampWithZone(now + (days * 86400000), formatOptions)} (server time is authoritative)`
  }
  if (!form.customExpiresAt) return 'Choose a custom expiration'
  return `${formatLocalTimestampWithZone(form.customExpiresAt, formatOptions)} (server time is authoritative)`
}

export function entitlementSummary(entitlement) {
  if (!entitlement || entitlement.status !== 'active') return entitlement?.status === 'expired' ? 'Expired access' : 'No active access'
  const plan = entitlement.planName || entitlement.planId || 'Unknown plan'
  const source = entitlement.source === 'complimentary' ? 'complimentary' : entitlement.source === 'paid' ? 'paid' : 'unknown source'
  return `${plan} · ${entitlement.entitlementTier || entitlement.planId || 'unknown tier'} · ${source}`
}
