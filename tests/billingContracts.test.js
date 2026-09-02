import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = relative => readFile(path.join(root, relative), 'utf8')

const sourceTree = async relative => {
  const absolute = path.join(root, relative)
  const entries = await readdir(absolute, { withFileTypes: true })
  const files = await Promise.all(entries.map(async entry => {
    const child = path.join(relative, entry.name)
    return entry.isDirectory() ? sourceTree(child) : [child]
  }))
  return files.flat()
}

test('all successful login paths redirect to subscription', async () => {
  const login = await source('src/pages/Login.jsx')
  assert.equal((login.match(/navigate\('\/subscription'\)/g) || []).length, 3)
  assert.match(login, /window\.location\.href = '\/subscription'/)
  assert.doesNotMatch(login, /navigate\('\/'\)/)
})

test('premium route contracts distinguish Pro and Elite access', async () => {
  const [app, context, entitlement, route] = await Promise.all([
    source('src/App.jsx'),
    source('src/context/SubscriptionContext.jsx'),
    source('src/services/subscriptionEntitlements.js'),
    source('src/components/SubscriptionRoute.jsx'),
  ])
  assert.match(entitlement, /basic: 1, pro: 2, elite: 3/)
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
  assert.match(context, /scheduleEntitlementRefresh/)
  assert.match(context, /subscription\?\.lifetime/)
  assert.match(context, /subscription\?\.expiresAt/)
  assert.match(context, /setEntitlementNow\(Date\.now\(\)\)/)
  assert.match(context, /refreshAfterMutation/)
  assert.match(context, /reconcilePendingBillingOrders/)
  assert.match(checkout, /addPendingBillingOrder\(user\?\.uid, order\.orderId\)/)
  assert.match(checkout, /removePendingBillingOrder\(user\?\.uid, order\.orderId\)/)
  assert.match(pending, /listPendingBillingOrders\(user\?\.uid\)/)
  assert.match(pending, /TERMINAL_ORDER_STATUSES/)
  assert.doesNotMatch(storage, /razorpay_signature|paymentId|amountPaise|email/)
})


test('complimentary server secrets and collection internals stay out of client artifacts', async () => {
  const clientFiles = (await sourceTree('src')).filter(file => /\.(?:js|jsx|ts|tsx|css)$/.test(file))
  const configuredClientFiles = ['.env.example', 'vite.config.js', 'netlify.toml']
  const content = (await Promise.all([...clientFiles, ...configuredClientFiles].map(source))).join('\n')

  assert.doesNotMatch(content, /BILLING_COMPLIMENTARY_CURSOR_SIGNING_KEY/)
  assert.doesNotMatch(content, /BILLING_COMPLIMENTARY_CURSOR_KEY_ID/)
  assert.doesNotMatch(content, /BILLING_ADMIN_EMAILS/)
  assert.doesNotMatch(content, /billing_complimentary_(?:grants|users|operations|audit)/)
  assert.doesNotMatch(content, /replace_with_a_cryptographically_random_server_secret/)
})


test('complimentary rollout configuration is server-only and fail-closed by default', async () => {
  const [backendEnv, rootRender, backendRender, clientEnv] = await Promise.all([
    source('backend/.env.example'),
    source('render.yaml'),
    source('backend/render.yaml'),
    source('.env.example'),
  ])
  for (const serverConfig of [backendEnv, rootRender, backendRender]) {
    assert.match(serverConfig, /BILLING_COMPLIMENTARY_ADMIN_ENABLED/)
    assert.match(serverConfig, /BILLING_COMPLIMENTARY_CURSOR_SIGNING_KEY/)
    assert.match(serverConfig, /BILLING_COMPLIMENTARY_CURSOR_KEY_ID/)
  }
  assert.match(backendEnv, /BILLING_COMPLIMENTARY_ADMIN_ENABLED=false/)
  assert.doesNotMatch(clientEnv, /BILLING_COMPLIMENTARY_/)
})
