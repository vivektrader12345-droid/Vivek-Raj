import { auth } from '../firebase'

const API_ORIGIN = (
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_WEBHOOK_API_URL ||
  'http://localhost:5000'
).replace(/\/+$/, '')

async function otpRequest(path, payload) {
  const currentUser = auth.currentUser
  if (!currentUser) {
    return { success: false, message: 'Your sign-in session expired. Please sign in again.' }
  }

  try {
    const token = await currentUser.getIdToken()
    const response = await fetch(`${API_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const result = await response.json().catch(() => ({}))
    return {
      success: response.ok && result.success === true,
      message: result.message || (response.ok ? 'Request completed' : 'OTP request failed'),
      refreshToken: result.refreshToken === true,
      retryAfter: result.retryAfter,
    }
  } catch (error) {
    console.error('OTP service error:', error)
    return { success: false, message: 'OTP service is unavailable. Please try again.' }
  }
}

/** Request a server-generated OTP for the currently authenticated Firebase user. */
export async function sendOTP(email) {
  return otpRequest('/api/auth/otp/send', { email: email.trim().toLowerCase() })
}

/** Verify an OTP on the server and refresh the Firebase token containing its proof. */
export async function verifyOTP(email, code) {
  const result = await otpRequest('/api/auth/otp/verify', {
    email: email.trim().toLowerCase(),
    code,
  })
  if (result.success && result.refreshToken && auth.currentUser) {
    await auth.currentUser.getIdToken(true)
  }
  return result
}
