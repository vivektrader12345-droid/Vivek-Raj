/**
 * AuthContext - Firebase Authentication + Firestore User Data
 *
 * Email/password sessions require a server-issued OTP claim for the current
 * Firebase auth_time. Google sessions retain their existing behavior.
 */
import React, { createContext, useContext, useState, useEffect } from 'react'
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail,
  sendEmailVerification,
} from 'firebase/auth'
import { auth, googleProvider } from '../firebase'
import {
  getProfile,
  getSettings,
  createDefaultUserData,
  updateProfile as updateProfileFS,
  updateSettings as updateSettingsFS,
} from '../services/firestoreService'

const AuthContext = createContext(null)

function LoadingScreen() {
  const [showHelp, setShowHelp] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setShowHelp(true), 5000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="min-h-screen bg-[#060612] flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-2 border-[#e94560] border-t-transparent rounded-full animate-spin" />
        <span className="text-gray-400 text-sm">Loading...</span>
        {showHelp && (
          <div className="mt-4 text-center max-w-xs">
            <p className="text-yellow-400 text-xs">Taking longer than expected...</p>
            <p className="text-gray-500 text-xs mt-1">
              Check your internet connection or try refreshing the page.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function isGoogleSession(tokenResult) {
  return tokenResult.claims.firebase?.sign_in_provider === 'google.com'
}

function hasCurrentOtpProof(tokenResult) {
  const authTime = Number(tokenResult.claims.auth_time || 0)
  const verifiedAuthTime = Number(tokenResult.claims.otp_auth_time || 0)
  return authTime > 0 && verifiedAuthTime === authTime
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [userSettings, setUserSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [needsVerification, setNeedsVerification] = useState(false)
  const [verificationEmail, setVerificationEmail] = useState('')

  const hydrateUser = async (firebaseUser, profileOverrides = {}) => {
    let profile = await getProfile(firebaseUser.uid)
    if (!profile) {
      const name = profileOverrides.fullName || firebaseUser.displayName || firebaseUser.email.split('@')[0]
      profile = {
        fullName: name,
        email: firebaseUser.email,
        avatar: (name || 'U').charAt(0).toUpperCase(),
        photoURL: firebaseUser.photoURL || null,
        emailVerified: true,
      }
      await createDefaultUserData(firebaseUser.uid, profile)
    } else if (profile.emailVerified !== true) {
      await updateProfileFS(firebaseUser.uid, { emailVerified: true })
      profile = { ...profile, emailVerified: true }
    }

    const settings = await getSettings(firebaseUser.uid)
    const userData = {
      ...profile,
      id: firebaseUser.uid,
      uid: firebaseUser.uid,
      emailVerified: true,
    }
    setUserSettings(settings)
    setNeedsVerification(false)
    setVerificationEmail('')
    setUser(userData)
    return userData
  }

  useEffect(() => {
    const safetyTimer = setTimeout(() => setLoading(false), 8000)

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      clearTimeout(safetyTimer)
      try {
        if (!firebaseUser) {
          setUser(null)
          setUserSettings(null)
          setNeedsVerification(false)
          setVerificationEmail('')
          return
        }

        const tokenResult = await firebaseUser.getIdTokenResult()
        if (!isGoogleSession(tokenResult) && !hasCurrentOtpProof(tokenResult)) {
          setUser(null)
          setUserSettings(null)
          setNeedsVerification(true)
          setVerificationEmail(firebaseUser.email || '')
          return
        }

        await hydrateUser(firebaseUser)
      } catch (err) {
        console.error('Auth state error:', err)
        setUser(null)
        setUserSettings(null)
      } finally {
        setLoading(false)
      }
    })

    return () => {
      clearTimeout(safetyTimer)
      unsubscribe()
    }
  }, [])

  const signup = async (fullName, email, password) => {
    const credential = await createUserWithEmailAndPassword(auth, email, password)
    await updateProfile(credential.user, { displayName: fullName })
    await sendEmailVerification(credential.user)
    setNeedsVerification(true)
    setVerificationEmail(email)
    return { needsVerification: true, email }
  }

  const verifyCredentials = async (email, password) => {
    const credential = await signInWithEmailAndPassword(auth, email, password)
    setUser(null)
    setUserSettings(null)
    setNeedsVerification(true)
    setVerificationEmail(email)
    return { success: true, uid: credential.user.uid }
  }

  const completeLogin = async (profileOverrides = {}) => {
    const firebaseUser = auth.currentUser
    if (!firebaseUser) throw new Error('Sign-in session expired. Please sign in again.')

    const tokenResult = await firebaseUser.getIdTokenResult()
    if (!isGoogleSession(tokenResult) && !hasCurrentOtpProof(tokenResult)) {
      throw new Error('OTP verification is required for this sign-in session.')
    }
    return hydrateUser(firebaseUser, profileOverrides)
  }

  const login = async (email, password) => verifyCredentials(email, password)

  const signInWithGoogle = async () => {
    const result = await signInWithPopup(auth, googleProvider)
    return hydrateUser(result.user)
  }

  const logout = async () => {
    await signOut(auth)
    setUser(null)
    setUserSettings(null)
    setNeedsVerification(false)
    setVerificationEmail('')
  }

  const updateUserProfile = async (updates) => {
    if (!user) return
    await updateProfileFS(user.uid, updates)
    setUser(previous => ({ ...previous, ...updates }))
  }

  const updateUserSettings = async (settings) => {
    if (!user) return
    await updateSettingsFS(user.uid, settings)
    setUserSettings(previous => ({ ...previous, ...settings }))
  }

  const changePassword = async () => {
    if (!user) return
    await sendPasswordResetEmail(auth, user.email)
  }

  const resendVerification = async () => {
    const currentUser = auth.currentUser
    if (currentUser && !currentUser.emailVerified) {
      await sendEmailVerification(currentUser)
    }
  }

  const checkVerification = async () => {
    const currentUser = auth.currentUser
    if (!currentUser) return false
    await currentUser.reload()
    const tokenResult = await currentUser.getIdTokenResult(true)
    if (!isGoogleSession(tokenResult) && !hasCurrentOtpProof(tokenResult)) return false
    await hydrateUser(currentUser)
    return true
  }

  if (loading) return <LoadingScreen />

  return (
    <AuthContext.Provider value={{
      user,
      userSettings,
      needsVerification,
      verificationEmail,
      signup,
      login,
      verifyCredentials,
      completeLogin,
      signInWithGoogle,
      logout,
      updateProfile: updateUserProfile,
      updateSettings: updateUserSettings,
      changePassword,
      resendVerification,
      checkVerification,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
