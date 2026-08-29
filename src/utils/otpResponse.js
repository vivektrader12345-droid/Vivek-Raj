const SAFE_DIAGNOSTIC_CODES = new Set([
  'otp_email_configuration',
  'otp_email_authentication',
  'otp_email_template',
  'otp_email_request_contract',
  'otp_email_recipient',
  'otp_email_rate_limit',
  'otp_email_network',
  'otp_email_provider_unavailable',
  'otp_email_operation_failed',
])

export const MAX_SAFE_RETRY_AFTER = 60 * 60

export function normalizeOtpResponse(result, responseOk) {
  const normalized = {
    success: responseOk && result.success === true,
    message: result.message || (responseOk ? 'Request completed' : 'OTP request failed'),
    refreshToken: result.refreshToken === true,
  }
  if (SAFE_DIAGNOSTIC_CODES.has(result.diagnosticCode)) {
    normalized.diagnosticCode = result.diagnosticCode
  }
  if (
    Number.isInteger(result.retryAfter)
    && result.retryAfter > 0
    && result.retryAfter <= MAX_SAFE_RETRY_AFTER
  ) {
    normalized.retryAfter = result.retryAfter
  }
  return normalized
}
