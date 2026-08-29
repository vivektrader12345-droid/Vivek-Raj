import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useSubscription } from '../context/SubscriptionContext'

export default function SubscriptionRoute({ children, requiredPlan = 'basic' }) {
  const { hasPlan, initialized, loading } = useSubscription()
  const location = useLocation()

  if (!initialized || loading) {
    return <div className="flex min-h-[40vh] items-center justify-center text-sm text-gray-400" role="status">Checking subscription…</div>
  }
  if (!hasPlan(requiredPlan)) {
    return <Navigate to="/subscription" replace state={{ from: location.pathname, reason: 'subscription_required', requiredPlan }} />
  }
  return children
}
