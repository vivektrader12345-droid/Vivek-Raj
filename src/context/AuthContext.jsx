/**
 * AuthContext - Firebase Authentication + Firestore User Data
 * 
 * Features:
 * - Email/Password signup/login with email OTP verification
 * - Google Sign-In
 * - Per-user Firestore data (users/{uid}/)
 * - Auto-creates default data structure on signup
 * - Session persistence (user stays logged in)
 * - Clears all data from memory on logout
 * - blockAutoLogin flag for OTP flow
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

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [userSettings, setUserSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [needsVerification, setNeedsVerification] = useState(false)
  const [verificationEmail, setVerificationEmail] = useState('')
  const [blockAutoLogin, setBlockAutoLogin] = useState(false)

  // Listen to Firebase auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      // If OTP flow is active, don't auto-login
      if (blockAutoLogin) {
        setLoading(false)
        return
      }

      if (firebaseUser) {
        const isGoogleUser = firebaseUser.providerData.some(p => p.providerId === 'google.com')

        // Load user profile from Firestore
        const profile = await getProfile(firebaseUser.uid)

        if (profile) {
          // Check verification (Google users always verified)
          const isVerified = isGoogleUser || firebaseUser.emailVerified || profile.emailVerified === true

          if (!isVerified) {
            setNeedsVerification(true)
            setVerificationEmail(firebaseUser.email)
            setUser(null)
            setLoading(false)
            return
          }

          // Load settings
          const settings = await getSettings(firebaseUser.uid)
          setUserSettings(settings)
          setNeedsVerification(false)
          setVerificationEmail('')
          setUser({
            id: firebaseUser.uid,
            uid: firebaseUser.uid,
            emailVerified: true,
            ...profile,
          })
        } else {
          // New user (Google sign-in first time) — create default data
          const defaultProfile = {
            fullName: firebaseUser.displayName || firebaseUser.email.split('@')[0],
            email: firebaseUser.email,
            avatar: (firebaseUser.displayName || firebaseUser.email || 'U').charAt(0).toUpperCase(),
            photoURL: firebaseUser.photoURL || null,
            emailVerified: isGoogleUser || firebaseUser.emailVerified,
          }

          await createDefaultUserData(firebaseUser.uid, defaultProfile)
          const settings = await getSettings(firebaseUser.uid)
          setUserSettings(settings)

          if (!isGoogleUser && !firebaseUser.emailVerified) {
            setNeedsVerification(true)
            setVerificationEmail(firebaseUser.email)
            setUser(null)
          } else {
            setNeedsVerification(false)
            setUser({ id: firebaseUser.uid, uid: firebaseUser.uid, emailVerified: true, ...defaultProfile })
          }
        }
      } else {
        // User signed out — clear everything
        setUser(null)
        setUserSettings(null)
        setNeedsVerification(false)
        setVerificationEmail('')
      }
      setLoading(false)
    })
    return () => unsubscribe()
  }, [blockAutoLogin])

  // ==================== AUTH ACTIONS ====================

  // Sign up with Email & Password
  const signup = async (fullName, email, password) => {
    const credential = await createUserWithEmailAndPassword(auth, email, password)
    await updateProfile(credential.user, { displayName: fullName })

    // Send email verification
    await sendEmailVerification(credential.user)

    // Create default Firestore data structure
    const profile = {
      fullName,
      email,
      avatar: fullName.charAt(0).toUpperCase(),
      photoURL: null,
      emailVerified: false,
    }
    await createDefaultUserData(credential.user.uid, profile)

    // Don't set user — need OTP verification first
    setNeedsVerification(true)
    setVerificationEmail(email)
    return { needsVerification: true, email }
  }

  // Login with Email & Password
  const login = async (email, password) => {
    const credential = await signInWithEmailAndPassword(auth, email, password)
    const profile = await getProfile(credential.user.uid)
    const isVerified = credential.user.emailVerified || (profile && profile.emailVerified === true)

    if (!isVerified) {
      setNeedsVerification(true)
      setVerificationEmail(email)
      throw new Error('Email not verified. Please verify your email first.')
    }

    const settings = await getSettings(credential.user.uid)
    setUserSettings(settings)
    const userData = { id: credential.user.uid, uid: credential.user.uid, emailVerified: true, ...profile }
    setUser(userData)
    return userData
  }

  // Verify credentials only (for OTP flow — no user state change)
  const verifyCredentials = async (email, password) => {
    setBlockAutoLogin(true)
    try {
      const credential = await signInWithEmailAndPassword(auth, email, password)
      await signOut(auth)
      return { success: true, uid: credential.user.uid }
    } catch (err) {
      setBlockAutoLogin(false)
      throw err
    }
  }

  // Complete login after OTP verification
  const completeLogin = async (email, password) => {
    setBlockAutoLogin(false)
    const credential = await signInWithEmailAndPassword(auth, email, password)
    const profile = await getProfile(credential.user.uid)
    const settings = await getSettings(credential.user.uid)
    setUserSettings(settings)
    const userData = { id: credential.user.uid, uid: credential.user.uid, emailVerified: true, ...profile }
    setUser(userData)
    return userData
  }

  // Google Sign-In
  const signInWithGoogle = async () => {
    const result = await signInWithPopup(auth, googleProvider)
    const firebaseUser = result.user
    let profile = await getProfile(firebaseUser.uid)

    if (!profile) {
      // New Google user — create default data
      profile = {
        fullName: firebaseUser.displayName || firebaseUser.email.split('@')[0],
        email: firebaseUser.email,
        avatar: (firebaseUser.displayName || 'U').charAt(0).toUpperCase(),
        photoURL: firebaseUser.photoURL || null,
        emailVerified: true,
      }
      await createDefaultUserData(firebaseUser.uid, profile)
    }

    const settings = await getSettings(firebaseUser.uid)
    setUserSettings(settings)
    const userData = { id: firebaseUser.uid, uid: firebaseUser.uid, emailVerified: true, ...profile }
    setUser(userData)
    return userData
  }

  // Logout — clears all user data from memory
  const logout = async () => {
    setBlockAutoLogin(false)
    await signOut(auth)
    setUser(null)
    setUserSettings(null)
    setNeedsVerification(false)
    setVerificationEmail('')
  }

  // Update profile in Firestore
  const updateUserProfile = async (updates) => {
    if (!user) return
    await updateProfileFS(user.uid, updates)
    setUser(prev => ({ ...prev, ...updates }))
  }

  // Update settings in Firestore
  const updateUserSettings = async (settings) => {
    if (!user) return
    await updateSettingsFS(user.uid, settings)
    setUserSettings(prev => ({ ...prev, ...settings }))
  }

  // Change password (send reset email)
  const changePassword = async () => {
    if (!user) return
    await sendPasswordResetEmail(auth, user.email)
  }

  // Resend email verification
  const resendVerification = async () => {
    const currentUser = auth.currentUser
    if (currentUser && !currentUser.emailVerified) {
      await sendEmailVerification(currentUser)
    }
  }

  // Check if email has been verified
  const checkVerification = async () => {
    const currentUser = auth.currentUser
    if (!currentUser) return false
    await currentUser.reload()
    if (currentUser.emailVerified) {
      setNeedsVerification(false)
      const profile = await getProfile(currentUser.uid)
      const settings = await getSettings(currentUser.uid)
      setUserSettings(settings)
      if (profile) {
        setUser({ id: currentUser.uid, uid: currentUser.uid, emailVerified: true, ...profile })
      }
      return true
    }
    return false
  }

  // Loading screen
  if (loading) {
    return (
      <div className="min-h-screen bg-[#060612] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-2 border-[#e94560] border-t-transparent rounded-full animate-spin" />
          <span className="text-gray-400 text-sm">Loading...</span>
        </div>
      </div>
    )
  }

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
