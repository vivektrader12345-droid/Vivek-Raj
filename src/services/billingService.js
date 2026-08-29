import { signOut } from 'firebase/auth'
import { auth } from '../firebase.js'
import {
  AuthenticatedFetchError,
  createFirebaseAuthenticatedFetch,
  shouldSignOutForAuthenticationError,
} from './firebaseAuthenticatedFetch.js'
import { resolveWebhookApiBaseUrl } from './webhookApiConfig.js'

export const BILLING_API_BASE_URL = resolveWebhookApiBaseUrl({
  configuredBase: import.meta.env?.VITE_API_URL || import.meta.env?.VITE_WEBHOOK_API_URL,
})

export class BillingApiError extends Error {
  constructor(message, { code = 'request_failed', status = 0, details = null, requestId = null, cause = null } = {}) {
    super(message)
    this.name = 'BillingApiError'
    this.code = code
    this.status = status
    this.details = details
    this.requestId = requestId
    this.cause = cause
  }
}

const authenticatedFetch = createFirebaseAuthenticatedFetch({
  auth,
  reauthenticate: async ({ user, code }) => {
    if (shouldSignOutForAuthenticationError(code) && auth.currentUser === user) {
      await signOut(auth)
    }
  },
})

async function parseResponse(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new BillingApiError('The billing server returned an invalid response.', {
      code: 'invalid_response',
      status: response.status,
      cause,
    })
  }
}

export function createBillingService({
  fetchAuthenticated = authenticatedFetch,
  baseUrl = BILLING_API_BASE_URL,
} = {}) {
  async function request(path, { method = 'GET', body, responseType = 'json' } = {}) {
    try {
      const response = await fetchAuthenticated(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: responseType === 'html' ? 'text/html' : 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }, { timeoutMs: 30000 })

      if (responseType === 'html' && response.ok) return response.text()
      const payload = await parseResponse(response)
      if (!response.ok) {
        throw new BillingApiError(
          payload?.error?.message || `Billing request failed (HTTP ${response.status}).`,
          {
            code: payload?.error?.code || 'http_error',
            status: response.status,
            details: payload?.error?.details ?? null,
            requestId: payload?.requestId || response.headers.get('x-request-id'),
          },
        )
      }
      return payload
    } catch (error) {
      if (error instanceof BillingApiError) throw error
      if (error instanceof AuthenticatedFetchError) {
        throw new BillingApiError(error.message, {
          code: error.code,
          status: error.status,
          details: error.details,
          requestId: error.requestId,
          cause: error,
        })
      }
      throw new BillingApiError('Unable to reach the billing server.', {
        code: 'network_error',
        cause: error,
      })
    }
  }

  const billingRoot = '/api/v1/billing'
  const adminRoot = '/api/v1/admin/billing'
  return {
    getPlans: () => request(`${billingRoot}/plans`),
    getMe: () => request(`${billingRoot}/me`),
    validateCoupon: (planId, couponCode) => request(`${billingRoot}/coupons/validate`, {
      method: 'POST', body: { planId, couponCode },
    }),
    createOrder: ({ planId, couponCode, idempotencyKey }) => request(`${billingRoot}/orders`, {
      method: 'POST', body: { planId, couponCode: couponCode || null, idempotencyKey },
    }),
    verifyPayment: response => request(`${billingRoot}/payments/verify`, {
      method: 'POST', body: response,
    }),
    reportFailure: ({ orderId, paymentId = null }) => request(`${billingRoot}/payments/failure`, {
      method: 'POST',
      body: { razorpay_order_id: orderId, ...(paymentId ? { razorpay_payment_id: paymentId } : {}) },
    }),
    getOrderStatus: orderId => request(`${billingRoot}/orders/${encodeURIComponent(orderId)}`),
    getPayments: () => request(`${billingRoot}/payments`),
    getAdminPlans: () => request(`${adminRoot}/plans`),
    createPlan: plan => request(`${adminRoot}/plans`, { method: 'POST', body: plan }),
    updatePlan: (planId, plan) => request(`${adminRoot}/plans/${encodeURIComponent(planId)}`, {
      method: 'PATCH', body: plan,
    }),
    deactivatePlan: planId => request(`${adminRoot}/plans/${encodeURIComponent(planId)}`, { method: 'DELETE' }),
    reorderPlans: planIds => request(`${adminRoot}/plans/order`, { method: 'PUT', body: { planIds } }),
    getInvoice: orderId => request(`${billingRoot}/payments/${encodeURIComponent(orderId)}/invoice`, {
      responseType: 'html',
    }),
    getCoupons: () => request(`${adminRoot}/coupons`),
    createCoupon: coupon => request(`${adminRoot}/coupons`, { method: 'POST', body: coupon }),
    updateCoupon: (code, coupon) => request(`${adminRoot}/coupons/${encodeURIComponent(code)}`, {
      method: 'PATCH', body: coupon,
    }),
    deactivateCoupon: code => request(`${adminRoot}/coupons/${encodeURIComponent(code)}`, { method: 'DELETE' }),
    getCouponUsages: () => request(`${adminRoot}/coupon-usages?limit=500`),
    getAnalytics: () => request(`${adminRoot}/analytics`),
  }
}

export const billingService = createBillingService()
