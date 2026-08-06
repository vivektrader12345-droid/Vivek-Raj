import React, { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { sendPasswordResetEmail } from 'firebase/auth'
import { auth } from '../firebase'
import { Eye, EyeOff } from 'lucide-react'
import OTPInput from '../components/OTPInput'
import PhoneOTPVerify from '../components/PhoneOTPVerify'
import { sendOTP, verifyOTP } from '../utils/otpService'

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [showForgotPassword, setShowForgotPassword] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetSent, setResetSent] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)
  // OTP Login state
  const [showOTPScreen, setShowOTPScreen] = useState(false)
  const [otpLoading, setOtpLoading] = useState(false)
  const [otpVerifying, setOtpVerifying] = useState(false)
  const [showPhoneVerify, setShowPhoneVerify] = useState(false)
  const { verifyCredentials, completeLogin, signInWithGoogle } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!email.trim() || !password) {
      setError('Please fill in all fields')
      return
    }

    setLoading(true)
    try {
      // Credentials remain authenticated while the server issues a session-bound OTP.
      await verifyCredentials(email.trim().toLowerCase(), password)
      setLoading(false)
      setOtpLoading(true)
      const otpResult = await sendOTP(email.trim().toLowerCase())
      setOtpLoading(false)
      if (otpResult.success) {
        setShowOTPScreen(true)
      } else {
        setError('Failed to send OTP: ' + otpResult.message)
      }
    } catch (err) {
      if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        setError('Invalid email or password')
      } else if (err.code === 'auth/too-many-requests') {
        setError('Too many failed attempts. Try again later.')
      } else {
        setError(err.message || 'Login failed')
      }
      setLoading(false)
      setOtpLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setError('')
    setGoogleLoading(true)
    try {
      await signInWithGoogle()
      navigate('/')
    } catch (err) {
      if (err.code !== 'auth/popup-closed-by-user') {
        setError(err.message || 'Google sign-in failed')
      }
    } finally {
      setGoogleLoading(false)
    }
  }

  // Forgot password - send reset email
  const handleForgotPassword = async (e) => {
    e.preventDefault()
    setError('')
    if (!resetEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resetEmail)) {
      setError('Please enter a valid email address')
      return
    }
    setResetLoading(true)
    try {
      await sendPasswordResetEmail(auth, resetEmail.trim().toLowerCase())
      setResetSent(true)
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        setError('No account found with this email')
      } else {
        setError(err.message || 'Failed to send reset email')
      }
    } finally {
      setResetLoading(false)
    }
  }

  // Phone verification screen (after email OTP)
  if (showPhoneVerify) {
    return (
      <PhoneOTPVerify
        title="Verify Phone Number"
        onVerified={async (phone) => {
          // Phone verified — complete login
          try {
            await completeLogin()
            navigate('/')
          } catch {
            window.location.href = '/'
          }
        }}
        onBack={() => setShowPhoneVerify(false)}
      />
    )
  }

  // OTP Verification Screen (shown after password is correct)
  if (showOTPScreen) {
    return (
      <div className="min-h-screen bg-[#060612] flex items-center justify-center p-4">
        <div className="glass-card p-8 w-full max-w-md text-center">
          <div className="text-6xl mb-4">🔐</div>
          <h2 className="text-xl font-bold text-white mb-2">Two-Factor Verification</h2>
          <p className="text-gray-400 text-sm mb-1">We've sent a 6-digit OTP code to:</p>
          <p className="text-white font-medium mb-6">{email}</p>
          <p className="text-gray-500 text-xs mb-6">
            Enter the code to complete login. Check spam/junk folder.
          </p>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-3 py-2 rounded-lg mb-4 text-xs">
              {error}
            </div>
          )}

          <div className="mb-6">
            <OTPInput
              length={6}
              disabled={otpVerifying}
              onComplete={async (code) => {
                setOtpVerifying(true)
                setError('')
                const result = await verifyOTP(email.trim().toLowerCase(), code)
                if (result.success) {
                  // Email OTP verified — complete login
                  try {
                    await completeLogin()
                    navigate('/')
                  } catch (completionError) {
                    setError(completionError.message || 'Unable to complete login. Please try again.')
                    setOtpVerifying(false)
                  }
                } else {
                  setError(result.message)
                  setOtpVerifying(false)
                }
              }}
            />
          </div>

          {otpVerifying && (
            <div className="flex items-center justify-center gap-2 mb-4">
              <svg className="animate-spin h-4 w-4 text-[#e94560]" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-gray-400 text-sm">Verifying...</span>
            </div>
          )}

          <button
            onClick={async () => {
              setError('')
              const result = await sendOTP(email.trim().toLowerCase())
              if (result.success) {
                alert('New OTP sent! Check your email.')
              } else {
                setError(result.message)
              }
            }}
            className="w-full py-2 text-gray-400 hover:text-white text-sm transition-all mb-3"
          >
            Resend OTP Code
          </button>

          <button
            onClick={() => { setShowOTPScreen(false); setError('') }}
            className="text-[#e94560] text-sm hover:underline"
          >
            Back to Login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#060612] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background Effects */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-[#e94560]/5 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-[#f5a623]/5 rounded-full blur-[100px]"></div>
      </div>

      <div className="relative glass-card p-8 w-full max-w-md animate-fadeIn">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="text-6xl mb-3">🐂</div>
          <h1 className="text-2xl font-bold gradient-text tracking-wide">Vivek Marco Trader</h1>
          <p className="text-gray-400 mt-2 text-sm">Welcome back, Trader!</p>
        </div>

        {/* Sign in with Google */}
        <button
          type="button"
          onClick={handleGoogleLogin}
          disabled={googleLoading}
          className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl border border-gray-600/30 bg-white hover:bg-gray-50 transition-all mb-4 shadow-sm disabled:opacity-60"
        >
          {googleLoading ? (
            <svg className="animate-spin h-5 w-5 text-gray-500" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
          )}
          <span className="text-gray-700 font-medium text-sm">
            {googleLoading ? 'Signing in...' : 'Sign in with Google'}
          </span>
        </button>

        {/* Divider */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex-1 h-px bg-gray-700/50"></div>
          <span className="text-gray-500 text-xs">or</span>
          <div className="flex-1 h-px bg-gray-700/50"></div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg mb-5 text-sm flex items-center gap-2">
            <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-gray-400 text-sm mb-1.5 font-medium">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
              placeholder="Enter your email"
              autoComplete="email"
            />
          </div>

          <div>
            <label className="block text-gray-400 text-sm mb-1.5 font-medium">Password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-field pr-12"
                placeholder="Enter your password"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition-colors"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 rounded bg-[#0a0a1a] border-[#0f3460] text-[#e94560] focus:ring-[#e94560]" />
              <span className="text-gray-400 text-sm">Remember me</span>
            </label>
            <button type="button" onClick={() => { setShowForgotPassword(true); setResetEmail(email); setResetSent(false) }}
              className="text-[#e94560] text-sm hover:underline">
              Forgot password?
            </button>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Logging in...
              </span>
            ) : 'Login'}
          </button>
        </form>

        <p className="text-gray-400 text-sm text-center mt-6">
          Don't have an account?{' '}
          <Link to="/signup" className="text-[#e94560] font-medium hover:underline">
            Sign Up
          </Link>
        </p>
      </div>

      {/* Forgot Password Modal */}
      {showForgotPassword && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowForgotPassword(false)}>
          <div className="bg-[#1a1a2e] border border-[#2a2a5a] rounded-2xl w-full max-w-sm shadow-2xl p-6" onClick={e => e.stopPropagation()}>
            {resetSent ? (
              /* Success state */
              <div className="text-center">
                <div className="text-5xl mb-3">📧</div>
                <h3 className="text-white font-semibold text-lg">Check your Email</h3>
                <p className="text-gray-400 text-sm mt-2">
                  We've sent a password reset link to <span className="text-white font-medium">{resetEmail}</span>
                </p>
                <p className="text-gray-500 text-xs mt-3">Check your inbox and spam folder. Click the link to reset your password.</p>
                <button
                  onClick={() => { setShowForgotPassword(false); setResetSent(false) }}
                  className="w-full mt-5 py-3 rounded-xl bg-[#e94560] hover:bg-[#d63851] text-white font-medium text-sm transition-all"
                >
                  Back to Login
                </button>
              </div>
            ) : (
              /* Email input state */
              <>
                <div className="text-center mb-5">
                  <div className="text-4xl mb-2">🔐</div>
                  <h3 className="text-white font-semibold text-lg">Forgot Password?</h3>
                  <p className="text-gray-400 text-sm mt-1">Enter your email and we'll send you a reset link</p>
                </div>

                {error && (
                  <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-3 py-2 rounded-lg mb-4 text-xs">
                    {error}
                  </div>
                )}

                <form onSubmit={handleForgotPassword}>
                  <label className="block text-gray-400 text-sm mb-1.5 font-medium">Email Address</label>
                  <input
                    type="email"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-[#12122a] border border-[#2a2a5a] text-white text-sm focus:border-[#e94560] focus:outline-none placeholder-gray-500"
                    placeholder="Enter your registered email"
                    autoFocus
                    autoComplete="email"
                  />
                  <button
                    type="submit"
                    disabled={resetLoading}
                    className="w-full mt-4 py-3 rounded-xl bg-[#e94560] hover:bg-[#d63851] text-white font-medium text-sm transition-all disabled:opacity-50"
                  >
                    {resetLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Sending...
                      </span>
                    ) : 'Send Reset Link'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowForgotPassword(false)}
                    className="w-full mt-2 py-2 text-gray-400 hover:text-white text-sm transition-all"
                  >
                    Cancel
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default Login
