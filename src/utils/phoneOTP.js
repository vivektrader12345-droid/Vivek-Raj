/**
 * Phone OTP Service - Firebase Phone Authentication
 * Sends SMS OTP to phone number and verifies it
 * 
 * SETUP: Firebase Console → Authentication → Sign-in method → Phone → Enable
 */
import { RecaptchaVerifier, signInWithPhoneNumber } from 'firebase/auth'
import { auth } from '../firebase'

let confirmationResult = null
let recaptchaVerifier = null
let recaptchaRendered = false

/**
 * Setup invisible reCAPTCHA (required by Firebase Phone Auth)
 * Call this once before sending OTP
 */
export function setupRecaptcha(buttonId = 'recaptcha-container') {
  // Don't re-render if already done
  if (recaptchaRendered && recaptchaVerifier) {
    return recaptchaVerifier
  }

  // Clear old one if exists
  if (recaptchaVerifier) {
    try { recaptchaVerifier.clear() } catch {}
    recaptchaVerifier = null
    recaptchaRendered = false
  }

  // Make sure container exists and is empty
  const container = document.getElementById(buttonId)
  if (container) {
    container.innerHTML = ''
  }

  recaptchaVerifier = new RecaptchaVerifier(auth, buttonId, {
    size: 'invisible',
    callback: () => {},
    'expired-callback': () => {
      recaptchaRendered = false
    },
  })

  recaptchaRendered = true
  return recaptchaVerifier
}

/**
 * Send OTP to phone number
 * @param {string} phoneNumber - Format: +91XXXXXXXXXX (with country code)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function sendPhoneOTP(phoneNumber) {
  try {
    // Ensure recaptcha is setup
    if (!recaptchaVerifier || !recaptchaRendered) {
      setupRecaptcha('recaptcha-container')
    }

    // Send OTP
    confirmationResult = await signInWithPhoneNumber(auth, phoneNumber, recaptchaVerifier)
    return { success: true, message: 'OTP sent to ' + phoneNumber }
  } catch (error) {
    console.error('Phone OTP error:', error)
    // Reset recaptcha on error so it can be re-created
    recaptchaRendered = false
    try { if (recaptchaVerifier) recaptchaVerifier.clear() } catch {}
    recaptchaVerifier = null

    if (error.code === 'auth/invalid-phone-number') {
      return { success: false, message: 'Invalid phone number. Use format: +91XXXXXXXXXX' }
    } else if (error.code === 'auth/too-many-requests') {
      return { success: false, message: 'Too many attempts. Try again later.' }
    } else if (error.code === 'auth/captcha-check-failed') {
      return { success: false, message: 'reCAPTCHA failed. Please refresh and try again.' }
    } else if (error.code === 'auth/operation-not-allowed') {
      return { success: false, message: 'Phone auth not enabled or Blaze plan required for real SMS.' }
    }
    return { success: false, message: error.message || 'Failed to send OTP' }
  }
}

/**
 * Verify the OTP code entered by user
 * @param {string} code - 6-digit OTP
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function verifyPhoneOTP(code) {
  try {
    if (!confirmationResult) {
      return { success: false, message: 'No OTP request found. Please resend.' }
    }

    await confirmationResult.confirm(code)
    confirmationResult = null
    return { success: true, message: 'Phone verified successfully' }
  } catch (error) {
    console.error('Phone verify error:', error)
    if (error.code === 'auth/invalid-verification-code') {
      return { success: false, message: 'Invalid OTP. Please try again.' }
    } else if (error.code === 'auth/code-expired') {
      return { success: false, message: 'OTP expired. Please resend.' }
    }
    return { success: false, message: error.message || 'Verification failed' }
  }
}

/**
 * Clean up recaptcha
 */
export function cleanupRecaptcha() {
  if (recaptchaVerifier) {
    try { recaptchaVerifier.clear() } catch {}
    recaptchaVerifier = null
  }
  recaptchaRendered = false
  confirmationResult = null
}
