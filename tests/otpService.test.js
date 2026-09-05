import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_SAFE_RETRY_AFTER,
  normalizeOtpResponse,
} from '../src/utils/otpResponse.js'

const SAFE_CODES = [
  'otp_email_configuration',
  'otp_email_authentication',
  'otp_email_template',
  'otp_email_request_contract',
  'otp_email_recipient',
  'otp_email_rate_limit',
  'otp_email_network',
  'otp_email_provider_unavailable',
  'otp_email_operation_failed',
]

test('OTP transport preserves each allowlisted diagnostic without changing the message', () => {
  for (const diagnosticCode of SAFE_CODES) {
    const normalized = normalizeOtpResponse({
      success: false,
      message: 'Unable to send OTP. Please try again later.',
      diagnosticCode,
    }, false)

    assert.equal(normalized.diagnosticCode, diagnosticCode)
    assert.equal(normalized.message, 'Unable to send OTP. Please try again later.')
    assert.equal(normalized.success, false)
  }
})

test('OTP transport drops unknown diagnostics and unsafe retry guidance', () => {
  const unsafeValues = [0, -1, 1.5, MAX_SAFE_RETRY_AFTER + 1, '17', null]
  for (const retryAfter of unsafeValues) {
    const normalized = normalizeOtpResponse({
      diagnosticCode: 'provider-secret-detail',
      retryAfter,
    }, false)

    assert.equal('diagnosticCode' in normalized, false)
    assert.equal('retryAfter' in normalized, false)
  }
})

test('OTP transport preserves bounded integer retry guidance and existing success fields', () => {
  const normalized = normalizeOtpResponse({
    success: true,
    message: 'OTP sent successfully',
    refreshToken: true,
    retryAfter: MAX_SAFE_RETRY_AFTER,
  }, true)

  assert.deepEqual(normalized, {
    success: true,
    message: 'OTP sent successfully',
    refreshToken: true,
    retryAfter: MAX_SAFE_RETRY_AFTER,
  })
})

test('OTP transport preserves only an authenticated boolean OTP decision', () => {
  assert.equal(normalizeOtpResponse({ success: true, otpRequired: false }, true).otpRequired, false)
  for (const value of ['false', null, 0, undefined]) {
    const normalized = normalizeOtpResponse({ success: true, otpRequired: value }, true)
    assert.equal('otpRequired' in normalized, false)
  }
  assert.equal('otpRequired' in normalizeOtpResponse({ success: true, otpRequired: false }, false), false)
})
