import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Clock3, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useSubscription } from '../context/SubscriptionContext'
import { billingService } from '../services/billingService'
import {
  listPendingBillingOrders,
  removePendingBillingOrder,
  TERMINAL_ORDER_STATUSES,
} from '../services/pendingBillingOrders'

export default function PaymentPending() {
  const { state } = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { refresh } = useSubscription()
  const [orderId] = useState(() => state?.orderId || listPendingBillingOrders(user?.uid)[0] || '')
  const [checking, setChecking] = useState(Boolean(orderId))
  const [message, setMessage] = useState(orderId
    ? 'Razorpay accepted the checkout response. We are securely confirming it with the server.'
    : 'No pending payment was found for this account. Check Payment History for the latest status.')

  useEffect(() => {
    if (!orderId) return undefined
    let cancelled = false
    let timeoutId
    let attempts = 0
    const stopAsTerminal = status => {
      removePendingBillingOrder(user?.uid, orderId)
      setChecking(false)
      setMessage(status === 'expired'
        ? 'This checkout expired before payment confirmation. You can safely start a new checkout.'
        : 'This checkout did not complete. No successful payment was recorded; you can retry from the subscription page.')
    }
    const check = async () => {
      attempts += 1
      try {
        const result = await billingService.getOrderStatus(orderId)
        if (cancelled) return
        if (result.status === 'paid' && result.payment) {
          removePendingBillingOrder(user?.uid, orderId)
          await refresh({ silent: true })
          navigate('/payment-success', {
            replace: true,
            state: { payment: result.payment, subscription: result.subscription },
          })
          return
        }
        if (TERMINAL_ORDER_STATUSES.has(result.status)) {
          stopAsTerminal(result.status)
          return
        }
        if (attempts >= 15) {
          setChecking(false)
          setMessage('Confirmation is taking longer than usual. Do not pay again. The signed Razorpay webhook can still complete activation; check Payment History shortly.')
          return
        }
      } catch (error) {
        if (cancelled) return
        if (error?.status === 404 && error?.code === 'order_not_found') {
          removePendingBillingOrder(user?.uid, orderId)
          setChecking(false)
          setMessage('This pending checkout is no longer available. Check Payment History before starting another payment.')
          return
        }
        if (attempts >= 15) {
          setChecking(false)
          setMessage('We could not confirm the payment yet. Do not pay again. Check Payment History or contact support with your order ID.')
          return
        }
      }
      if (!cancelled) timeoutId = window.setTimeout(check, 2000)
    }
    check()
    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [orderId, user?.uid, navigate, refresh])

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#060612] p-4 text-white">
      <div className="glass-card w-full max-w-lg p-7 text-center sm:p-10">
        {checking ? <Loader2 className="mx-auto animate-spin text-[#f5a623]" size={64} /> : <Clock3 className="mx-auto text-[#f5a623]" size={64} />}
        <h1 className="mt-5 text-3xl font-bold">Confirming Payment</h1>
        <p className="mt-3 text-gray-400">{message}</p>
        {orderId && <p className="mt-5 break-all rounded-lg bg-[#0a0a1f] p-3 font-mono text-xs text-gray-500">Order: {orderId}</p>}
        <div className="mt-6 grid gap-3 sm:grid-cols-2"><Link to="/payments" className="btn-secondary text-sm">Payment History</Link><Link to="/" className="btn-secondary text-sm">Dashboard</Link></div>
      </div>
    </div>
  )
}
