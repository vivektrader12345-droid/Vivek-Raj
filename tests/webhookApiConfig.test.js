import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOCAL_WEBHOOK_API_BASE_URL,
  RENDER_WEBHOOK_API_BASE_URL,
  resolveWebhookApiBaseUrl,
} from '../src/services/webhookApiConfig.js'

test('configured localhost origin is normalized', () => {
  assert.equal(
    resolveWebhookApiBaseUrl({
      configuredBase: 'http://127.0.0.1:5000///',
      hostname: 'example.invalid',
    }),
    'http://127.0.0.1:5000',
  )
})

test('configured Render origin is normalized', () => {
  assert.equal(
    resolveWebhookApiBaseUrl({
      configuredBase: 'https://vivek-raj.onrender.com/',
      hostname: 'localhost',
    }),
    'https://vivek-raj.onrender.com',
  )
})

test('localhost falls back to the local backend without production configuration', () => {
  assert.equal(
    resolveWebhookApiBaseUrl({ hostname: 'localhost' }),
    LOCAL_WEBHOOK_API_BASE_URL,
  )
  assert.equal(
    resolveWebhookApiBaseUrl({ hostname: '127.0.0.1' }),
    LOCAL_WEBHOOK_API_BASE_URL,
  )
})

test('deployed hosts retain the safe Render fallback', () => {
  assert.equal(
    resolveWebhookApiBaseUrl({ hostname: 'trader.example.invalid' }),
    RENDER_WEBHOOK_API_BASE_URL,
  )
})

test('API origin rejects embedded credentials and non-origin paths', () => {
  assert.throws(
    () => resolveWebhookApiBaseUrl({ configuredBase: 'https://user:pass@example.invalid' }),
    /must not contain credentials/,
  )
  assert.throws(
    () => resolveWebhookApiBaseUrl({ configuredBase: 'https://example.invalid/api' }),
    /must be an origin/,
  )
})
