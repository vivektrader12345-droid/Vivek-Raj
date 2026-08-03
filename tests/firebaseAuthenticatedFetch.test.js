import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AuthenticatedFetchError,
  createFirebaseAuthenticatedFetch,
  shouldSignOutForAuthenticationError,
} from '../src/services/firebaseAuthenticatedFetch.js'

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status, code, requestId = 'request-id', details = null) {
  return jsonResponse(status, {
    error: { code, message: code, ...(details ? { details } : {}) },
    requestId,
  })
}

function makeUser(uid = 'user-1', tokens = ['token-1']) {
  const calls = []
  const user = {
    uid,
    async getIdToken(forceRefresh) {
      calls.push(forceRefresh)
      const next = tokens[calls.length - 1]
      if (next instanceof Error) throw next
      return next
    },
  }
  return { user, calls }
}

function makeClient({ user, fetchImpl, reauthenticate = async () => {} }) {
  const auth = { currentUser: user }
  return {
    auth,
    request: createFirebaseAuthenticatedFetch({
      auth,
      fetchImpl,
      reauthenticate,
    }),
  }
}

test('valid token sends exactly one service-controlled bearer header', async () => {
  const { user, calls } = makeUser()
  const requests = []
  const { request } = makeClient({
    user,
    fetchImpl: async (_url, init) => {
      requests.push(init)
      return jsonResponse(200, { ok: true })
    },
  })

  const response = await request('https://api.example.invalid/resource', {
    headers: {
      Authorization: 'Bearer caller-controlled-value',
      'X-Test': 'preserved',
    },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(calls, [false])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer token-1')
  assert.equal(requests[0].headers.get('X-Test'), 'preserved')
})

test('missing user returns authentication_required without fetching', async () => {
  let fetchCount = 0
  const { request } = makeClient({
    user: null,
    fetchImpl: async () => {
      fetchCount += 1
      return jsonResponse(200, {})
    },
  })

  await assert.rejects(
    request('https://api.example.invalid/resource'),
    error => error instanceof AuthenticatedFetchError
      && error.code === 'authentication_required'
      && error.status === 401,
  )
  assert.equal(fetchCount, 0)
})

test('initial token acquisition failure is distinct and sends no request', async () => {
  const { user, calls } = makeUser('user-1', [new Error('synthetic failure')])
  let fetchCount = 0
  const { request } = makeClient({
    user,
    fetchImpl: async () => {
      fetchCount += 1
      return jsonResponse(200, {})
    },
  })

  await assert.rejects(
    request('https://api.example.invalid/resource'),
    error => error.code === 'token_acquisition_failed' && error.status === 401,
  )
  assert.deepEqual(calls, [false])
  assert.equal(fetchCount, 0)
})

test('expired token force-refreshes and replays exactly once with request fidelity', async () => {
  const { user, calls } = makeUser('user-1', ['expired-token', 'fresh-token'])
  const attempts = []
  const { request } = makeClient({
    user,
    fetchImpl: async (url, init) => {
      attempts.push({
        url,
        method: init.method,
        body: init.body,
        authorization: init.headers.get('Authorization'),
        custom: init.headers.get('X-Custom'),
      })
      return attempts.length === 1
        ? errorResponse(401, 'token_expired')
        : jsonResponse(200, { ok: true })
    },
  })

  const response = await request('https://api.example.invalid/resource?q=1', {
    method: 'POST',
    body: JSON.stringify({ synthetic: true }),
    headers: {
      Authorization: 'Bearer hostile-value',
      'Content-Type': 'application/json',
      'X-Custom': 'same',
    },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(calls, [false, true])
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[0], {
    url: 'https://api.example.invalid/resource?q=1',
    method: 'POST',
    body: JSON.stringify({ synthetic: true }),
    authorization: 'Bearer expired-token',
    custom: 'same',
  })
  assert.deepEqual(attempts[1], {
    ...attempts[0],
    authorization: 'Bearer fresh-token',
  })
})

test('legacy invalid-or-expired response refreshes once without false logout', async () => {
  const { user, calls } = makeUser('user-1', ['expired-token', 'fresh-token'])
  let fetchCount = 0
  let reauthenticationCount = 0
  const { request } = makeClient({
    user,
    fetchImpl: async () => {
      fetchCount += 1
      return fetchCount === 1
        ? jsonResponse(401, {
            error: {
              code: 'invalid_token',
              message: 'The Firebase bearer token is invalid or expired',
            },
            requestId: 'legacy-request-id',
          })
        : jsonResponse(200, { ok: true })
    },
    reauthenticate: async () => {
      reauthenticationCount += 1
    },
  })

  const response = await request('https://api.example.invalid/resource')

  assert.equal(response.status, 200)
  assert.deepEqual(calls, [false, true])
  assert.equal(fetchCount, 2)
  assert.equal(reauthenticationCount, 0)
})

test('a second 401 stops after two attempts and reauthenticates once', async () => {
  const { user, calls } = makeUser('user-1', ['expired-token', 'fresh-token'])
  let fetchCount = 0
  let reauthenticationCount = 0
  const { request } = makeClient({
    user,
    fetchImpl: async () => {
      fetchCount += 1
      return errorResponse(
        401,
        fetchCount === 1 ? 'token_expired' : 'invalid_token',
        'second-request-id',
        { safe: true },
      )
    },
    reauthenticate: async () => {
      reauthenticationCount += 1
    },
  })

  await assert.rejects(
    request('https://api.example.invalid/resource'),
    error => error.code === 'reauthentication_required'
      && error.status === 401
      && error.requestId === 'second-request-id'
      && error.details?.safe === true,
  )
  assert.deepEqual(calls, [false, true])
  assert.equal(fetchCount, 2)
  assert.equal(reauthenticationCount, 1)
})

test('definitive revoked code from the replay reaches the sign-out policy', async () => {
  const { user } = makeUser('user-1', ['expired-token', 'fresh-token'])
  let fetchCount = 0
  const reauthenticationCodes = []
  const { request } = makeClient({
    user,
    fetchImpl: async () => {
      fetchCount += 1
      return errorResponse(
        401,
        fetchCount === 1 ? 'token_expired' : 'token_revoked',
      )
    },
    reauthenticate: async ({ code }) => {
      reauthenticationCodes.push(code)
    },
  })

  await assert.rejects(
    request('https://api.example.invalid/resource'),
    error => error.code === 'reauthentication_required',
  )
  assert.equal(fetchCount, 2)
  assert.deepEqual(reauthenticationCodes, ['token_revoked'])
})

for (const code of ['invalid_token', 'token_revoked', 'user_disabled']) {
  test(`${code} does not refresh or replay and requests reauthentication`, async () => {
    const { user, calls } = makeUser()
    let fetchCount = 0
    let reauthenticationCount = 0
    const { request } = makeClient({
      user,
      fetchImpl: async () => {
        fetchCount += 1
        return errorResponse(401, code)
      },
      reauthenticate: async () => {
        reauthenticationCount += 1
      },
    })

    await assert.rejects(
      request('https://api.example.invalid/resource'),
      error => error.code === code && error.status === 401,
    )
    assert.deepEqual(calls, [false])
    assert.equal(fetchCount, 1)
    assert.equal(reauthenticationCount, 1)
  })
}

test('settled reauthentication gate does not suppress a later revoked session', async () => {
  const { user, calls } = makeUser('user-1', ['token-1', 'token-2'])
  const responseCodes = ['invalid_token', 'token_revoked']
  const reauthenticationCodes = []
  const { request } = makeClient({
    user,
    fetchImpl: async () => errorResponse(401, responseCodes.shift()),
    reauthenticate: async ({ code }) => {
      reauthenticationCodes.push(code)
    },
  })

  await assert.rejects(
    request('https://api.example.invalid/first'),
    error => error.code === 'invalid_token',
  )
  await assert.rejects(
    request('https://api.example.invalid/second'),
    error => error.code === 'token_revoked',
  )

  assert.deepEqual(calls, [false, false])
  assert.deepEqual(reauthenticationCodes, ['invalid_token', 'token_revoked'])
})

test('automatic sign-out is limited to definitive revoked or disabled sessions', () => {
  assert.equal(shouldSignOutForAuthenticationError('token_revoked'), true)
  assert.equal(shouldSignOutForAuthenticationError('user_disabled'), true)
  assert.equal(shouldSignOutForAuthenticationError('invalid_token'), false)
  assert.equal(shouldSignOutForAuthenticationError('token_refresh_failed'), false)
  assert.equal(shouldSignOutForAuthenticationError('reauthentication_required'), false)
  assert.equal(shouldSignOutForAuthenticationError('authentication_required'), false)
})

test('refresh failure does not replay and requests reauthentication', async () => {
  const { user, calls } = makeUser('user-1', [
    'expired-token',
    new Error('synthetic refresh failure'),
  ])
  let fetchCount = 0
  let reauthenticationCount = 0
  const { request } = makeClient({
    user,
    fetchImpl: async () => {
      fetchCount += 1
      return errorResponse(401, 'token_expired')
    },
    reauthenticate: async () => {
      reauthenticationCount += 1
    },
  })

  await assert.rejects(
    request('https://api.example.invalid/resource'),
    error => error.code === 'token_refresh_failed' && error.status === 401,
  )
  assert.deepEqual(calls, [false, true])
  assert.equal(fetchCount, 1)
  assert.equal(reauthenticationCount, 1)
})

test('user switch between attempts prevents refresh and replay as another user', async () => {
  const first = makeUser('user-1', ['expired-token'])
  const second = makeUser('user-2', ['other-token'])
  let fetchCount = 0
  let reauthenticationCount = 0
  const { auth, request } = makeClient({
    user: first.user,
    fetchImpl: async () => {
      fetchCount += 1
      auth.currentUser = second.user
      return errorResponse(401, 'token_expired')
    },
    reauthenticate: async () => {
      reauthenticationCount += 1
    },
  })

  await assert.rejects(
    request('https://api.example.invalid/resource'),
    error => error.code === 'reauthentication_required',
  )
  assert.deepEqual(first.calls, [false])
  assert.deepEqual(second.calls, [])
  assert.equal(fetchCount, 1)
  assert.equal(reauthenticationCount, 0)
})

test('network failure has status 0 and does not sign out or retry', async () => {
  const { user, calls } = makeUser()
  let fetchCount = 0
  let reauthenticationCount = 0
  const { request } = makeClient({
    user,
    fetchImpl: async () => {
      fetchCount += 1
      throw new TypeError('synthetic network failure')
    },
    reauthenticate: async () => {
      reauthenticationCount += 1
    },
  })

  await assert.rejects(
    request('https://api.example.invalid/resource'),
    error => error.code === 'network_error' && error.status === 0,
  )
  assert.deepEqual(calls, [false])
  assert.equal(fetchCount, 1)
  assert.equal(reauthenticationCount, 0)
})

test('timeout is distinct and does not refresh or sign out', async () => {
  const { user } = makeUser()
  let reauthenticationCount = 0
  const { request } = makeClient({
    user,
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    }),
    reauthenticate: async () => {
      reauthenticationCount += 1
    },
  })

  await assert.rejects(
    request('https://api.example.invalid/resource', {}, { timeoutMs: 5 }),
    error => error.code === 'request_timeout' && error.status === 408,
  )
  assert.equal(reauthenticationCount, 0)
})

test('auth service 503 is returned without refresh, replay, or sign-out', async () => {
  const { user, calls } = makeUser()
  let fetchCount = 0
  let reauthenticationCount = 0
  const { request } = makeClient({
    user,
    fetchImpl: async () => {
      fetchCount += 1
      return errorResponse(503, 'auth_service_unavailable', 'service-request-id')
    },
    reauthenticate: async () => {
      reauthenticationCount += 1
    },
  })

  const response = await request('https://api.example.invalid/resource')

  assert.equal(response.status, 503)
  assert.deepEqual(calls, [false])
  assert.equal(fetchCount, 1)
  assert.equal(reauthenticationCount, 0)
})

test('concurrent invalid-token failures share one reauthentication action', async () => {
  const { user } = makeUser('user-1', ['token-1', 'token-1'])
  let reauthenticationCount = 0
  let releaseReauthentication
  const reauthenticationBlocked = new Promise(resolve => {
    releaseReauthentication = resolve
  })
  const { request } = makeClient({
    user,
    fetchImpl: async () => errorResponse(401, 'invalid_token'),
    reauthenticate: async () => {
      reauthenticationCount += 1
      await reauthenticationBlocked
    },
  })

  const first = request('https://api.example.invalid/one')
  const second = request('https://api.example.invalid/two')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(reauthenticationCount, 1)
  releaseReauthentication()

  const results = await Promise.allSettled([first, second])
  assert.ok(results.every(result => result.status === 'rejected'))
  assert.equal(reauthenticationCount, 1)
})
