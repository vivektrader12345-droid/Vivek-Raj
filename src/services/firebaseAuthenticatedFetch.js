const DEFAULT_TIMEOUT_MS = 15000
const REAUTHENTICATION_CODES = new Set([
  'authentication_required',
  'invalid_token',
  'token_revoked',
  'user_disabled',
  'reauthentication_required',
])
const DEFINITIVE_SIGN_OUT_CODES = new Set(['token_revoked', 'user_disabled'])

export function shouldSignOutForAuthenticationError(code) {
  return DEFINITIVE_SIGN_OUT_CODES.has(code)
}

function isRefreshableExpiration(code, payload) {
  if (code === 'token_expired') return true

  // Rollout compatibility for the previous backend, which collapsed expired
  // and invalid tokens into this exact generic response. This still receives
  // the same one-refresh/one-replay cap as the precise token_expired code.
  const message = String(payload?.error?.message || '').toLowerCase()
  return code === 'invalid_token' && message.includes('invalid or expired')
}

export class AuthenticatedFetchError extends Error {
  constructor(message, {
    code = 'request_failed',
    status = 0,
    details = null,
    requestId = null,
    payload = null,
    cause = null,
  } = {}) {
    super(message)
    this.name = 'AuthenticatedFetchError'
    this.code = code
    this.status = status
    this.details = details
    this.requestId = requestId
    this.payload = payload
    this.cause = cause
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      details: this.details,
      requestId: this.requestId,
    }
  }
}

function normalizedTimeout(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

function sameUser(auth, user, uid) {
  return auth.currentUser === user && auth.currentUser?.uid === uid
}

async function readErrorPayload(response) {
  try {
    return await response.clone().json()
  } catch {
    return null
  }
}

function responseError(response, payload, fallbackCode = 'reauthentication_required') {
  const serverError = payload?.error
  const code = typeof serverError?.code === 'string' && serverError.code
    ? serverError.code
    : fallbackCode

  return new AuthenticatedFetchError(
    serverError?.message || 'Your session is no longer valid. Sign in again.',
    {
      code,
      status: response.status,
      details: serverError?.details ?? null,
      requestId: payload?.requestId ?? response.headers.get('x-request-id'),
      payload,
    },
  )
}

export function createFirebaseAuthenticatedFetch({
  auth,
  fetchImpl = globalThis.fetch,
  reauthenticate = async () => {},
} = {}) {
  if (!auth) throw new TypeError('auth is required')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (typeof reauthenticate !== 'function') {
    throw new TypeError('reauthenticate must be a function')
  }

  const reauthenticationByUser = new WeakMap()

  async function reauthenticateOnce(user, code) {
    let pending = reauthenticationByUser.get(user)
    if (!pending) {
      pending = Promise.resolve()
        .then(() => reauthenticate({ user, code }))
        .catch(() => undefined)
        .finally(() => {
          if (reauthenticationByUser.get(user) === pending) {
            reauthenticationByUser.delete(user)
          }
        })
      reauthenticationByUser.set(user, pending)
    }
    await pending
  }

  async function fetchAttempt(url, init, token, timeoutMs) {
    const controller = new AbortController()
    const timeout = normalizedTimeout(timeoutMs)
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeout)
    const headers = new Headers(init.headers || {})
    headers.delete('Authorization')
    headers.set('Authorization', `Bearer ${token}`)

    try {
      return await fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AuthenticatedFetchError('The request timed out.', {
          code: 'request_timeout',
          status: 408,
          cause: error,
        })
      }
      throw new AuthenticatedFetchError('Unable to reach the server.', {
        code: 'network_error',
        status: 0,
        cause: error,
      })
    } finally {
      globalThis.clearTimeout(timeoutId)
    }
  }

  return async function firebaseAuthenticatedFetch(url, init = {}, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    const user = auth.currentUser
    if (!user) {
      throw new AuthenticatedFetchError(
        'Sign in is required to access this resource.',
        { code: 'authentication_required', status: 401 },
      )
    }

    const uid = user.uid
    let token
    try {
      token = await user.getIdToken(false)
      if (!token) throw new Error('empty token')
    } catch (cause) {
      throw new AuthenticatedFetchError(
        'Unable to obtain your authentication token.',
        { code: 'token_acquisition_failed', status: 401, cause },
      )
    }

    if (!sameUser(auth, user, uid)) {
      throw new AuthenticatedFetchError(
        'Your signed-in account changed. Sign in again to continue.',
        { code: 'reauthentication_required', status: 401 },
      )
    }

    const firstResponse = await fetchAttempt(url, init, token, timeoutMs)
    if (firstResponse.status !== 401) return firstResponse

    const firstPayload = await readErrorPayload(firstResponse)
    const firstCode = firstPayload?.error?.code

    if (!isRefreshableExpiration(firstCode, firstPayload)) {
      const error = responseError(firstResponse, firstPayload)
      if (REAUTHENTICATION_CODES.has(error.code) || firstResponse.status === 401) {
        await reauthenticateOnce(user, error.code)
      }
      throw error
    }

    if (!sameUser(auth, user, uid)) {
      throw new AuthenticatedFetchError(
        'Your signed-in account changed. Sign in again to continue.',
        { code: 'reauthentication_required', status: 401 },
      )
    }

    let refreshedToken
    try {
      refreshedToken = await user.getIdToken(true)
      if (!refreshedToken) throw new Error('empty refreshed token')
    } catch (cause) {
      await reauthenticateOnce(user, 'token_refresh_failed')
      throw new AuthenticatedFetchError(
        'Unable to refresh your authentication token. Sign in again.',
        { code: 'token_refresh_failed', status: 401, cause },
      )
    }

    if (!sameUser(auth, user, uid)) {
      throw new AuthenticatedFetchError(
        'Your signed-in account changed. Sign in again to continue.',
        { code: 'reauthentication_required', status: 401 },
      )
    }

    const replayResponse = await fetchAttempt(url, init, refreshedToken, timeoutMs)
    if (replayResponse.status !== 401) return replayResponse

    const replayPayload = await readErrorPayload(replayResponse)
    const replayError = responseError(
      replayResponse,
      replayPayload,
      'reauthentication_required',
    )
    await reauthenticateOnce(user, replayError.code)
    throw new AuthenticatedFetchError(
      'Your session could not be renewed. Sign in again.',
      {
        code: 'reauthentication_required',
        status: replayResponse.status,
        details: replayError.details,
        requestId: replayError.requestId,
        payload: replayPayload,
      },
    )
  }
}
