/**
 * OTPInput - 6-digit OTP input boxes
 * Professional TradingView-style with auto-focus and paste support
 */
import React, { useState, useRef, useEffect } from 'react'

function OTPInput({ length = 6, onComplete, disabled = false }) {
  const [otp, setOtp] = useState(new Array(length).fill(''))
  const inputRefs = useRef([])

  useEffect(() => {
    // Focus first input on mount
    if (inputRefs.current[0]) inputRefs.current[0].focus()
  }, [])

  const handleChange = (value, index) => {
    if (disabled) return
    // Only allow numbers
    const val = value.replace(/[^0-9]/g, '')
    if (!val && value) return

    const newOtp = [...otp]
    newOtp[index] = val.slice(-1) // Only take last digit

    setOtp(newOtp)

    // Auto-focus next input
    if (val && index < length - 1) {
      inputRefs.current[index + 1]?.focus()
    }

    // Check if OTP is complete
    const fullOtp = newOtp.join('')
    if (fullOtp.length === length) {
      onComplete?.(fullOtp)
    }
  }

  const handleKeyDown = (e, index) => {
    if (disabled) return
    // Backspace - go to previous input
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
      const newOtp = [...otp]
      newOtp[index - 1] = ''
      setOtp(newOtp)
    }
  }

  const handlePaste = (e) => {
    if (disabled) return
    e.preventDefault()
    const pastedData = e.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, length)
    if (!pastedData) return

    const newOtp = [...otp]
    for (let i = 0; i < pastedData.length; i++) {
      newOtp[i] = pastedData[i]
    }
    setOtp(newOtp)

    // Focus last filled input or next empty
    const focusIdx = Math.min(pastedData.length, length - 1)
    inputRefs.current[focusIdx]?.focus()

    // Check if complete
    if (pastedData.length === length) {
      onComplete?.(pastedData)
    }
  }

  return (
    <div className="flex items-center justify-center gap-2">
      {otp.map((digit, index) => (
        <input
          key={index}
          ref={(el) => inputRefs.current[index] = el}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={digit}
          onChange={(e) => handleChange(e.target.value, index)}
          onKeyDown={(e) => handleKeyDown(e, index)}
          onPaste={handlePaste}
          disabled={disabled}
          className={`w-11 h-13 text-center text-xl font-bold rounded-xl border-2 bg-[#12122a] text-white
            focus:outline-none transition-all duration-200
            ${digit ? 'border-[#e94560] shadow-[0_0_10px_rgba(233,69,96,0.2)]' : 'border-[#2a2a5a]'}
            ${disabled ? 'opacity-50 cursor-not-allowed' : 'focus:border-[#e94560] hover:border-[#3a3a7a]'}
          `}
          style={{ height: '52px' }}
        />
      ))}
    </div>
  )
}

export default OTPInput
