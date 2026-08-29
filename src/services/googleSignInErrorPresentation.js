const CANCELLATION_CODES = new Set([
  'auth/cancelled-popup-request',
  'auth/popup-closed-by-user',
  'google-signin-cancelled',
])

const SAFE_ERROR_MESSAGES = Object.freeze({
  'google-signin-timeout': 'Google sign-in timed out. Please try again.',
  'google-signin-unavailable': 'Google sign-in is unavailable. Please try again later.',
  'google-signin-failed': 'Google sign-in failed. Please try again.',
})

const DEFAULT_ERROR_MESSAGE = 'Google sign-in failed. Please try again.'

export function isGoogleSignInCancellation(error) {
  return CANCELLATION_CODES.has(error?.code)
}

export function getGoogleSignInErrorMessage(error) {
  if (isGoogleSignInCancellation(error)) return null
  return SAFE_ERROR_MESSAGES[error?.code] || DEFAULT_ERROR_MESSAGE
}
