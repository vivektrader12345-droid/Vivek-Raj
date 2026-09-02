import { readFileSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertFails,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import { deleteApp, initializeApp } from 'firebase/app'
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
} from 'firebase/auth'
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  setDoc,
} from 'firebase/firestore'

const PROJECT_ID = 'demo-complimentary-billing'
const RULES_PATH = new URL('../firestore.rules', import.meta.url)
const INDEXES_PATH = new URL('../firestore.indexes.json', import.meta.url)

const COMPLIMENTARY_COLLECTIONS = [
  'billing_complimentary_grants',
  'billing_complimentary_users',
  'billing_complimentary_operations',
  'billing_complimentary_audit',
]

const EXISTING_PROTECTED_BILLING_COLLECTIONS = [
  'billing_plans',
  'billing_plan_catalog',
  'billing_coupons',
  'billing_coupon_user_usage',
  'billing_orders',
  'billing_provider_orders',
  'billing_payments',
  'billing_payment_attempts',
  'billing_subscriptions',
  'billing_coupon_redemptions',
  'billing_webhook_events',
]

const ALL_PROTECTED_BILLING_COLLECTIONS = [
  ...EXISTING_PROTECTED_BILLING_COLLECTIONS,
  ...COMPLIMENTARY_COLLECTIONS,
]

const approvedIndexes = [
  {
    collectionGroup: 'billing_complimentary_grants',
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'targetEmailNormalized', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' },
    ],
  },
  {
    collectionGroup: 'billing_complimentary_grants',
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'planId', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' },
    ],
  },
  {
    collectionGroup: 'billing_complimentary_grants',
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'targetEmailNormalized', order: 'ASCENDING' },
      { fieldPath: 'planId', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' },
    ],
  },
]

let testEnvironment

before(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(RULES_PATH, 'utf8') },
  })
})

beforeEach(async () => {
  await testEnvironment.clearFirestore()
})

after(async () => {
  await testEnvironment.cleanup()
})

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function assertAllBillingAccessDenied(context) {
  const database = context.firestore()

  for (const collectionName of ALL_PROTECTED_BILLING_COLLECTIONS) {
    const reference = database.doc(`${collectionName}/direct-client-probe`)
    await assertFails(reference.get())
    await assertFails(reference.set({ attempted: true }))
  }

  for (const collectionName of COMPLIMENTARY_COLLECTIONS) {
    await assertFails(database.collection(collectionName).limit(1).get())
  }
}

test('index manifest contains only the three approved complimentary list indexes', () => {
  const manifest = JSON.parse(readFileSync(INDEXES_PATH, 'utf8'))

  assert.deepEqual(manifest.indexes, approvedIndexes)
  assert.deepEqual(manifest.fieldOverrides, [])
  assert.equal(
    manifest.indexes.some(index => index.fields.some(field => field.fieldPath === 'status')),
    false,
  )
})

test('rules retain explicit false-only denies before the final catch-all', () => {
  const rules = readFileSync(RULES_PATH, 'utf8')
  const catchAllPosition = rules.indexOf('match /{document=**}')

  assert.ok(catchAllPosition > 0, 'final catch-all deny must remain present')
  for (const collectionName of ALL_PROTECTED_BILLING_COLLECTIONS) {
    const block = new RegExp(
      `match /${escapeRegex(collectionName)}/\\{document=\\*\\*\\} \\{\\s*allow read, write: if false;\\s*\\}`,
    )
    const match = rules.match(block)
    assert.ok(match, `${collectionName} must have an explicit false-only deny`)
    assert.ok(rules.indexOf(match[0]) < catchAllPosition)
  }
})

test('ordinary authenticated clients cannot read, list, or write protected billing state', async () => {
  const context = testEnvironment.authenticatedContext('ordinary-user', {
    email: 'ordinary@example.com',
    email_verified: true,
    firebase: { sign_in_provider: 'password' },
    auth_time: 100,
    otp_auth_time: 100,
  })

  await assertAllBillingAccessDenied(context)
})

test('admin-claim clients still cannot read, list, or write protected billing state', async () => {
  const context = testEnvironment.authenticatedContext('admin-user', {
    admin: true,
    email: 'admin@example.com',
    email_verified: true,
    firebase: { sign_in_provider: 'password' },
    auth_time: 100,
    otp_auth_time: 100,
  })

  await assertAllBillingAccessDenied(context)
})

test('real Auth emulator sessions are denied by Firestore rules', async () => {
  assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Auth emulator must be running')
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator must be running')

  const app = initializeApp({
    apiKey: 'demo-api-key',
    authDomain: `${PROJECT_ID}.firebaseapp.com`,
    projectId: PROJECT_ID,
  }, `task-14-auth-${Date.now()}`)
  const auth = getAuth(app)
  const database = getFirestore(app)
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, {
    disableWarnings: true,
  })
  const [firestoreHost, firestorePort] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  connectFirestoreEmulator(database, firestoreHost, Number(firestorePort))

  const credential = await createUserWithEmailAndPassword(
    auth,
    `task14-${Date.now()}@example.com`,
    'Task14-emulator-only-password',
  )
  try {
    for (const collectionName of ALL_PROTECTED_BILLING_COLLECTIONS) {
      const reference = doc(database, collectionName, 'real-auth-client-probe')
      await assert.rejects(getDoc(reference), error => error?.code === 'permission-denied')
      await assert.rejects(
        setDoc(reference, { attempted: true }),
        error => error?.code === 'permission-denied',
      )
    }
  } finally {
    await deleteUser(credential.user)
    await deleteApp(app)
  }
})