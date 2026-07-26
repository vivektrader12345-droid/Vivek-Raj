/**
 * AlertContext - Price Alerts Management
 * Uses Firestore for per-user alert storage (users/{uid}/alerts/)
 */
import React, { createContext, useContext, useState, useEffect } from 'react'
import { useAuth } from './AuthContext'
import {
  getAlerts, addAlert as addAlertFS,
  updateAlert as updateAlertFS, deleteAlert as deleteAlertFS,
  subscribeAlerts,
} from '../services/firestoreService'

const AlertContext = createContext(null)

export function AlertProvider({ children }) {
  const { user } = useAuth()
  const [alerts, setAlerts] = useState([])

  // Subscribe to alerts when user logs in
  useEffect(() => {
    if (!user || !user.uid) {
      setAlerts([])
      return
    }
    const unsubscribe = subscribeAlerts(user.uid, (alertsList) => {
      const formatted = alertsList.map(a => ({
        ...a,
        createdAt: a.createdAt?.toDate?.() ? a.createdAt.toDate().toISOString() : a.createdAt,
      }))
      setAlerts(formatted)
    })
    return () => unsubscribe()
  }, [user])

  const addAlert = async (alert) => {
    if (!user) return null
    const newAlert = { ...alert, active: true, triggered: false, userId: user.uid }
    const docId = await addAlertFS(user.uid, newAlert)
    return { ...newAlert, id: docId }
  }

  const deleteAlert = async (id) => {
    if (!user) return
    await deleteAlertFS(user.uid, id)
  }

  const toggleAlert = async (id) => {
    if (!user) return
    const alert = alerts.find(a => a.id === id)
    if (alert) await updateAlertFS(user.uid, id, { active: !alert.active })
  }

  const triggerAlert = async (id) => {
    if (!user) return
    await updateAlertFS(user.uid, id, { triggered: true, triggeredAt: new Date().toISOString() })
  }

  const clearAllAlerts = async () => {
    if (!user) return
    for (const alert of alerts) {
      await deleteAlertFS(user.uid, alert.id)
    }
  }

  return (
    <AlertContext.Provider value={{ alerts, addAlert, deleteAlert, toggleAlert, triggerAlert, clearAllAlerts }}>
      {children}
    </AlertContext.Provider>
  )
}

export function useAlerts() {
  const context = useContext(AlertContext)
  if (!context) throw new Error('useAlerts must be used within AlertProvider')
  return context
}
