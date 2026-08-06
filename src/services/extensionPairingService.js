import { auth } from '../firebase'
import { createFirebaseAuthenticatedFetch } from './firebaseAuthenticatedFetch'

const API_ORIGIN = (
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_WEBHOOK_API_URL ||
  'http://localhost:5000'
).replace(/\/+$/, '')

const authenticatedFetch = createFirebaseAuthenticatedFetch({ auth })

export async function createExtensionPairingCode() {
  const response = await authenticatedFetch(`${API_ORIGIN}/api/auth/extension/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.success !== true || !result.pairingCode) {
    throw new Error(result.message || 'Unable to create an extension pairing code')
  }
  return {
    pairingCode: result.pairingCode,
    expiresIn: Number(result.expiresIn) || 300,
  }
}
