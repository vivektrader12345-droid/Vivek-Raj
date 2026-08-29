import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = relative => readFile(path.join(root, relative), 'utf8')

test('all successful login paths redirect to subscription', async () => {
  const login = await source('src/pages/Login.jsx')
  assert.equal((login.match(/navigate\('\/subscription'\)/g) || []).length, 3)
  assert.match(login, /window\.location\.href = '\/subscription'/)
  assert.doesNotMatch(login, /navigate\('\/'\)/)
})

test('premium route contracts distinguish Pro and Elite access', async () => {
  const [app, context, route] = await Promise.all([
    source('src/App.jsx'),
    source('src/context/SubscriptionContext.jsx'),
    source('src/components/SubscriptionRoute.jsx'),
  ])
  assert.match(context, /basic: 1, pro: 2, elite: 3/)
  assert.match(app, /requiredPlan="pro"><Analytics/)
  assert.match(app, /requiredPlan="pro"><AlgoTrading/)
  assert.match(app, /requiredPlan="pro"><WebhookIntelligence/)
  assert.match(app, /requiredPlan="elite"><ProTrading/)
  assert.match(route, /!initialized \|\| loading/)
})

test('checkout uses official script and ambiguous verification goes pending', async () => {
  const [loader, subscription, app] = await Promise.all([
    source('src/services/razorpayCheckout.js'),
    source('src/pages/Subscription.jsx'),
    source('src/App.jsx'),
  ])
  assert.match(loader, /https:\/\/checkout\.razorpay\.com\/v1\/checkout\.js/)
  assert.match(subscription, /billingService\.verifyPayment\(response\)/)
  assert.match(subscription, /navigate\('\/payment-pending'/)
  assert.match(app, /path="\/payment-pending"/)
})

test('frontend contains no Razorpay secret configuration', async () => {
  const files = [
    'src/services/billingService.js',
    'src/services/razorpayCheckout.js',
    'src/pages/Subscription.jsx',
    '.env.example',
  ]
  const content = (await Promise.all(files.map(source))).join('\n')
  assert.doesNotMatch(content, /RAZORPAY_KEY_SECRET/)
  assert.doesNotMatch(content, /RAZORPAY_WEBHOOK_SECRET/)
  assert.doesNotMatch(content, /VITE_RAZORPAY_SECRET/)
})


test('entitlements expire reactively and pending payments survive route reloads', async () => {
  const [context, checkout, pending, storage] = await Promise.all([
    source('src/context/SubscriptionContext.jsx'),
    source('src/pages/Subscription.jsx'),
    source('src/pages/PaymentPending.jsx'),
    source('src/services/pendingBillingOrders.js'),
  ])
  assert.match(context, /window\.setTimeout/)
  assert.match(context, /subscription\?\.expiresAt, entitlementNow, refresh/)
  assert.match(context, /setEntitlementNow\(Date\.now\(\)\)/)
  assert.match(context, /reconcilePendingBillingOrders/)
  assert.match(checkout, /addPendingBillingOrder\(user\?\.uid, order\.orderId\)/)
  assert.match(checkout, /removePendingBillingOrder\(user\?\.uid, order\.orderId\)/)
  assert.match(pending, /listPendingBillingOrders\(user\?\.uid\)/)
  assert.match(pending, /TERMINAL_ORDER_STATUSES/)
  assert.doesNotMatch(storage, /razorpay_signature|paymentId|amountPaise|email/)
})