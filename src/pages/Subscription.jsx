import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Check, Crown, Loader2, ShieldCheck, Tag } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useSubscription } from '../context/SubscriptionContext'
import { billingService } from '../services/billingService'
import { addPendingBillingOrder, removePendingBillingOrder } from '../services/pendingBillingOrders'
import { loadRazorpayCheckout } from '../services/razorpayCheckout'

const money = paise => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function newCheckoutKey() {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `checkout-${random}`
}

export default function Subscription() {
  const { user } = useAuth()
  const { plans, subscription, active, loading, error: subscriptionError, refresh } = useSubscription()
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [couponCode, setCouponCode] = useState('')
  const [couponResult, setCouponResult] = useState(null)
  const [couponError, setCouponError] = useState('')
  const [applyingCoupon, setApplyingCoupon] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [quoteNotice, setQuoteNotice] = useState('')
  const checkoutKey = useRef(null)
  const resumeRestored = useRef(false)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    if (plans.length && !plans.some(plan => plan.id === selectedPlanId)) {
      setSelectedPlanId(plans.find(plan => plan.entitlementTier === 'pro')?.id || plans[0].id)
    }
    if (plans.length === 0 && selectedPlanId) setSelectedPlanId('')
  }, [plans, selectedPlanId])

  useEffect(() => {
    if (!resumeRestored.current && plans.length && location.state?.checkoutKey) {
      resumeRestored.current = true
      checkoutKey.current = location.state.checkoutKey
      setSelectedPlanId(location.state.planId || plans[0].id)
      setCouponCode(location.state.couponCode || '')
      setCouponResult(location.state.couponResult || null)
    }
  }, [plans, location.state])

  const selectedPlan = useMemo(
    () => plans.find(plan => plan.id === selectedPlanId) || null,
    [plans, selectedPlanId],
  )
  const originalPaise = selectedPlan?.amountPaise || 0
  const discountPaise = couponResult?.discountPaise || 0
  const finalPaise = couponResult?.amountPaise ?? originalPaise

  const resetCheckout = () => { checkoutKey.current = null }
  const selectPlan = planId => {
    setSelectedPlanId(planId)
    setCouponResult(null)
    setCouponError('')
    setQuoteNotice('')
    resetCheckout()
  }

  const applyCoupon = async event => {
    event.preventDefault()
    const normalized = couponCode.trim().toUpperCase()
    if (!selectedPlan || !normalized) {
      setCouponError('Enter a coupon code first.')
      return
    }
    setApplyingCoupon(true)
    setCouponError('')
    setCouponResult(null)
    setQuoteNotice('')
    resetCheckout()
    try {
      const result = await billingService.validateCoupon(selectedPlan.id, normalized)
      setCouponCode(normalized)
      setCouponResult(result)
      toast.success(`${normalized} applied successfully`)
    } catch (error) {
      setCouponError(error.message || 'Coupon could not be applied.')
    } finally {
      setApplyingCoupon(false)
    }
  }

  const releaseOrder = async (orderId, paymentId) => {
    try {
      await billingService.reportFailure({ orderId, paymentId })
    } catch {
      // Webhook/expiry cleanup remains the authoritative fallback.
    }
  }

  const payNow = async () => {
    if (!selectedPlan || processing) return
    setProcessing(true)
    try {
      checkoutKey.current ||= newCheckoutKey()
      const order = await billingService.createOrder({
        planId: selectedPlan.id,
        couponCode: couponResult?.coupon?.code || null,
        idempotencyKey: checkoutKey.current,
      })
      if (!order.orderId || !order.keyId || order.amountPaise <= 0) {
        throw new Error('A payable Razorpay order could not be created.')
      }
      const serverPlan = order.plan || {}
      const quoteChanged = (
        Number(serverPlan.amountPaise) !== Number(originalPaise)
        || Number(order.discountPaise || 0) !== Number(discountPaise)
        || Number(order.amountPaise) !== Number(finalPaise)
        || serverPlan.name !== selectedPlan.name
        || Number(serverPlan.durationDays) !== Number(selectedPlan.durationDays)
        || serverPlan.entitlementTier !== selectedPlan.entitlementTier
        || JSON.stringify(serverPlan.features || []) !== JSON.stringify(selectedPlan.features || [])
      )
      if (quoteChanged) {
        setCouponResult(order.coupon ? {
          coupon: order.coupon,
          discountPaise: order.discountPaise || 0,
          amountPaise: order.amountPaise,
        } : null)
        setQuoteNotice('The plan price or terms changed. Review the updated summary, then click Pay Now again to confirm.')
        await refresh({ silent: true })
        setProcessing(false)
        return
      }
      setQuoteNotice('')
      addPendingBillingOrder(user?.uid, order.orderId)

      const Razorpay = await loadRazorpayCheckout()
      let settled = false
      const checkout = new Razorpay({
        key: order.keyId,
        amount: order.amountPaise,
        currency: order.currency,
        name: 'Vivek Marco Trader',
        description: `${order.plan.name} subscription`,
        order_id: order.orderId,
        prefill: { name: user?.fullName || '', email: user?.email || '' },
        notes: { planId: order.plan.id },
        theme: { color: '#e94560' },
        modal: {
          ondismiss: async () => {
            if (settled) return
            settled = true
            await releaseOrder(order.orderId)
            setProcessing(false)
            navigate('/payment-failed', {
              state: {
                reason: 'Payment was cancelled.',
                planId: selectedPlan.id,
                couponCode: couponResult?.coupon?.code || null,
                couponResult,
                checkoutKey: checkoutKey.current,
              },
            })
          },
        },
        handler: async response => {
          if (settled) return
          settled = true
          try {
            const result = await billingService.verifyPayment(response)
            removePendingBillingOrder(user?.uid, order.orderId)
            resetCheckout()
            await refresh()
            navigate('/payment-success', { replace: true, state: result })
          } catch (verificationError) {
            setProcessing(false)
            navigate('/payment-pending', {
              replace: true,
              state: {
                orderId: order.orderId,
                paymentId: response.razorpay_payment_id,
                reason: verificationError.message,
              },
            })
          }
        },
      })
      checkout.on('payment.failed', async response => {
        if (settled) return
        settled = true
        const metadata = response?.error?.metadata || {}
        await releaseOrder(order.orderId, metadata.payment_id)
        setProcessing(false)
        navigate('/payment-failed', {
          state: {
            reason: response?.error?.description || 'Payment failed. Please retry.',
            planId: selectedPlan.id,
            couponCode: couponResult?.coupon?.code || null,
            couponResult,
            checkoutKey: checkoutKey.current,
          },
        })
      })
      checkout.open()
    } catch (error) {
      setProcessing(false)
      toast.error(error.message || 'Unable to start payment.')
    }
  }

  return (
    <div className="min-h-screen bg-[#060612] px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="mb-2 text-sm font-semibold uppercase tracking-[0.22em] text-[#f5a623]">Secure subscription</p>
            <h1 className="text-3xl font-bold sm:text-4xl">Choose your trading plan</h1>
            <p className="mt-2 max-w-2xl text-gray-400">Prices and coupon discounts are calculated on the server. Razorpay securely processes your payment.</p>
          </div>
          <div className="flex gap-3">
            <Link to="/payments" className="btn-secondary text-sm">Payment History</Link>
            <Link to="/" className="btn-secondary text-sm">Dashboard</Link>
          </div>
        </div>

        {location.state?.reason === 'subscription_required' && (
          <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
            An active subscription is required for that premium feature.
          </div>
        )}
        {subscriptionError && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{subscriptionError}</div>
        )}
        {active && (
          <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Crown className="text-emerald-400" />
              <div><p className="font-semibold text-emerald-300">Active {subscription.planId} plan</p><p className="text-sm text-gray-400">Valid until {new Date(subscription.expiresAt).toLocaleDateString('en-IN')}</p></div>
            </div>
            <span className="w-fit rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-semibold uppercase text-emerald-300">Active</span>
          </div>
        )}

        {loading && plans.length === 0 ? (
          <div className="flex min-h-[40vh] items-center justify-center gap-3 text-gray-400"><Loader2 className="animate-spin" /> Loading plans…</div>
        ) : plans.length === 0 ? (
          <div className="glass-card p-8 text-center"><h2 className="text-xl font-semibold">No plans are currently available</h2><p className="mt-2 text-sm text-gray-400">Please check back later or contact support.</p></div>
        ) : (
          <div className="grid gap-5 md:grid-cols-3">
            {plans.map(plan => {
              const selected = selectedPlanId === plan.id
              return (
                <button key={plan.id} type="button" onClick={() => selectPlan(plan.id)}
                  className={`glass-card-hover relative p-6 text-left ${selected ? 'border-[#e94560] ring-2 ring-[#e94560]/20' : ''}`}>
                  {plan.id === 'pro' && <span className="absolute right-4 top-4 rounded-full bg-[#e94560]/20 px-2.5 py-1 text-xs font-semibold text-[#e94560]">Popular</span>}
                  <h2 className="text-xl font-bold capitalize">{plan.name}</h2>
                  <div className="mt-4 flex items-end gap-2"><span className="text-3xl font-bold gradient-text">{money(plan.amountPaise)}</span><span className="pb-1 text-sm text-gray-500">/{plan.durationDays} days</span></div>
                  <ul className="mt-5 space-y-3">{plan.features.map(feature => <li key={feature} className="flex gap-2 text-sm text-gray-300"><Check size={17} className="mt-0.5 shrink-0 text-emerald-400" />{feature}</li>)}</ul>
                  <div className={`mt-6 rounded-xl py-2.5 text-center text-sm font-semibold ${selected ? 'bg-gradient-to-r from-[#e94560] to-[#f5a623]' : 'bg-[#2a2a5a]/40 text-gray-300'}`}>{selected ? 'Selected' : 'Select Plan'}</div>
                </button>
              )
            })}
          </div>
        )}

        {quoteNotice && (
          <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200" role="alert">{quoteNotice}</div>
        )}

        {selectedPlan && (
          <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_.8fr]">
            <form onSubmit={applyCoupon} className="glass-card p-5 sm:p-6">
              <div className="flex items-center gap-2"><Tag className="text-[#f5a623]" size={20} /><h2 className="text-lg font-semibold">Have a Coupon Code?</h2></div>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <input className="input-field uppercase" value={couponCode} onChange={event => { setCouponCode(event.target.value); setCouponResult(null); setCouponError(''); setQuoteNotice(''); resetCheckout() }} placeholder="Enter coupon code" maxLength={32} />
                <button type="submit" disabled={applyingCoupon || !couponCode.trim()} className="btn-secondary whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50">{applyingCoupon ? 'Applying…' : 'Apply Coupon'}</button>
              </div>
              {couponError && <p role="alert" className="mt-3 text-sm text-red-400">{couponError}</p>}
              {couponResult && <p className="mt-3 text-sm text-emerald-400">Coupon {couponResult.coupon.code} applied. You save {money(couponResult.discountPaise)}.</p>}
              <div className="mt-6 flex items-start gap-3 rounded-xl border border-blue-500/20 bg-blue-500/10 p-4 text-sm text-blue-200"><ShieldCheck className="mt-0.5 shrink-0" size={19} /><p>Coupon eligibility, usage limits and final amount are revalidated by the server when your payment is verified.</p></div>
            </form>

            <div className="glass-card p-5 sm:p-6">
              <h2 className="text-lg font-semibold">Payment Summary</h2>
              <div className="mt-5 space-y-3 text-sm">
                <div className="flex justify-between text-gray-300"><span>Original Price</span><span>{money(originalPaise)}</span></div>
                <div className="flex justify-between text-emerald-400"><span>Coupon Discount{couponResult ? ` (${couponResult.coupon.code})` : ''}</span><span>-{money(discountPaise)}</span></div>
                <div className="border-t border-[#2a2a5a] pt-4"><div className="flex items-center justify-between"><span className="font-semibold">Final Payable Amount</span><span className="text-2xl font-bold gradient-text">{money(finalPaise)}</span></div></div>
              </div>
              <button type="button" onClick={payNow} disabled={processing || !selectedPlan}
                className="btn-primary mt-6 flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-60">
                {processing ? <><Loader2 size={18} className="animate-spin" /> Processing…</> : `Pay Now • ${money(finalPaise)}`}
              </button>
              <p className="mt-3 text-center text-xs text-gray-500">Payments secured by Razorpay. Secret keys never reach this device.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
