import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { XCircle } from 'lucide-react'

export default function PaymentFailed() {
  const location = useLocation()
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#060612] p-4 text-white">
      <div className="glass-card w-full max-w-lg p-7 text-center sm:p-10">
        <XCircle className="mx-auto text-red-400" size={72} />
        <h1 className="mt-5 text-3xl font-bold">Payment Failed</h1>
        <p className="mt-3 text-gray-400">{location.state?.reason || 'The payment could not be completed. Your coupon was not consumed.'}</p>
        <div className="mt-6 rounded-xl border border-blue-500/20 bg-blue-500/10 p-4 text-sm text-blue-200">You can safely retry. A fresh server-side order and coupon validation will be used.</div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2"><Link to="/" className="btn-secondary text-sm">Dashboard</Link><Link to="/subscription" replace state={location.state} className="btn-primary text-sm">Retry Payment</Link></div>
      </div>
    </div>
  )
}
