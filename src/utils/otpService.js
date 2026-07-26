/**
 * OTP Service - Generate, Store, Send, and Verify OTP
 * Uses Firestore for storage and EmailJS for sending
 * 
 * SETUP REQUIRED:
 * 1. Go to https://www.emailjs.com/ and create free account
 * 2. Add Gmail service (Service ID)
 * 3. Create email template with variable {{otp_code}} and {{to_email}}
 * 4. Get your Public Key from Account > API Keys
 * 5. Update the constants below
 */
import emailjs from '@emailjs/browser'
import { doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore'
import { db } from '../firebase'

// ===== EmailJS Configuration =====
const EMAILJS_SERVICE_ID = 'service_4apc1d3'
const EMAILJS_TEMPLATE_ID = 'template_g0hzyb8'
const EMAILJS_PUBLIC_KEY = 'peOsrkEm9pZzfIGH5'

// Initialize EmailJS
emailjs.init(EMAILJS_PUBLIC_KEY)

// OTP Settings
const OTP_LENGTH = 6
const OTP_EXPIRY_MINUTES = 5

/**
 * Generate a random 6-digit OTP
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

/**
 * Send OTP to email and store in Firestore
 * @param {string} email - User's email
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function sendOTP(email) {
  try {
    const otp = generateOTP()
    const expiresAt = Date.now() + (OTP_EXPIRY_MINUTES * 60 * 1000)

    // Store OTP in Firestore
    await setDoc(doc(db, 'otps', email.toLowerCase()), {
      code: otp,
      email: email.toLowerCase(),
      expiresAt,
      attempts: 0,
      createdAt: Date.now(),
    })

    // Send email via EmailJS
    // Variables must match EmailJS template: {{email}}, {{otp_code}}, {{expiry_minutes}}, {{app_name}}
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      email: email,
      otp_code: otp,
      app_name: 'Vivek Marco Trader',
      expiry_minutes: OTP_EXPIRY_MINUTES.toString(),
    }, EMAILJS_PUBLIC_KEY)

    return { success: true, message: 'OTP sent successfully' }
  } catch (error) {
    console.error('Send OTP error:', error)
    // Show more detail for debugging
    const errMsg = error?.text || error?.message || JSON.stringify(error) || 'Failed to send OTP'
    return { success: false, message: errMsg }
  }
}

/**
 * Verify OTP entered by user
 * @param {string} email
 * @param {string} code - 6-digit OTP entered by user
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function verifyOTP(email, code) {
  try {
    const otpDoc = await getDoc(doc(db, 'otps', email.toLowerCase()))

    if (!otpDoc.exists()) {
      return { success: false, message: 'No OTP found. Please request a new one.' }
    }

    const otpData = otpDoc.data()

    // Check expiry
    if (Date.now() > otpData.expiresAt) {
      await deleteDoc(doc(db, 'otps', email.toLowerCase()))
      return { success: false, message: 'OTP expired. Please request a new one.' }
    }

    // Check max attempts (prevent brute force)
    if (otpData.attempts >= 5) {
      await deleteDoc(doc(db, 'otps', email.toLowerCase()))
      return { success: false, message: 'Too many attempts. Please request a new OTP.' }
    }

    // Verify code
    if (otpData.code !== code) {
      // Increment attempts
      await setDoc(doc(db, 'otps', email.toLowerCase()), {
        ...otpData,
        attempts: otpData.attempts + 1,
      })
      return { success: false, message: 'Invalid OTP. Please try again.' }
    }

    // OTP verified - delete OTP doc and mark user as verified in Firestore
    await deleteDoc(doc(db, 'otps', email.toLowerCase()))
    
    // Mark user as email verified in Firestore (without triggering auth state change)
    const { getAuth } = await import('firebase/auth')
    const authInstance = getAuth()
    const currentUser = authInstance.currentUser
    if (currentUser) {
      await setDoc(doc(db, 'users', currentUser.uid), { emailVerified: true }, { merge: true })
    }

    return { success: true, message: 'Email verified successfully' }
  } catch (error) {
    console.error('Verify OTP error:', error)
    return { success: false, message: 'Verification failed. Please try again.' }
  }
}
