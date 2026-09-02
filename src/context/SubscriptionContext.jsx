import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { billingService } from '../services/billingService'
import { reconcilePendingBillingOrders } from '../services/pendingBillingOrders'
import {
  DISABLED_ADMIN_CAPABILITIES,
  hasEffectivePlan,
  INACTIVE_SUBSCRIPTION,
  isEffectiveEntitlementActive,
  normalizeBillingMe,
  PLAN_RANK,
  scheduleEntitlementRefresh,
} from '../services/subscriptionEntitlements'

const SubscriptionContext = createContext(null)
export { PLAN_RANK }

export function SubscriptionProvider({ children }) {
  const { user } = useAuth()
  const [plans, setPlans] = useState([])
  const [subscription, setSubscription] = useState(INACTIVE_SUBSCRIPTION)
  const [isAdmin, setIsAdmin] = useState(false)
  const [adminCapabilities, setAdminCapabilities] = useState(DISABLED_ADMIN_CAPABILITIES)
  const [loading, setLoading] = useState(Boolean(user))
  const [initialized, setInitialized] = useState(false)
  const [error, setError] = useState('')
  const [entitlementNow, setEntitlementNow] = useState(() => Date.now())
  const requestGeneration = useRef(0)
  const reconciliation = useRef(null)

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!user) return
    const generation = ++requestGeneration.current
    if (!silent) {
      setLoading(true)
      setError('')
    }
    try {
      const [plansResult, meResult] = await Promise.allSettled([
        billingService.getPlans(),
        billingService.getMe(),
      ])
      if (generation !== requestGeneration.current) return

      if (plansResult.status === 'fulfilled') {
        setPlans(plansResult.value.plans || [])
      }

      if (meResult.status === 'fulfilled') {
        const normalized = normalizeBillingMe(meResult.value)
        setSubscription(normalized.subscription)
        setIsAdmin(normalized.isAdmin)
        setAdminCapabilities(normalized.adminCapabilities)
      } else {
        setSubscription(INACTIVE_SUBSCRIPTION)
        setIsAdmin(false)
        setAdminCapabilities(DISABLED_ADMIN_CAPABILITIES)
      }

      if (meResult.status === 'rejected') {
        setError(meResult.reason?.message || 'Unable to load subscription information.')
      } else if (plansResult.status === 'rejected' && !silent) {
        setError(plansResult.reason?.message || 'Unable to load subscription information.')
      } else {
        setError('')
      }
      setEntitlementNow(Date.now())
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false)
        setInitialized(true)
      }
    }
  }, [user?.uid])

  const refreshAfterMutation = useCallback(
    () => refresh({ silent: true }),
    [refresh],
  )

  const reconcilePending = useCallback(() => {
    if (!user?.uid) return Promise.resolve([])
    if (reconciliation.current) return reconciliation.current
    const uid = user.uid
    const operation = reconcilePendingBillingOrders({
      uid,
      getOrderStatus: billingService.getOrderStatus,
      refresh: refreshAfterMutation,
    }).finally(() => {
      if (reconciliation.current === operation) reconciliation.current = null
    })
    reconciliation.current = operation
    return operation
  }, [user?.uid, refreshAfterMutation])

  useEffect(() => {
    if (!user) {
      requestGeneration.current += 1
      reconciliation.current = null
      setPlans([])
      setSubscription(INACTIVE_SUBSCRIPTION)
      setIsAdmin(false)
      setAdminCapabilities(DISABLED_ADMIN_CAPABILITIES)
      setError('')
      setLoading(false)
      setInitialized(true)
      setEntitlementNow(Date.now())
      return
    }
    setInitialized(false)
    setLoading(true)
    refresh()
    reconcilePending()
  }, [user?.uid, refresh, reconcilePending])

  useEffect(() => {
    if (!user?.uid) return undefined
    const updateFromResume = () => {
      setEntitlementNow(Date.now())
      reconcilePending()
      refresh({ silent: true })
    }
    const updateWhenVisible = () => {
      if (document.visibilityState === 'visible') updateFromResume()
    }
    window.addEventListener('focus', updateFromResume)
    document.addEventListener('visibilitychange', updateWhenVisible)
    return () => {
      window.removeEventListener('focus', updateFromResume)
      document.removeEventListener('visibilitychange', updateWhenVisible)
    }
  }, [user?.uid, reconcilePending, refresh])

  useEffect(() => {
    if (!user?.uid) return undefined
    return scheduleEntitlementRefresh(subscription, {
      now: Date.now(),
      setTimeoutFn: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeoutFn: timer => window.clearTimeout(timer),
      onTick: () => setEntitlementNow(Date.now()),
      onRefresh: refreshAfterMutation,
    })
  }, [
    user?.uid,
    subscription?.status,
    subscription?.lifetime,
    subscription?.expiresAt,
    entitlementNow,
    refreshAfterMutation,
  ])

  const active = useMemo(
    () => isEffectiveEntitlementActive(subscription, entitlementNow),
    [subscription, entitlementNow],
  )

  const hasPlan = useCallback(
    requiredPlan => hasEffectivePlan(subscription, requiredPlan, entitlementNow),
    [subscription, entitlementNow],
  )

  const value = useMemo(() => ({
    plans,
    subscription,
    isAdmin,
    adminCapabilities,
    loading,
    initialized,
    error,
    active,
    hasPlan,
    refresh,
    refreshAfterMutation,
    reconcilePending,
  }), [
    plans,
    subscription,
    isAdmin,
    adminCapabilities,
    loading,
    initialized,
    error,
    active,
    hasPlan,
    refresh,
    refreshAfterMutation,
    reconcilePending,
  ])

  return <SubscriptionContext.Provider value={value}>{children}</SubscriptionContext.Provider>
}

export function useSubscription() {
  const context = useContext(SubscriptionContext)
  if (!context) throw new Error('useSubscription must be used within SubscriptionProvider')
  return context
}
