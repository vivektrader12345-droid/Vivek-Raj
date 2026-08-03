/**
 * Firestore Service Layer
 * Handles all CRUD operations for user-specific data
 * 
 * Structure: users/{uid}/profile, settings, trades, strategies, alerts, watchlist, journal
 * 
 * Every operation requires the authenticated user's UID.
 * No cross-user data access is possible.
 */
import {
  doc, collection, setDoc, getDoc, getDocs, updateDoc,
  deleteDoc, addDoc, query, orderBy, limit, where,
  onSnapshot, serverTimestamp, writeBatch
} from 'firebase/firestore'
import { db } from '../firebase'

// ==================== HELPERS ====================

/** Get user document reference */
const userDoc = (uid) => doc(db, 'users', uid)

/** Get subcollection reference */
const userCollection = (uid, collectionName) => collection(db, 'users', uid, collectionName)

/** Get specific document in a subcollection */
const userSubDoc = (uid, collectionName, docId) => doc(db, 'users', uid, collectionName, docId)

// ==================== PROFILE ====================

/**
 * Get user profile
 */
export async function getProfile(uid) {
  const snap = await getDoc(userDoc(uid))
  return snap.exists() ? snap.data() : null
}

/**
 * Update user profile
 */
export async function updateProfile(uid, data) {
  await updateDoc(userDoc(uid), { ...data, updatedAt: serverTimestamp() })
}

/**
 * Create initial user profile (on signup)
 */
export async function createUserProfile(uid, profileData) {
  await setDoc(userDoc(uid), {
    ...profileData,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}

// ==================== SETTINGS ====================

export async function getSettings(uid) {
  const snap = await getDoc(doc(db, 'users', uid, 'data', 'settings'))
  return snap.exists() ? snap.data() : null
}

export async function updateSettings(uid, settings) {
  await setDoc(doc(db, 'users', uid, 'data', 'settings'), {
    ...settings,
    updatedAt: serverTimestamp(),
  }, { merge: true })
}

// ==================== TRADES ====================

export async function getTrades(uid) {
  try {
    const q = query(userCollection(uid, 'trades'), orderBy('createdAt', 'desc'))
    const snap = await getDocs(q)
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (err) {
    // Fallback: no orderBy (avoids missing index errors)
    console.warn('getTrades fallback (no index):', err.message)
    const snap = await getDocs(userCollection(uid, 'trades'))
    const trades = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    trades.sort((a, b) => {
      const dateA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0)
      const dateB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0)
      return dateB - dateA
    })
    return trades
  }
}

export async function addTrade(uid, trade) {
  const ref = await addDoc(userCollection(uid, 'trades'), {
    ...trade,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function updateTrade(uid, tradeId, data) {
  await updateDoc(userSubDoc(uid, 'trades', tradeId), {
    ...data,
    updatedAt: serverTimestamp(),
  })
}

export async function deleteTrade(uid, tradeId) {
  await deleteDoc(userSubDoc(uid, 'trades', tradeId))
}

/**
 * Subscribe to trades in real-time
 */
export function subscribeTrades(uid, callback, onError = (error) => console.error('Trade listener error:', error)) {
  // Don't use orderBy to avoid missing field errors — sort on client side
  const tradesRef = collection(db, 'users', uid, 'trades')
  return onSnapshot(tradesRef, (snap) => {
    const trades = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    // Sort by createdAt descending (client-side)
    trades.sort((a, b) => {
      const dateA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0)
      const dateB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0)
      return dateB - dateA
    })
    callback(trades)
  }, onError)
}


// ==================== STRATEGIES ====================

export async function getStrategies(uid) {
  try {
    const q = query(userCollection(uid, 'strategies'), orderBy('createdAt', 'desc'))
    const snap = await getDocs(q)
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (err) {
    // Fallback: no orderBy (avoids missing index errors)
    console.warn('getStrategies fallback (no index):', err.message)
    const snap = await getDocs(userCollection(uid, 'strategies'))
    const strategies = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    strategies.sort((a, b) => {
      const dateA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0)
      const dateB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0)
      return dateB - dateA
    })
    return strategies
  }
}

export async function addStrategy(uid, strategy) {
  const ref = await addDoc(userCollection(uid, 'strategies'), {
    ...strategy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function updateStrategy(uid, strategyId, data) {
  await updateDoc(userSubDoc(uid, 'strategies', strategyId), {
    ...data,
    updatedAt: serverTimestamp(),
  })
}

export async function deleteStrategy(uid, strategyId) {
  await deleteDoc(userSubDoc(uid, 'strategies', strategyId))
}

// ==================== ALERTS ====================

export async function getAlerts(uid) {
  try {
    const q = query(userCollection(uid, 'alerts'), orderBy('createdAt', 'desc'))
    const snap = await getDocs(q)
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (err) {
    // Fallback: no orderBy (avoids missing index errors)
    console.warn('getAlerts fallback (no index):', err.message)
    const snap = await getDocs(userCollection(uid, 'alerts'))
    const alerts = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    alerts.sort((a, b) => {
      const dateA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0)
      const dateB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0)
      return dateB - dateA
    })
    return alerts
  }
}

export async function addAlert(uid, alert) {
  const ref = await addDoc(userCollection(uid, 'alerts'), {
    ...alert,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function updateAlert(uid, alertId, data) {
  await updateDoc(userSubDoc(uid, 'alerts', alertId), {
    ...data,
    updatedAt: serverTimestamp(),
  })
}

export async function deleteAlert(uid, alertId) {
  await deleteDoc(userSubDoc(uid, 'alerts', alertId))
}

export function subscribeAlerts(uid, callback, onError = (error) => console.error('Alert listener error:', error)) {
  const alertsRef = collection(db, 'users', uid, 'alerts')
  return onSnapshot(alertsRef, (snap) => {
    const alerts = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    alerts.sort((a, b) => {
      const dateA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0)
      const dateB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0)
      return dateB - dateA
    })
    callback(alerts)
  }, onError)
}

// ==================== WATCHLIST ====================

export async function getWatchlist(uid) {
  const q = query(userCollection(uid, 'watchlist'))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export async function addToWatchlist(uid, item) {
  const ref = await addDoc(userCollection(uid, 'watchlist'), {
    ...item,
    addedAt: serverTimestamp(),
  })
  return ref.id
}

export async function removeFromWatchlist(uid, itemId) {
  await deleteDoc(userSubDoc(uid, 'watchlist', itemId))
}

// ==================== JOURNAL ====================

export async function getJournalEntries(uid) {
  try {
    const q = query(userCollection(uid, 'journal'), orderBy('createdAt', 'desc'))
    const snap = await getDocs(q)
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (err) {
    // Fallback: no orderBy (avoids missing index errors)
    console.warn('getJournalEntries fallback (no index):', err.message)
    const snap = await getDocs(userCollection(uid, 'journal'))
    const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    entries.sort((a, b) => {
      const dateA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0)
      const dateB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0)
      return dateB - dateA
    })
    return entries
  }
}

export async function addJournalEntry(uid, entry) {
  const ref = await addDoc(userCollection(uid, 'journal'), {
    ...entry,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function updateJournalEntry(uid, entryId, data) {
  await updateDoc(userSubDoc(uid, 'journal', entryId), {
    ...data,
    updatedAt: serverTimestamp(),
  })
}

export async function deleteJournalEntry(uid, entryId) {
  await deleteDoc(userSubDoc(uid, 'journal', entryId))
}

// ==================== BATCH OPERATIONS ====================

/**
 * Create default data structure for a new user
 */
export async function createDefaultUserData(uid, profile) {
  const batch = writeBatch(db)

  // Main user document (profile)
  batch.set(userDoc(uid), {
    ...profile,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  // Default settings
  batch.set(doc(db, 'users', uid, 'data', 'settings'), {
    currency: 'INR',
    theme: 'dark',
    notifications: true,
    emailAlerts: false,
    defaultPair: 'BTC/USDT',
    riskPerTrade: 2,
    defaultLeverage: 10,
    timezone: 'Asia/Kolkata',
    createdAt: serverTimestamp(),
  })

  await batch.commit()
}

/**
 * Delete all user data (account deletion)
 */
export async function deleteAllUserData(uid) {
  // Delete subcollections
  const collections = ['trades', 'strategies', 'alerts', 'watchlist', 'journal']
  for (const col of collections) {
    const snap = await getDocs(userCollection(uid, col))
    const batch = writeBatch(db)
    snap.docs.forEach(d => batch.delete(d.ref))
    if (snap.docs.length > 0) await batch.commit()
  }
  // Delete settings
  await deleteDoc(doc(db, 'users', uid, 'data', 'settings'))
  // Delete user doc
  await deleteDoc(userDoc(uid))
}

// ==================== BATCH CSV IMPORT ====================

/**
 * batchImportTrades
 *
 * Writes new trades with setDoc (deterministic importId as the doc key so
 * re-imports are idempotent) and updates existing docs with updateDoc.
 *
 * Firestore batches are capped at 500 ops each; we chunk automatically.
 *
 * @param {string}  uid
 * @param {Array<{ trade: object }>}                     toInsert
 *   - Each item must have trade.importId (used as the Firestore doc ID).
 * @param {Array<{ firestoreId: string, updates: object }>} toUpdate
 *   - firestoreId is the Firestore document ID of the existing trade.
 * @param {function(number):void} [onProgress]
 *   - Called with a value 0-100 as operations complete.
 *
 * @returns {Promise<{ inserted: number, updated: number, failed: number,
 *                     insertErrors: string[], updateErrors: string[] }>}
 */
export async function batchImportTrades(uid, toInsert, toUpdate, onProgress) {
  const tradesRef = collection(db, 'users', uid, 'trades')
  const BATCH_LIMIT = 490   // stay safely under the 500-op Firestore limit

  let inserted = 0
  let updated  = 0
  let failed   = 0
  const insertErrors = []
  const updateErrors = []

  const totalOps = toInsert.length + toUpdate.length
  let doneOps = 0

  const reportProgress = () => {
    if (onProgress) onProgress(Math.round((doneOps / Math.max(totalOps, 1)) * 100))
  }

  // ---- INSERTS (batched setDoc with importId as doc key) ----
  for (let start = 0; start < toInsert.length; start += BATCH_LIMIT) {
    const chunk = toInsert.slice(start, start + BATCH_LIMIT)
    const batch = writeBatch(db)

    for (const { trade } of chunk) {
      try {
        const docId  = trade.importId
        const docRef = doc(tradesRef, docId)
        batch.set(docRef, {
          ...trade,
          createdAt:  serverTimestamp(),
          updatedAt:  serverTimestamp(),
        })
      } catch (err) {
        failed++
        insertErrors.push(`Insert prepare error: ${err.message}`)
      }
    }

    try {
      await batch.commit()
      inserted += chunk.length - failed   // approximate; refined below
      doneOps  += chunk.length
    } catch (err) {
      // Batch-level failure — mark the whole chunk as failed
      failed   += chunk.length
      inserted -= chunk.length            // undo the pre-increment
      insertErrors.push(`Batch insert failed (rows ${start + 1}-${start + chunk.length}): ${err.message}`)
      doneOps += chunk.length
    }

    reportProgress()
  }

  // ---- UPDATES (individual updateDoc — updates are typically few) ----
  for (let start = 0; start < toUpdate.length; start += BATCH_LIMIT) {
    const chunk = toUpdate.slice(start, start + BATCH_LIMIT)
    const batch = writeBatch(db)

    for (const { firestoreId, updates } of chunk) {
      try {
        const docRef = doc(tradesRef, firestoreId)
        batch.update(docRef, {
          ...updates,
          updatedAt: serverTimestamp(),
        })
      } catch (err) {
        failed++
        updateErrors.push(`Update prepare error (${firestoreId}): ${err.message}`)
      }
    }

    try {
      await batch.commit()
      updated  += chunk.length
      doneOps  += chunk.length
    } catch (err) {
      failed   += chunk.length
      updateErrors.push(`Batch update failed (chunk ${start + 1}-${start + chunk.length}): ${err.message}`)
      doneOps  += chunk.length
    }

    reportProgress()
  }

  reportProgress()   // ensure 100% is reported at end
  return { inserted, updated, failed, insertErrors, updateErrors }
}
