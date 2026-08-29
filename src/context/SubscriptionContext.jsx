import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { billingService } from '../services/billingService'
import {
  entitlementTimerDelay,
  MAX_ENTITLEMENT_TIMEOUT_MS,
  reconcilePendingBillingOrders,
} from '../services/pendingBillingOrders'

const SubscriptionContext = createContext(null)
const inactiveSubscription = Object.freeze({ status: 'inactive', planId: null, entitlementTier: null, expiresAt: null })
export const PLAN_RANK = Object.freeze({ basic: 1, pro: 2, elite: 3 })

export function SubscriptionProvider({ children }) {
  const { user } = useAuth()
  const [plans, setPlans] = useState([])
  const [subscription, setSubscription] = useState(inactiveSubscription)
  const [isAdmin, setIsAdmin] = useState(false)
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
        setSubscription(meResult.value.subscription || inactiveSubscription)
        setIsAdmin(Boolean(meResult.value.isAdmin))
      } else if (!silent) {
        setSubscription(inactiveSubscription)
        setIsAdmin(false)
      }

      const failure = [meResult, plansResult].find(result => result.status === 'rejected')
      if (failure) {
        if (!silent) setError(failure.reason?.message || 'Unable to load subscription information.')
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

  const reconcilePending = useCallback(() => {
    if (!user?.uid) return Promise.resolve([])
    if (reconciliation.current) return reconciliation.current
    const uid = user.uid
    const operation = reconcilePendingBillingOrders({
      uid,
      getOrderStatus: billingService.getOrderStatus,
      refresh: () => refresh({ silent: true }),
    }).finally(() => {
      if (reconciliation.current === operation) reconciliation.current = null
    })
    reconciliation.current = operation
    return operation
  }, [user?.uid, refresh])

  useEffect(() => {
    if (!user) {
      requestGeneration.current += 1
      reconciliation.current = null
      setPlans([])
      setSubscription(inactiveSubscription)
      setIsAdmin(false)
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
    if (!user?.uid || !subscription?.expiresAt) return undefined
    const expiresAt = new Date(subscription.expiresAt).getTime()
    if (!Number.isFinite(expiresAt)) return undefined
    const remaining = expiresAt - Date.now()
    const delay = entitlementTimerDelay(expiresAt)
    if (remaining <= 0 || delay <= 0) return undefined
    const timer = window.setTimeout(() => {
      setEntitlementNow(Date.now())
      if (remaining <= MAX_ENTITLEMENT_TIMEOUT_MS) refresh({ silent: true })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [user?.uid, subscription?.expiresAt, entitlementNow, refresh])

  const active = useMemo(() => {
    if (subscription?.status !== 'active' || !subscription?.expiresAt) return false
    const expiresAt = new Date(subscription.expiresAt).getTime()
    return Number.isFinite(expiresAt) && expiresAt > entitlementNow
  }, [subscription, entitlementNow])

  const hasPlan = useCallback(requiredPlan => {
    const requiredRank = PLAN_RANK[requiredPlan] || Number.MAX_SAFE_INTEGER
    const entitlementTier = subscription?.entitlementTier || subscription?.planId
    return active && (PLAN_RANK[entitlementTier] || 0) >= requiredRank
  }, [active, subscription?.entitlementTier, subscription?.planId])

  const value = useMemo(() => ({
    plans,
    subscription,
    isAdmin,
    loading,
    initialized,
    error,
    active,
    hasPlan,
    refresh,
    reconcilePending,
  }), [plans, subscription, isAdmin, loading, initialized, error, active, hasPlan, refresh, reconcilePending])

  return <SubscriptionContext.Provider value={value}>{children}</SubscriptionContext.Provider>
}

export function useSubscription() {
  const context = useContext(SubscriptionContext)
  if (!context) throw new Error('useSubscription must be used within SubscriptionProvider')
  return context
}
