import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSubscription } from '../context/SubscriptionContext'
import { auth } from '../firebase.js'

export default function AdminRoute({ children }) {
  const { user } = useAuth()
  const { isAdmin, initialized, loading, error, refresh } = useSubscription()
  const [retrying, setRetrying] = useState(false)

  const retryAdminCheck = async () => {
    setRetrying(true)
    try {
      await auth.currentUser?.getIdToken(true)
      await refresh()
    } finally {
      setRetrying(false)
    }
  }

  if (!initialized || loading || retrying) {
    return <div className="flex min-h-[40vh] items-center justify-center text-sm text-gray-400" role="status">Checking administrator access…</div>
  }
  if (isAdmin) return children

  return (
    <div className="mx-auto max-w-2xl rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-amber-100" role="alert">
      <h1 className="text-xl font-semibold">Administrator access not recognized</h1>
      <p className="mt-3 text-sm text-amber-100/80">
        The signed-in account {user?.email ? <strong>{user.email}</strong> : ''} was not recognized by the billing server as an administrator.
        Confirm that this exact verified email is listed in Render&apos;s <code>BILLING_ADMIN_EMAILS</code>, restart the backend, then retry.
      </p>
      {error && <p className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className="btn-primary w-auto" onClick={retryAdminCheck}>Retry admin check</button>
        <Link className="btn-secondary w-auto" to="/">Back to dashboard</Link>
      </div>
    </div>
  )
}
