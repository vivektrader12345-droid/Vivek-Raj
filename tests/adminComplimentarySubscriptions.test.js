import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildGrantPayload,
  buildGrantValidity,
  complimentaryAdminReducer,
  EMPTY_FILTERS,
  entitlementSummary,
  formatGrantValidity,
  initialComplimentaryAdminState,
  isAuthorizationDenial,
  MAX_REASON_LENGTH,
  mutationAttempt,
  normalizeReasonInput,
  PRESET_DAYS,
  validityPreview,
} from '../src/pages/adminComplimentarySubscriptionsState.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pageSource = () => readFile(path.join(root, 'src/pages/AdminComplimentarySubscriptions.jsx'), 'utf8')
const plan = { id: 'pro', name: 'Pro', entitlementTier: 'pro', features: ['Analytics'], active: true }
const selectedUser = { uid: 'user-1', email: 'person@example.com', grantEligible: true, emailVerified: true, disabled: false }

function readyState() {
  return {
    ...initialComplimentaryAdminState(),
    plans: [plan],
    plansLoading: false,
    selectedUser,
    lookupEmail: selectedUser.email,
    grantForm: { planId: 'pro', validityType: 'preset', presetDays: '30', customExpiresAt: '', reason: ' Support resolution ' },
  }
}

// Validates: Requirements 2.2, 2.4-2.5, 3.1, 4.1-4.5, 14.2, 15.1-15.6, 16.1-16.2, 19.3, 20.4

test('validity controls accept exactly every approved preset plus custom UTC and explicit lifetime', () => {
  assert.deepEqual(PRESET_DAYS, [7, 30, 90, 365])
  for (const days of PRESET_DAYS) {
    assert.deepEqual(buildGrantValidity({ validityType: 'preset', presetDays: String(days) }), { type: 'preset', days })
  }
  assert.throws(() => buildGrantValidity({ validityType: 'preset', presetDays: '31' }), /approved preset/)
  assert.deepEqual(buildGrantValidity({ validityType: 'lifetime' }), { type: 'lifetime' })
  assert.deepEqual(
    buildGrantValidity({ validityType: 'custom', customExpiresAt: '2999-01-01T05:30' }),
    { type: 'custom', expiresAt: new Date('2999-01-01T05:30').toISOString() },
  )
  assert.throws(() => buildGrantValidity({ validityType: 'custom', customExpiresAt: '' }), /custom expiration/)
  assert.equal(validityPreview({ validityType: 'lifetime' }), 'Lifetime')
  assert.match(validityPreview({ validityType: 'preset', presetDays: '7' }, { now: Date.parse('2026-01-01T00:00:00Z'), timeZone: 'UTC' }), /server time is authoritative/)
})

test('grant payload uses selected canonical plan and eligible canonical email only', () => {
  assert.deepEqual(buildGrantPayload(readyState()), {
    targetEmail: 'person@example.com',
    planId: 'pro',
    validity: { type: 'preset', days: 30 },
    reason: 'Support resolution',
  })
  assert.throws(() => buildGrantPayload({ ...readyState(), selectedUser: { ...selectedUser, grantEligible: false } }), /eligible verified user/)
  assert.throws(() => buildGrantPayload({ ...readyState(), grantForm: { ...readyState().grantForm, planId: 'forged' } }), /active canonical plan/)
})

test('reason handling is bounded plain text and never accepts markup or control content', () => {
  assert.equal(normalizeReasonInput('  Customer support resolution  '), 'Customer support resolution')
  assert.equal(normalizeReasonInput(''), '')
  assert.equal(normalizeReasonInput('a'.repeat(MAX_REASON_LENGTH)), 'a'.repeat(MAX_REASON_LENGTH))
  assert.throws(() => normalizeReasonInput('a'.repeat(MAX_REASON_LENGTH + 1)), /500 characters/)
  assert.throws(() => normalizeReasonInput('<img src=x onerror=alert(1)>'), /plain text/)
  assert.throws(() => normalizeReasonInput('unsafe\u0000reason'), /plain text/)
})

test('lookup input edits immediately invalidate target, confirmation, and mutation key', () => {
  const state = {
    ...readyState(),
    lookupEffectiveEntitlement: { status: 'active', source: 'paid' },
    lookupPaidFallback: { status: 'active', source: 'paid' },
    grantConfirmation: { payload: {} },
    grantAttempt: { key: 'grant-fixed', fingerprint: '{}' },
  }
  const next = complimentaryAdminReducer(state, { type: 'LOOKUP_EMAIL_CHANGED', value: 'other@example.com' })
  assert.equal(next.lookupEmail, 'other@example.com')
  assert.equal(next.selectedUser, null)
  assert.equal(next.lookupEffectiveEntitlement, null)
  assert.equal(next.lookupPaidFallback, null)
  assert.equal(next.grantConfirmation, null)
  assert.equal(next.grantAttempt, null)
})

test('independent plan and history failures preserve successful sections and support section retries', () => {
  let state = readyState()
  state = complimentaryAdminReducer(state, { type: 'LIST_SUCCESS', grants: [{ id: 'grant-1' }], page: { asOf: '2026-01-01T00:00:00Z' } })
  state = complimentaryAdminReducer(state, { type: 'PLANS_ERROR', error: 'plans unavailable' })
  assert.deepEqual(state.grants, [{ id: 'grant-1' }])
  assert.equal(state.plansError, 'plans unavailable')

  state = complimentaryAdminReducer(state, { type: 'PLANS_SUCCESS', plans: [plan] })
  state = complimentaryAdminReducer(state, { type: 'LIST_ERROR', error: 'history unavailable' })
  assert.deepEqual(state.plans, [plan])
  assert.deepEqual(state.grants, [{ id: 'grant-1' }])
  assert.equal(state.listError, 'history unavailable')
})

test('filter application resets the fixed-cursor walk and pagination accumulates without duplicates', () => {
  let state = { ...initialComplimentaryAdminState(), filters: { email: 'person@example.com', planId: 'pro', status: 'active' }, grants: [{ id: 'old' }], page: { nextCursor: 'old-cursor', asOf: 'old' } }
  state = complimentaryAdminReducer(state, { type: 'FILTERS_APPLIED' })
  assert.deepEqual(state.appliedFilters, { email: 'person@example.com', planId: 'pro', status: 'active' })
  assert.deepEqual(state.grants, [])
  assert.deepEqual(state.page, { nextCursor: null, asOf: null })

  state = complimentaryAdminReducer(state, { type: 'LIST_SUCCESS', grants: [{ id: 'one' }], page: { nextCursor: 'opaque-cursor', asOf: '2026-01-01T00:00:00Z' } })
  state = complimentaryAdminReducer(state, { type: 'LIST_SUCCESS', append: true, grants: [{ id: 'one' }, { id: 'two' }], page: { nextCursor: null, asOf: '2026-01-01T00:00:00Z' } })
  assert.deepEqual(state.grants.map(grant => grant.id), ['one', 'two'])
  assert.equal(state.page.asOf, '2026-01-01T00:00:00Z')
  state = complimentaryAdminReducer(state, { type: 'FILTERS_RESET' })
  assert.deepEqual(state.appliedFilters, EMPTY_FILTERS)
})

test('idempotency key is reused for an unchanged ambiguous retry and replaced after payload changes', () => {
  const keys = ['grant-key-one', 'grant-key-two']
  const keyFactory = () => keys.shift()
  const payload = { targetEmail: 'person@example.com', planId: 'pro', validity: { type: 'lifetime' }, reason: '' }
  const first = mutationAttempt(null, payload, keyFactory, 'grant')
  const retry = mutationAttempt(first, { ...payload }, keyFactory, 'grant')
  const changed = mutationAttempt(first, { ...payload, reason: 'changed' }, keyFactory, 'grant')
  assert.equal(first.key, 'grant-key-one')
  assert.strictEqual(retry, first)
  assert.equal(changed.key, 'grant-key-two')
})

test('operation-specific reducer state disables only the mutation in flight and keeps retry attempts stable', () => {
  const base = { ...readyState(), listLoading: false }
  const grantAttempt = { key: 'grant-stable-key', fingerprint: '{"grant":true}' }
  let state = complimentaryAdminReducer(base, { type: 'CREATE_STARTED', attempt: grantAttempt })
  assert.equal(state.creating, true)
  assert.equal(state.lookupLoading, false)
  assert.equal(state.listLoading, false)
  assert.deepEqual(state.grantAttempt, grantAttempt)

  state = complimentaryAdminReducer({ ...state, grants: [{ id: 'grant-1', status: 'active' }] }, {
    type: 'OPEN_REVOKE_CONFIRMATION',
    grant: { id: 'grant-1', status: 'active' },
  })
  const revokeAttempt = { key: 'revoke-stable-key', fingerprint: '{"revoke":true}' }
  state = complimentaryAdminReducer(state, { type: 'REVOKE_STARTED', grantId: 'grant-1', attempt: revokeAttempt })
  assert.equal(state.revokingGrantId, 'grant-1')
  assert.deepEqual(state.revokeAttempt, revokeAttempt)
  assert.equal(state.lookupLoading, false)

  state = complimentaryAdminReducer(state, { type: 'REVOKE_ERROR', error: 'ambiguous timeout' })
  assert.equal(state.revokingGrantId, null)
  assert.deepEqual(state.revokeAttempt, revokeAttempt)
  assert.equal(state.revokeConfirmation.id, 'grant-1')
})

test('authoritative create and revoke results replace rows and expose paid or inactive outcomes', () => {
  let state = { ...readyState(), grants: [{ id: 'grant-1', status: 'active' }] }
  state = complimentaryAdminReducer(state, { type: 'CREATE_SUCCESS', result: {
    grant: { id: 'grant-2', status: 'active' },
    effectiveEntitlement: { status: 'active', source: 'complimentary' },
    paidFallback: { status: 'active', source: 'paid' },
    duplicate: false,
  } })
  assert.deepEqual(state.grants.map(grant => grant.id), ['grant-2', 'grant-1'])
  assert.equal(state.selectedUser, null)
  assert.equal(state.grantAttempt, null)
  assert.equal(state.mutationResult.effectiveEntitlement.source, 'complimentary')

  state = complimentaryAdminReducer(state, { type: 'OPEN_REVOKE_CONFIRMATION', grant: state.grants[0] })
  state = complimentaryAdminReducer(state, { type: 'REVOKE_SUCCESS', result: {
    grant: { id: 'grant-2', status: 'revoked' },
    effectiveEntitlement: { status: 'active', source: 'paid' },
    paidFallback: { status: 'active', source: 'paid' },
    duplicate: false,
  } })
  assert.equal(state.grants[0].status, 'revoked')
  assert.equal(state.mutationResult.effectiveEntitlement.source, 'paid')
  assert.equal(state.revokeConfirmation, null)
  assert.equal(state.revokeAttempt, null)
})

test('operation failures retain valid inputs and keys while backend capability denial clears protected data', () => {
  const attempt = { key: 'stable-retry-key', fingerprint: '{}' }
  let state = { ...readyState(), grants: [{ id: 'grant-1' }], grantAttempt: attempt, creating: true }
  state = complimentaryAdminReducer(state, { type: 'CREATE_ERROR', error: 'network unavailable' })
  assert.equal(state.selectedUser.email, 'person@example.com')
  assert.deepEqual(state.grantAttempt, attempt)
  assert.equal(state.grantForm.reason, ' Support resolution ')

  assert.equal(isAuthorizationDenial({ status: 403, code: 'admin_capability_required' }), true)
  assert.equal(isAuthorizationDenial({ status: 500, code: 'billing_unavailable' }), false)
  state = complimentaryAdminReducer(state, { type: 'ACCESS_DENIED', error: 'Capability disabled' })
  assert.deepEqual(state.grants, [])
  assert.equal(state.selectedUser, null)
  assert.equal(state.grantConfirmation, null)
  assert.equal(state.mutationResult, null)
  assert.equal(state.accessDenied, 'Capability disabled')
})

test('formatting covers preset, custom, lifetime, source summaries, and malformed values', () => {
  assert.equal(formatGrantValidity({ validityType: 'lifetime', lifetime: true, expiresAt: null }), 'Lifetime')
  assert.match(formatGrantValidity({ validityType: 'preset', presetDays: 30, expiresAt: '2026-06-01T00:00:00Z' }, { timeZone: 'UTC' }), /^30 days ·/)
  assert.match(formatGrantValidity({ validityType: 'custom', expiresAt: '2026-06-01T00:00:00Z' }, { timeZone: 'UTC' }), /^Until /)
  assert.equal(formatGrantValidity({ validityType: 'custom', expiresAt: null }), 'Finite expiration unavailable')
  assert.equal(entitlementSummary({ status: 'active', planName: 'Pro', entitlementTier: 'pro', source: 'complimentary' }), 'Pro · pro · complimentary')
  assert.equal(entitlementSummary({ status: 'inactive' }), 'No active access')
})

test('administration component wires complete states, API methods, confirmations, audit details, refreshes, and text-only reasons', async () => {
  const source = await pageSource()
  for (const method of ['getPlans', 'lookupBillingUser', 'listComplimentaryGrants', 'createComplimentaryGrant', 'revokeComplimentaryGrant']) {
    assert.match(source, new RegExp(`billingService\\.${method}`))
  }
  assert.match(source, /refreshAfterMutation/)
  assert.match(source, /Promise\.allSettled/)
  assert.match(source, /grantEligible/)
  assert.match(source, /PRESET_DAYS/)
  assert.match(source, /datetime-local/)
  assert.match(source, /Lifetime/)
  assert.match(source, /Current effective state/)
  assert.match(source, /Paid fallback/)
  assert.match(source, /atomically superseded/)
  assert.match(source, /nextCursor/)
  assert.match(source, /Load next page/)
  assert.match(source, /No complimentary grants match these filters/)
  assert.match(source, /Grant ID/)
  assert.match(source, /Target UID/)
  assert.match(source, /Created by/)
  assert.match(source, /End reason/)
  assert.match(source, /Superseding actor/)
  assert.match(source, /Confirm access revocation/)
  assert.match(source, /Authoritative revoke result/)
  assert.match(source, /ACCESS_DENIED/)
  assert.match(source, /Protected lookup and grant data has been cleared/)
  assert.match(source, /whitespace-pre-wrap/)
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|firebase\/firestore|from ['"]firebase\/firestore/)
})
