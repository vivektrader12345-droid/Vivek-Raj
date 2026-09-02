import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const protectedCollectionPattern = /billing_(?:complimentary_(?:grants|users|operations|audit)|subscriptions|payments|orders|invoices|coupon_redemptions)/

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(target)
    return /\.(?:js|jsx|ts|tsx)$/.test(entry.name) ? [target] : []
  }))
  return nested.flat()
}

async function bundleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return bundleFiles(target)
    return /\.(?:js|css|html)$/.test(entry.name) ? [target] : []
  }))
  return nested.flat()
}

// Validates: Requirements 13.6, 14.2, 17.3-17.5, 19.1, 19.5, 20.4-20.6

test('frontend source and production bundle contain no direct protected billing collection access', async () => {
  const source = await sourceFiles(path.join(root, 'src'))
  for (const file of source) {
    const contents = await readFile(file, 'utf8')
    assert.doesNotMatch(contents, protectedCollectionPattern, `${path.relative(root, file)} references a protected billing collection directly`)
  }

  const bundle = await bundleFiles(path.join(root, 'dist'))
  assert.ok(bundle.length > 0, 'production bundle must exist before the bundle security assertion runs')
  for (const file of bundle) {
    const contents = await readFile(file, 'utf8')
    assert.doesNotMatch(contents, protectedCollectionPattern, `${path.relative(root, file)} exposes a protected billing collection name`)
  }
})

test('complimentary administration renders server fields through React text nodes and never treats grants as payments', async () => {
  const page = await readFile(path.join(root, 'src/pages/AdminComplimentarySubscriptions.jsx'), 'utf8')
  const state = await readFile(path.join(root, 'src/pages/adminComplimentarySubscriptionsState.js'), 'utf8')
  const combined = `${page}\n${state}`

  assert.doesNotMatch(combined, /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/)
  assert.doesNotMatch(page, /grant\.(?:amount|amountPaise|currency|paymentId|razorpayPaymentId|invoiceId)/)
  assert.match(page, /grant\.reason/)
  assert.match(page, /grant\.targetDisplayName/)
  assert.match(page, /whitespace-pre-wrap/)
})
