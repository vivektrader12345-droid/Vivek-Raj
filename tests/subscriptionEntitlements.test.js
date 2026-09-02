import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  entitlementFormattingInputs,
  entitlementTierRank,
  entitlementTimerDecision,
  hasEffectivePlan,
  INACTIVE_SUBSCRIPTION,
  isEffectiveEntitlementActive,
  normalizeAdminCapabilities,
  normalizeBillingMe,
  scheduleEntitlementRefresh,
} from '../src/services/subscriptionEntitlements.js'
import { MAX_ENTITLEMENT_TIMEOUT_MS } from '../src/services/pendingBillingOrders.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NOW = Date.parse('2026-01-15T12:00:00.000Z')
const finite = expiresAt => ({
  status: 'active',
  source: 'complimentary',
  planId: 'pro',
  entitlementTier: 'pro',
  lifetime: false,
  validityType: 'preset',
  expiresAt,
})

// Validates: Requirements 6.4-6.6, 10.8, 19.4

test('effective active state requires active status plus explicit lifetime or future finite expiry', () => {
  assert.equal(isEffectiveEntitlementActive(finite('2026-01-15T12:00:00.001Z'), NOW), true)
  assert.equal(isEffectiveEntitlementActive(finite('2026-01-15T12:00:00.000Z'), NOW), false)
  assert.equal(isEffectiveEntitlementActive(finite('2026-01-15T11:59:59.999Z'), NOW), false)
  assert.equal(isEffectiveEntitlementActive({ ...finite(null), lifetime: true, validityType: 'lifetime' }, NOW), true)
  assert.equal(isEffectiveEntitlementActive({ ...finite(null), expiresAt: null }, NOW), false)
  assert.equal(isEffectiveEntitlementActive({ ...finite('not-a-date') }, NOW), false)
  assert.equal(isEffectiveEntitlementActive({ ...finite('2027-01-01T00:00:00Z'), status: 'inactive' }, NOW), false)
  assert.equal(isEffectiveEntitlementActive(INACTIVE_SUBSCRIPTION, NOW), false)
})

test('tier ranking and hasPlan use the effective entitlement tier and reject unknown requirements', () => {
  assert.deepEqual(['basic', 'pro', 'elite'].map(entitlementTierRank), [1, 2, 3])
  assert.equal(entitlementTierRank('PRO'), 0)
  assert.equal(entitlementTierRank(null), 0)

  const elite = { ...finite('2027-01-01T00:00:00Z'), planId: 'basic', entitlementTier: 'elite' }
  assert.equal(hasEffectivePlan(elite, 'basic', NOW), true)
  assert.equal(hasEffectivePlan(elite, 'pro', NOW), true)
  assert.equal(hasEffectivePlan(elite, 'elite', NOW), true)
  assert.equal(hasEffectivePlan(elite, 'unknown', NOW), false)
  assert.equal(hasEffectivePlan({ ...elite, status: 'inactive' }, 'basic', NOW), false)
})

test('source and validity formatting inputs preserve source changes and never turn missing expiry into lifetime', () => {
  assert.deepEqual(entitlementFormattingInputs({
    ...finite('2026-02-01T00:00:00Z'),
    source: 'paid',
    validityType: 'finite',
  }), {
    source: 'paid',
    complimentary: false,
    lifetime: false,
    validityType: 'finite',
    expiresAt: '2026-02-01T00:00:00Z',
  })
  assert.deepEqual(entitlementFormattingInputs({ ...finite(null), lifetime: true, validityType: 'lifetime' }), {
    source: 'complimentary',
    complimentary: true,
    lifetime: true,
    validityType: 'lifetime',
    expiresAt: null,
  })
  assert.deepEqual(entitlementFormattingInputs({ ...finite(null), expiresAt: null }), {
    source: 'complimentary',
    complimentary: true,
    lifetime: false,
    validityType: null,
    expiresAt: null,
  })
  assert.deepEqual(entitlementFormattingInputs({}), {
    source: null,
    complimentary: false,
    lifetime: false,
    validityType: null,
    expiresAt: null,
  })
})

test('capability normalization enables complimentary administration only for exact true on an exact admin session', () => {
  const values = [undefined, null, false, true, [], 'true', 1, {}, { complimentarySubscriptions: false }, { complimentarySubscriptions: 'true' }]
  for (const value of values) {
    assert.deepEqual(normalizeAdminCapabilities(value, true), { complimentarySubscriptions: false })
    assert.deepEqual(normalizeAdminCapabilities(value, false), { complimentarySubscriptions: false })
  }
  assert.deepEqual(
    normalizeAdminCapabilities({ complimentarySubscriptions: true }, true),
    { complimentarySubscriptions: true },
  )
  assert.deepEqual(
    normalizeAdminCapabilities({ complimentarySubscriptions: true }, false),
    { complimentarySubscriptions: false },
  )
})

test('billing me normalization preserves paid and complimentary shapes while failing closed for malformed sessions', () => {
  const paid = finite('2026-03-01T00:00:00Z')
  assert.deepEqual(normalizeBillingMe({
    subscription: paid,
    isAdmin: true,
    adminCapabilities: { complimentarySubscriptions: true },
  }), {
    subscription: paid,
    isAdmin: true,
    adminCapabilities: { complimentarySubscriptions: true },
  })
  assert.deepEqual(normalizeBillingMe({
    subscription: { ...paid, lifetime: true, expiresAt: null },
    isAdmin: false,
    adminCapabilities: { complimentarySubscriptions: true },
  }).adminCapabilities, { complimentarySubscriptions: false })
  assert.deepEqual(normalizeBillingMe(null), {
    subscription: INACTIVE_SUBSCRIPTION,
    isAdmin: false,
    adminCapabilities: { complimentarySubscriptions: false },
  })
})

test('finite timer decisions use strict boundaries and bounded chunks while lifetime has no timer', () => {
  assert.equal(entitlementTimerDecision({ ...finite(null), lifetime: true }, NOW), null)
  assert.equal(entitlementTimerDecision(finite(null), NOW), null)
  assert.equal(entitlementTimerDecision(finite(NOW), NOW), null)

  const near = entitlementTimerDecision(finite(NOW + 5_000), NOW)
  assert.deepEqual(near, { expiresAt: NOW + 5_000, delay: 5_000, refreshOnFire: true })

  const far = entitlementTimerDecision(finite(NOW + MAX_ENTITLEMENT_TIMEOUT_MS + 5_000), NOW)
  assert.deepEqual(far, {
    expiresAt: NOW + MAX_ENTITLEMENT_TIMEOUT_MS + 5_000,
    delay: MAX_ENTITLEMENT_TIMEOUT_MS,
    refreshOnFire: false,
  })
})

test('fake timers prove lifetime schedules nothing and finite expiry ticks then refreshes', () => {
  const scheduled = []
  const cleared = []
  let ticks = 0
  let refreshes = 0
  const fakeSetTimeout = (callback, delay) => {
    scheduled.push({ callback, delay, id: scheduled.length + 1 })
    return scheduled.length
  }
  const fakeClearTimeout = id => cleared.push(id)
  const options = {
    now: NOW,
    setTimeoutFn: fakeSetTimeout,
    clearTimeoutFn: fakeClearTimeout,
    onTick: () => { ticks += 1 },
    onRefresh: () => { refreshes += 1 },
  }

  scheduleEntitlementRefresh({ ...finite(null), lifetime: true }, options)
  assert.equal(scheduled.length, 0)

  const cancel = scheduleEntitlementRefresh(finite(NOW + 2_000), options)
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].delay, 2_000)
  scheduled[0].callback()
  assert.equal(ticks, 1)
  assert.equal(refreshes, 1)
  cancel()
  assert.deepEqual(cleared, [1])
})

test('SubscriptionContext wires fail-closed reads and expiry, focus, visibility, and mutation refresh paths', async () => {
  const context = await readFile(path.join(root, 'src/context/SubscriptionContext.jsx'), 'utf8')
  assert.match(context, /normalizeBillingMe/)
  assert.match(context, /scheduleEntitlementRefresh/)
  assert.match(context, /setSubscription\(INACTIVE_SUBSCRIPTION\)/)
  assert.match(context, /setAdminCapabilities\(DISABLED_ADMIN_CAPABILITIES\)/)
  assert.match(context, /window\.addEventListener\('focus', updateFromResume\)/)
  assert.match(context, /document\.addEventListener\('visibilitychange', updateWhenVisible\)/)
  assert.match(context, /refreshAfterMutation/)
  assert.match(context, /refresh\(\{ silent: true \}\)/)
})
