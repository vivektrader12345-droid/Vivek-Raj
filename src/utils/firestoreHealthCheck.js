/**
 * Firestore Health Check
 * Tests if Firestore is reachable and rules allow reads for the current user.
 * Used to diagnose "blank screen" issues caused by Firestore being unreachable.
 */
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase'

/**
 * Test Firestore connectivity for a given user.
 * Returns { ok: true } or { ok: false, error: string, code: string }
 */
export async function checkFirestoreHealth(uid) {
  if (!uid) {
    return { ok: false, error: 'No user ID provided', code: 'no_uid' }
  }

  const timeout = (ms) => new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Firestore timeout')), ms)
  )

  try {
    // Try to read the user's profile document with a 5s timeout
    const userDocRef = doc(db, 'users', uid)
    const result = await Promise.race([
      getDoc(userDocRef),
      timeout(5000),
    ])

    return { ok: true, exists: result.exists() }
  } catch (err) {
    const message = err.message || 'Unknown error'
    let code = 'unknown'

    if (message.includes('timeout')) {
      code = 'timeout'
    } else if (message.includes('permission') || message.includes('PERMISSION_DENIED')) {
      code = 'permission_denied'
    } else if (message.includes('not-found') || message.includes('NOT_FOUND')) {
      code = 'project_not_found'
    } else if (message.includes('unavailable') || message.includes('UNAVAILABLE')) {
      code = 'unavailable'
    } else if (message.includes('network') || message.includes('Failed to fetch')) {
      code = 'network_error'
    }

    return { ok: false, error: message, code }
  }
}
