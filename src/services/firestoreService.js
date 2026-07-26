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
  const q = query(userCollection(uid, 'trades'), orderBy('createdAt', 'desc'))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
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
export function subscribeTrades(uid, callback) {
  const q = query(userCollection(uid, 'trades'), orderBy('createdAt', 'desc'))
  return onSnapshot(q, (snap) => {
    const trades = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    callback(trades)
  })
}


// ==================== STRATEGIES ====================

export async function getStrategies(uid) {
  const q = query(userCollection(uid, 'strategies'), orderBy('createdAt', 'desc'))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
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
  const q = query(userCollection(uid, 'alerts'), orderBy('createdAt', 'desc'))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
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

export function subscribeAlerts(uid, callback) {
  const q = query(userCollection(uid, 'alerts'), orderBy('createdAt', 'desc'))
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  })
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
  const q = query(userCollection(uid, 'journal'), orderBy('createdAt', 'desc'))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
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
