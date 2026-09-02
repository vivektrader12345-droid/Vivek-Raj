import assert from 'node:assert/strict'
import test from 'node:test'

import { BillingApiError, createBillingService } from '../src/services/billingService.js'

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(payload),
  }
}

test('order request sends plan, coupon and idempotency only', async () => {
  const calls = []
  const service = createBillingService({
    baseUrl: 'https://billing.example.invalid',
    fetchAuthenticated: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(201, { orderId: 'order_1', amountPaise: 44910 })
    },
  })

  await service.createOrder({ planId: 'basic', couponCode: 'SAVE10', idempotencyKey: 'checkout-12345678' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://billing.example.invalid/api/v1/billing/orders')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    planId: 'basic',
    couponCode: 'SAVE10',
    idempotencyKey: 'checkout-12345678',
  })
  assert.equal(calls[0].init.body.includes('amount'), false)
  assert.equal(calls[0].init.body.includes('userId'), false)
})

test('payment verification forwards only official Razorpay identifiers', async () => {
  let body
  const service = createBillingService({
    baseUrl: 'https://billing.example.invalid',
    fetchAuthenticated: async (_url, init) => {
      body = JSON.parse(init.body)
      return jsonResponse(200, { payment: { status: 'captured' } })
    },
  })
  const identifiers = {
    razorpay_order_id: 'order_1',
    razorpay_payment_id: 'pay_1',
    razorpay_signature: 'signature',
  }

  await service.verifyPayment(identifiers)
  assert.deepEqual(body, identifiers)
})

test('structured coupon errors retain backend code and request id', async () => {
  const service = createBillingService({
    baseUrl: 'https://billing.example.invalid',
    fetchAuthenticated: async () => jsonResponse(409, {
      error: { code: 'coupon_expired', message: 'This coupon has expired' },
      requestId: 'request-1',
    }),
  })

  await assert.rejects(
    service.validateCoupon('basic', 'OLD'),
    error => error instanceof BillingApiError
      && error.code === 'coupon_expired'
      && error.status === 409
      && error.requestId === 'request-1',
  )
})

test('failure reporting and order polling never send a client amount', async () => {
  const calls = []
  const service = createBillingService({
    baseUrl: 'https://billing.example.invalid',
    fetchAuthenticated: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(200, { status: 'reserved' })
    },
  })

  await service.reportFailure({ orderId: 'order_1', paymentId: 'pay_failed' })
  await service.getOrderStatus('order_1')

  assert.deepEqual(JSON.parse(calls[0].init.body), {
    razorpay_order_id: 'order_1',
    razorpay_payment_id: 'pay_failed',
  })
  assert.equal(calls[1].url.endsWith('/api/v1/billing/orders/order_1'), true)
  assert.equal(calls.some(call => call.init.body?.includes('amount')), false)
})

test('complimentary user lookup uses the authenticated admin endpoint and email-only body', async () => {
  const calls = []
  const service = createBillingService({
    baseUrl: 'https://billing.example.invalid',
    fetchAuthenticated: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(200, { user: { uid: 'user-1', email: 'person@example.com' } })
    },
  })

  await service.lookupBillingUser(' Person@Example.com ')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://billing.example.invalid/api/v1/admin/billing/users/lookup')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: ' Person@Example.com ' })
})

test('complimentary grant listing encodes filters and preserves opaque cursor content', async () => {
  const calls = []
  const service = createBillingService({
    baseUrl: 'https://billing.example.invalid',
    fetchAuthenticated: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(200, { grants: [], page: { nextCursor: null } })
    },
  })

  await service.listComplimentaryGrants({
    limit: 50,
    email: 'person+tag@example.com',
    planId: 'pro/annual',
    status: 'active',
    cursor: 'v1.key+/= &opaque?',
    uid: 'hostile-user',
    isAdmin: true,
    complimentarySubscriptions: true,
  })
  await service.listComplimentaryGrants({
    limit: '',
    email: '   ',
    planId: null,
    status: undefined,
    cursor: '',
  })

  assert.equal(
    calls[0].url,
    'https://billing.example.invalid/api/v1/admin/billing/complimentary-grants?limit=50&email=person%2Btag%40example.com&planId=pro%2Fannual&status=active&cursor=v1.key%2B%2F%3D+%26opaque%3F',
  )
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].url.includes('uid='), false)
  assert.equal(calls[0].url.includes('isAdmin='), false)
  assert.equal(calls[0].url.includes('complimentarySubscriptions='), false)
  assert.equal(calls[1].url, 'https://billing.example.invalid/api/v1/admin/billing/complimentary-grants')
})

test('complimentary grant creation sends only approved fields and returns authoritative duplicate result', async () => {
  const calls = []
  const authoritative = {
    grant: { id: 'grant-1', status: 'active' },
    effectiveEntitlement: { status: 'active', source: 'complimentary', planId: 'pro' },
    paidFallback: { status: 'active', source: 'paid', planId: 'basic' },
    duplicate: true,
    requestId: 'request-duplicate',
  }
  const service = createBillingService({
    baseUrl: 'https://billing.example.invalid',
    fetchAuthenticated: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(200, authoritative)
    },
  })

  const result = await service.createComplimentaryGrant({
    targetEmail: 'person@example.com',
    planId: 'pro',
    validity: {
      type: 'custom',
      expiresAt: '2027-01-01T00:00:00+05:30',
      activationAt: 'forged-client-time',
      lifetime: true,
      price: 0,
    },
    reason: 'Support resolution',
    idempotencyKey: 'grant-operation-123',
    targetUid: 'hostile-user',
    isAdmin: true,
    adminCapabilities: { complimentarySubscriptions: true },
    planName: 'Forged Pro',
    entitlementTier: 'elite',
    features: ['forged'],
    amount: 0,
    status: 'active',
    actorUid: 'hostile-admin',
  })

  assert.equal(calls[0].url, 'https://billing.example.invalid/api/v1/admin/billing/complimentary-grants')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    targetEmail: 'person@example.com',
    planId: 'pro',
    validity: { type: 'custom', expiresAt: '2027-01-01T00:00:00+05:30' },
    reason: 'Support resolution',
    idempotencyKey: 'grant-operation-123',
  })
  assert.deepEqual(result, authoritative)
})

test('complimentary grant revocation encodes the grant id and excludes hostile fields', async () => {
  const calls = []
  const service = createBillingService({
    baseUrl: 'https://billing.example.invalid',
    fetchAuthenticated: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(200, { grant: { id: 'grant/with ?#%', status: 'revoked' }, duplicate: false })
    },
  })

  await service.revokeComplimentaryGrant('grant/with ?#%', {
    reason: 'No longer needed',
    idempotencyKey: 'revoke-operation-123',
    targetUid: 'hostile-user',
    status: 'revoked',
    revokedBy: 'hostile-admin',
    endedAt: 'forged-client-time',
  })

  assert.equal(
    calls[0].url,
    'https://billing.example.invalid/api/v1/admin/billing/complimentary-grants/grant%2Fwith%20%3F%23%25/revoke',
  )
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    reason: 'No longer needed',
    idempotencyKey: 'revoke-operation-123',
  })
})

test('complimentary API errors retain stable details and request ids', async () => {
  const service = createBillingService({
    baseUrl: 'https://billing.example.invalid',
    fetchAuthenticated: async () => ({
      ...jsonResponse(400, {
        error: {
          code: 'invalid_cursor',
          message: 'The page cursor is invalid.',
          details: { field: 'cursor' },
        },
      }),
      headers: new Headers({ 'x-request-id': 'request-from-header' }),
    }),
  })

  await assert.rejects(
    service.listComplimentaryGrants({ cursor: 'tampered' }),
    error => error instanceof BillingApiError
      && error.code === 'invalid_cursor'
      && error.status === 400
      && error.message === 'The page cursor is invalid.'
      && error.requestId === 'request-from-header'
      && error.details?.field === 'cursor',
  )
})

import {
  addPendingBillingOrder,
  entitlementTimerDelay,
  listPendingBillingOrders,
  MAX_ENTITLEMENT_TIMEOUT_MS,
  reconcilePendingBillingOrders,
  removePendingBillingOrder,
} from '../src/services/pendingBillingOrders.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

test('pending billing orders are deduplicated and isolated per user', () => {
  const storage = memoryStorage()
  addPendingBillingOrder('user-a', 'order_1234', storage)
  addPendingBillingOrder('user-a', 'order_1234', storage)
  addPendingBillingOrder('user-b', 'order_5678', storage)

  assert.deepEqual(listPendingBillingOrders('user-a', storage), ['order_1234'])
  assert.deepEqual(listPendingBillingOrders('user-b', storage), ['order_5678'])
  removePendingBillingOrder('user-a', 'order_1234', storage)
  assert.deepEqual(listPendingBillingOrders('user-a', storage), [])
  assert.deepEqual(listPendingBillingOrders('user-b', storage), ['order_5678'])
})

test('pending reconciliation clears paid and terminal orders but retains transient ones', async () => {
  const storage = memoryStorage()
  for (const id of ['order_paid', 'order_expired', 'order_waiting', 'order_network']) {
    addPendingBillingOrder('user-a', id, storage)
  }
  let refreshes = 0
  const statuses = {
    order_paid: { status: 'paid', payment: { id: 'pay_1' } },
    order_expired: { status: 'expired', payment: null },
    order_waiting: { status: 'reserved', payment: null },
  }

  const paid = await reconcilePendingBillingOrders({
    uid: 'user-a',
    storage,
    getOrderStatus: async id => {
      if (id === 'order_network') throw new BillingApiError('offline', { code: 'network_error' })
      return statuses[id]
    },
    refresh: async () => { refreshes += 1 },
  })

  assert.equal(paid.length, 1)
  assert.equal(refreshes, 1)
  assert.deepEqual(listPendingBillingOrders('user-a', storage), ['order_waiting', 'order_network'])
})

test('pending reconciliation removes authenticated order-not-found records', async () => {
  const storage = memoryStorage()
  addPendingBillingOrder('user-a', 'order_missing', storage)

  await reconcilePendingBillingOrders({
    uid: 'user-a',
    storage,
    getOrderStatus: async () => {
      throw new BillingApiError('missing', { code: 'order_not_found', status: 404 })
    },
  })

  assert.deepEqual(listPendingBillingOrders('user-a', storage), [])
})


test('long entitlement timers re-arm in bounded chunks through final expiry', () => {
  const start = Date.UTC(2025, 0, 1)
  const expiry = start + MAX_ENTITLEMENT_TIMEOUT_MS + 60_000

  assert.equal(entitlementTimerDelay(expiry, start), MAX_ENTITLEMENT_TIMEOUT_MS)
  assert.equal(entitlementTimerDelay(expiry, start + MAX_ENTITLEMENT_TIMEOUT_MS), 60_000)
  assert.equal(entitlementTimerDelay(expiry, expiry), 0)
})