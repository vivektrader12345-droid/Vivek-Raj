import React from 'react'
import { Navigate } from 'react-router-dom'
import { useSubscription } from '../context/SubscriptionContext'

export default function AdminRoute({ children }) {
  const { isAdmin, initialized, loading } = useSubscription()
  if (!initialized || loading) {
    return <div className="flex min-h-[40vh] items-center justify-center text-sm text-gray-400" role="status">Checking administrator access…</div>
  }
  return isAdmin ? children : <Navigate to="/" replace />
}
