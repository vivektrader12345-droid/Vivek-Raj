/**
 * PhoneOTPVerify - Phone number input + OTP verification component
 * Used in both Signup and Login flows
 */
import React, { useState, useEffect } from 'react'
import OTPInput from './OTPInput'
import { sendPhoneOTP, verifyPhoneOTP, cleanupRecaptcha } from '../utils/phoneOTP'

function PhoneOTPVerify({ onVerified, onBack, title = 'Verify Phone Number' }) {
  const [phone, setPhone] = useState('+91')
  const [otpSent, setOtpSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  const [countdown, setCountdown] = useState(0)

  // Cleanup recaptcha on unmount
  useEffect(() => {
    return () => cleanupRecaptcha()
  }, [])

  // Countdown timer for resend
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(c => c - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  // Send OTP
  const handleSendOTP = async () => {
    setError('')
    if (phone.length < 10) {
      setError('Enter a valid phone number with country code (e.g. +91XXXXXXXXXX)')
      return
    }
    setSending(true)
    const result = await sendPhoneOTP(phone)
    setSending(false)
    if (result.success) {
      setOtpSent(true)
      setCountdown(60)
    } else {
      setError(result.message)
    }
  }

  // Verify OTP
  const handleVerify = async (code) => {
    setError('')
    setVerifying(true)
    const result = await verifyPhoneOTP(code)
    setVerifying(false)
    if (result.success) {
      onVerified?.(phone)
    } else {
      setError(result.message)
    }
  }

  // Resend
  const handleResend = async () => {
    setError('')
    cleanupRecaptcha()
    setSending(true)
    const result = await sendPhoneOTP(phone)
    setSending(false)
    if (result.success) {
      setCountdown(60)
    } else {
      setError(result.message)
    }
  }

  return (
    <div className="min-h-screen bg-[#060612] flex items-center justify-center p-4">
      <div className="glass-card p-8 w-full max-w-md text-center">
        <div className="text-5xl mb-4">📱</div>
        <h2 className="text-xl font-bold text-white mb-2">{title}</h2>

        {!otpSent ? (
          <>
            <p className="text-gray-400 text-sm mb-6">
              Enter your phone number to receive a verification code via SMS
            </p>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-3 py-2 rounded-lg mb-4 text-xs">
                {error}
              </div>
            )}

            <div className="mb-4">
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91XXXXXXXXXX"
                className="w-full px-4 py-3 rounded-xl bg-[#12122a] border border-[#2a2a5a] text-white text-sm focus:border-[#e94560] focus:outline-none placeholder-gray-500 text-center text-lg tracking-wider"
                autoFocus
              />
              <p className="text-gray-500 text-[10px] mt-1.5">Include country code (e.g. +91 for India)</p>
            </div>

            <button
              onClick={handleSendOTP}
              disabled={sending || phone.length < 10}
              className="w-full py-3 rounded-xl bg-[#e94560] hover:bg-[#d63851] text-white font-medium text-sm transition-all disabled:opacity-50 mb-3"
            >
              {sending ? 'Sending OTP...' : 'Send OTP'}
            </button>
          </>
        ) : (
          <>
            <p className="text-gray-400 text-sm mb-1">We've sent an SMS code to:</p>
            <p className="text-white font-medium mb-6">{phone}</p>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-3 py-2 rounded-lg mb-4 text-xs">
                {error}
              </div>
            )}

            <div className="mb-6">
              <OTPInput length={6} disabled={verifying} onComplete={handleVerify} />
            </div>

            {verifying && (
              <div className="flex items-center justify-center gap-2 mb-4">
                <svg className="animate-spin h-4 w-4 text-[#e94560]" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="text-gray-400 text-sm">Verifying...</span>
              </div>
            )}

            <button
              onClick={handleResend}
              disabled={countdown > 0 || sending}
              className="w-full py-2 text-gray-400 hover:text-white text-sm transition-all mb-3 disabled:opacity-40"
            >
              {countdown > 0 ? `Resend OTP in ${countdown}s` : 'Resend OTP'}
            </button>

            <button
              onClick={() => { setOtpSent(false); setError('') }}
              className="text-gray-500 text-sm hover:text-white transition-all"
            >
              Change Number
            </button>
          </>
        )}

        {onBack && (
          <button onClick={onBack} className="block mx-auto mt-4 text-[#e94560] text-sm hover:underline">
            Back
          </button>
        )}

        {/* Invisible reCAPTCHA container */}
        <div id="recaptcha-container"></div>
      </div>
    </div>
  )
}

export default PhoneOTPVerify
