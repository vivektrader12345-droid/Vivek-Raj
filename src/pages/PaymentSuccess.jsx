import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'

export default function PaymentSuccess() {
  const location = useLocation()
  const navigate = useNavigate()
  const [seconds, setSeconds] = useState(5)
  const payment = location.state?.payment
  const subscription = location.state?.subscription

  useEffect(() => {
    const interval = setInterval(() => setSeconds(value => Math.max(0, value - 1)), 1000)
    const timeout = setTimeout(() => navigate('/', { replace: true }), 5000)
    return () => { clearInterval(interval); clearTimeout(timeout) }
  }, [navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#060612] p-4 text-white">
      <div className="glass-card w-full max-w-lg p-7 text-center sm:p-10">
        <CheckCircle2 className="mx-auto text-emerald-400" size={72} />
        <h1 className="mt-5 text-3xl font-bold">Payment Successful</h1>
        <p className="mt-2 text-gray-400">Your verified subscription is now active.</p>
        <div className="mt-6 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-left text-sm">
          <div className="flex justify-between"><span className="text-gray-400">Plan</span><span className="font-semibold capitalize">{subscription?.planId || payment?.planId || 'Active'}</span></div>
          {payment?.providerPaymentId && <div className="mt-2 flex justify-between gap-4"><span className="text-gray-400">Payment ID</span><span className="truncate font-mono text-xs">{payment.providerPaymentId}</span></div>}
          {subscription?.expiresAt && <div className="mt-2 flex justify-between"><span className="text-gray-400">Valid until</span><span>{new Date(subscription.expiresAt).toLocaleDateString('en-IN')}</span></div>}
        </div>
        <p className="mt-5 text-sm text-gray-500">Opening dashboard in {seconds} seconds…</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2"><Link to="/payments" className="btn-secondary text-sm">Payment History</Link><Link to="/" replace className="btn-primary text-sm">Go to Dashboard</Link></div>
      </div>
    </div>
  )
}
