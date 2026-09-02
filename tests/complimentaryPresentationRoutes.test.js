import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  canAccessAdminCapability,
  entitlementSourceLabel,
  formatEntitlementValidity,
  hasEffectivePlan,
} from '../src/services/subscriptionEntitlements.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = relative => readFile(path.join(root, relative), 'utf8')
const NOW = Date.parse('2026-01-15T12:00:00.000Z')

// Validates: Requirements 1.1-1.4, 4.5, 6.2-6.5, 18.2-18.4, 19.1, 19.3-19.4, 20.4, 20.6

test('presentation helpers distinguish paid, finite complimentary, and lifetime access without inferring lifetime', () => {
  const finite = {
    status: 'active',
    source: 'complimentary',
    planId: 'pro',
    entitlementTier: 'pro',
    lifetime: false,
    expiresAt: '2026-06-01T12:00:00.000Z',
  }

  assert.equal(entitlementSourceLabel(finite), 'Complimentary access')
  assert.equal(entitlementSourceLabel({ ...finite, source: 'paid' }), 'Paid subscription')
  assert.equal(entitlementSourceLabel({}), 'Subscription')

  const finiteLabel = formatEntitlementValidity(finite, { locale: 'en-GB', timeZone: 'Asia/Kolkata' })
  assert.match(finiteLabel, /^Valid until /)
  assert.match(finiteLabel, /1 Jun 2026/)
  assert.match(finiteLabel, /17:30|5:30/)
  assert.match(finiteLabel, /GMT\+5:30|IST/)

  assert.equal(formatEntitlementValidity({ ...finite, lifetime: true, expiresAt: null }), 'Lifetime')
  assert.equal(formatEntitlementValidity({ ...finite, expiresAt: null }), null)
  assert.equal(formatEntitlementValidity({ ...finite, expiresAt: 'invalid' }), null)
})

test('tier authorization remains source agnostic for paid and complimentary effective entitlements', () => {
  const base = {
    status: 'active',
    planId: 'pro',
    entitlementTier: 'pro',
    lifetime: false,
    expiresAt: '2027-01-01T00:00:00.000Z',
  }
  for (const sourceType of ['paid', 'complimentary']) {
    const entitlement = { ...base, source: sourceType }
    assert.equal(hasEffectivePlan(entitlement, 'basic', NOW), true)
    assert.equal(hasEffectivePlan(entitlement, 'pro', NOW), true)
    assert.equal(hasEffectivePlan(entitlement, 'elite', NOW), false)
  }
  assert.equal(hasEffectivePlan({ ...base, source: 'complimentary', lifetime: true, expiresAt: null }, 'pro', NOW), true)
})

test('admin capability policy covers all admin and capability permutations with exact-true semantics', () => {
  const nonAdmins = [false, null, undefined, 0, 1, 'true', {}, []]
  for (const isAdmin of nonAdmins) {
    assert.equal(canAccessAdminCapability(isAdmin, { complimentarySubscriptions: true }, 'complimentarySubscriptions'), false)
    assert.equal(canAccessAdminCapability(isAdmin, {}, undefined), false)
  }

  const deniedCapabilities = [
    undefined,
    null,
    false,
    true,
    'true',
    [],
    {},
    { complimentarySubscriptions: false },
    { complimentarySubscriptions: 'true' },
    { complimentarySubscriptions: 1 },
  ]
  for (const capabilities of deniedCapabilities) {
    assert.equal(canAccessAdminCapability(true, capabilities, 'complimentarySubscriptions'), false)
  }

  assert.equal(canAccessAdminCapability(true, { complimentarySubscriptions: true }, 'complimentarySubscriptions'), true)
  assert.equal(canAccessAdminCapability(true, undefined, undefined), true)
})

test('Subscription, Dashboard, and Layout render source-aware effective access while preserving paid purchase UI', async () => {
  const [subscription, dashboard, layout, paymentHistory] = await Promise.all([
    source('src/pages/Subscription.jsx'),
    source('src/pages/Dashboard.jsx'),
    source('src/components/Layout.jsx'),
    source('src/pages/PaymentHistory.jsx'),
  ])

  for (const view of [subscription, dashboard, layout]) {
    assert.match(view, /entitlementSourceLabel/)
    assert.match(view, /formatEntitlementValidity/)
    assert.doesNotMatch(view, /new Date\(subscription(?:\?\.|\.)expiresAt\)/)
  }
  assert.match(subscription, /Complimentary/)
  assert.match(subscription, /Payment Summary/)
  assert.match(subscription, /billingService\.createOrder/)
  assert.match(subscription, /billingService\.verifyPayment/)
  assert.match(subscription, /loadRazorpayCheckout/)
  assert.match(dashboard, /effectiveTier/)
  assert.match(layout, /Complimentary.*effectivePlanLabel/)

  assert.match(paymentHistory, /billingService\.getPayments\(\)/)
  assert.match(paymentHistory, /billingService\.getInvoice/)
  assert.doesNotMatch(paymentHistory, /complimentary/i)
})

test('admin route and navigation require initialized backend admin plus exact capability while preserving existing admin routes', async () => {
  const [app, adminRoute, layout, subscriptionRoute, shell] = await Promise.all([
    source('src/App.jsx'),
    source('src/components/AdminRoute.jsx'),
    source('src/components/Layout.jsx'),
    source('src/components/SubscriptionRoute.jsx'),
    source('src/pages/AdminComplimentarySubscriptions.jsx'),
  ])

  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/AdminComplimentarySubscriptions'\)\)/)
  assert.match(app, /path="admin\/complimentary-subscriptions" element={<AdminRoute requiredCapability="complimentarySubscriptions">/)
  assert.match(app, /path="admin\/plans" element={<AdminRoute><AdminPlans \/><\/AdminRoute>}/)
  assert.match(app, /path="admin\/coupons" element={<AdminRoute><AdminCoupons \/><\/AdminRoute>}/)

  assert.match(adminRoute, /canAccessAdminCapability\(isAdmin, adminCapabilities, requiredCapability\)/)
  assert.ok(adminRoute.indexOf('!initialized || loading || retrying') < adminRoute.indexOf('if (authorized) return children'))
  assert.match(adminRoute, /Administrative capability unavailable/)

  assert.match(layout, /canAccessAdminCapability\([\s\S]*'complimentarySubscriptions'/)
  assert.match(layout, /to: '\/admin\/complimentary-subscriptions'/)
  assert.match(layout, /isAdmin === true/)
  assert.match(layout, /to: '\/admin\/plans'/)
  assert.match(layout, /to: '\/admin\/coupons'/)

  assert.match(subscriptionRoute, /hasPlan\(requiredPlan\)/)
  assert.match(subscriptionRoute, /!initialized \|\| loading/)
  assert.doesNotMatch(subscriptionRoute, /complimentary|source/)

  assert.match(shell, /Complimentary Subscriptions/)
  assert.match(shell, /billingService\.lookupBillingUser/)
  assert.match(shell, /billingService\.createComplimentaryGrant/)
  assert.match(shell, /billingService\.revokeComplimentaryGrant/)
  assert.doesNotMatch(shell, /firebase\/firestore|from ['"]firebase\/firestore/)
})
