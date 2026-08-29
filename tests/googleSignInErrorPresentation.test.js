import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  getGoogleSignInErrorMessage,
  isGoogleSignInCancellation,
} from '../src/services/googleSignInErrorPresentation.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

for (const code of [
  'google-signin-cancelled',
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
]) {
  test(`${code} is silently classified as Google sign-in cancellation`, () => {
    const error = Object.assign(new Error('Synthetic provider detail'), { code })

    assert.equal(isGoogleSignInCancellation(error), true)
    assert.equal(getGoogleSignInErrorMessage(error), null)
  })
}

for (const [code, expectedMessage] of [
  ['google-signin-timeout', 'Google sign-in timed out. Please try again.'],
  ['google-signin-unavailable', 'Google sign-in is unavailable. Please try again later.'],
  ['google-signin-failed', 'Google sign-in failed. Please try again.'],
]) {
  test(`${code} maps to a safe retry message`, () => {
    const error = Object.assign(new Error('synthetic token callback account detail'), { code })

    assert.equal(isGoogleSignInCancellation(error), false)
    assert.equal(getGoogleSignInErrorMessage(error), expectedMessage)
    assert.doesNotMatch(getGoogleSignInErrorMessage(error), /token|callback|account|synthetic/i)
  })
}

test('unknown provider failures use a generic safe retry message without exposing SDK details', () => {
  const error = Object.assign(new Error('synthetic SDK callback detail'), {
    code: 'auth/network-request-failed',
  })

  assert.equal(getGoogleSignInErrorMessage(error), 'Google sign-in failed. Please try again.')
  assert.doesNotMatch(getGoogleSignInErrorMessage(error), /sdk|callback|synthetic/i)
})

test('auth observer diagnostics do not serialize raw Firebase or native errors', async () => {
  const source = await readFile(path.join(root, 'src/context/AuthContext.jsx'), 'utf8')

  assert.match(source, /console\.error\('Auth state initialization failed'\)/u)
  assert.doesNotMatch(source, /console\.error\('Auth state error:',\s*err\)/u)
})