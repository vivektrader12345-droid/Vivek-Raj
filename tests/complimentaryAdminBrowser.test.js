import assert from 'node:assert/strict'
import test from 'node:test'

import {
  delay,
  startBrowserHarness,
  stopBrowserHarness,
  waitForPage,
} from './complimentary-admin/browserHarness.js'

// Validates: Requirements 1.1-1.4, 2.5-2.6, 4.1-4.5, 6.2-6.6, 7.2-7.6,
// 8.1, 8.5, 14.2, 15.1-15.6, 16.1-16.2, 17.3-17.5, 18.3, 19.1, 19.3-19.5, 20.4-20.6

test('browser E2E covers capability routes, context lifecycle, and complete complimentary administration flows', { timeout: 180_000 }, async () => {
  const harness = await startBrowserHarness()
  const { client } = harness

  async function navigate(scenario, path = '/admin/complimentary-subscriptions') {
    const url = `http://127.0.0.1:${harness.vitePort}${path}?scenario=${encodeURIComponent(scenario)}`
    await client.send('Page.navigate', { url })
    await waitForPage(client, `location.search === '?scenario=${scenario}' && Boolean(window.__complimentaryFixture?.ready)`)
  }

  try {
    await navigate('denied-capability')
    await waitForPage(client, `document.body.innerText.includes('Administrative capability unavailable')`)
    let nav = await client.evaluate('window.__complimentaryFixture.navLabels()')
    assert.equal(nav.includes('Complimentary Subscriptions'), false)
    assert.equal(nav.includes('Plan Admin'), true)
    assert.equal(nav.includes('Coupon Admin'), true)
    await client.evaluate(`window.__complimentaryFixture.clickLink('Plan Admin')`)
    await waitForPage(client, `document.body.innerText.includes('Plan Admin Screen')`)

    await navigate('nonadmin')
    await waitForPage(client, `document.body.innerText.includes('Administrator access not recognized')`)
    nav = await client.evaluate('window.__complimentaryFixture.navLabels()')
    assert.equal(nav.includes('Complimentary Subscriptions'), false)
    assert.equal(nav.includes('Plan Admin'), false)

    await navigate('stale-frontend')
    assert.equal((await client.evaluate('window.__complimentaryFixture.navLabels()')).includes('Complimentary Subscriptions'), true)
    await waitForPage(client, `document.body.innerText.includes('Administrative access was denied by the backend')`)
    assert.deepEqual(await client.evaluate('window.__complimentaryFixture.grantIds()'), [])
    const staleCalls = await client.evaluate('window.__complimentaryFixture.billing().calls')
    assert.equal(staleCalls.some(call => call.method === 'listComplimentaryGrants'), true)

    await navigate('failclosed', '/probe')
    const failedContext = await client.evaluate('window.__complimentaryFixture.context()')
    assert.equal(failedContext.active, false)
    assert.equal(failedContext.isAdmin, false)
    assert.deepEqual(failedContext.adminCapabilities, { complimentarySubscriptions: false })
    assert.match(failedContext.error, /unavailable/i)

    await navigate('finite-expiry', '/probe')
    assert.equal((await client.evaluate('window.__complimentaryFixture.context()')).active, true)
    await waitForPage(client, `window.__complimentaryFixture.billing().getMeCount >= 2 && window.__complimentaryFixture.context().active === false`, 10_000)

    await navigate('lifetime', '/probe')
    assert.equal((await client.evaluate('window.__complimentaryFixture.context()')).active, true)
    assert.match(await client.evaluate('window.__complimentaryFixture.text()'), /Complimentary access/)
    assert.match(await client.evaluate('window.__complimentaryFixture.text()'), /Lifetime/)
    await delay(1500)
    assert.equal(await client.evaluate('window.__complimentaryFixture.billing().getMeCount'), 1, 'lifetime entitlement must not schedule expiry refresh')

    await navigate('full')
    await waitForPage(client, `document.body.innerText.includes('Complimentary Subscriptions') && window.__complimentaryFixture.grantIds().includes('grant-active')`)
    const initialText = await client.evaluate('window.__complimentaryFixture.text()')
    assert.match(initialText, /Pro/)
    assert.match(initialText, /Analytics/)
    assert.match(initialText, /Automation/)
    assert.match(initialText, /Grant ID/)
    assert.match(initialText, /Target UID/)
    assert.match(initialText, /Created by/)
    assert.match(initialText, /End reason/)
    assert.match(initialText, /Support & retention <plain text>/)
    assert.equal(await client.evaluate('window.__complimentaryFixture.hasUnsafeRenderedElement()'), false)
    assert.equal((await client.evaluate('window.__complimentaryFixture.navLabels()')).includes('Complimentary Subscriptions'), true)

    await client.evaluate(`window.__complimentaryFixture.setValue('Firebase email', 'person@example.com')`)
    await client.evaluate(`window.__complimentaryFixture.clickButton('Look up')`)
    await waitForPage(client, `window.__complimentaryFixture.billing().calls.some(call => call.method === 'lookupBillingUser') && window.__complimentaryFixture.hasExactText('Eligible')`)
    let lookupCall = await client.evaluate(`window.__complimentaryFixture.billing().calls.find(call => call.method === 'lookupBillingUser')`)
    assert.deepEqual(lookupCall.payload, { email: 'person@example.com' })

    await client.evaluate(`window.__complimentaryFixture.setValue('Firebase email', 'other@example.com')`)
    await delay(80)
    assert.equal(await client.evaluate(`window.__complimentaryFixture.hasExactText('Eligible')`), false, 'editing lookup must invalidate selected target')
    assert.equal(await client.evaluate(`window.__complimentaryFixture.buttonDisabled('Review grant')`), true)

    await client.evaluate(`window.__complimentaryFixture.setValue('Firebase email', 'person@example.com'); window.__complimentaryFixture.clickButton('Look up')`)
    await waitForPage(client, `window.__complimentaryFixture.hasExactText('Eligible')`)
    await client.evaluate(`window.__complimentaryFixture.setValue('Canonical plan', 'pro')`)

    assert.deepEqual(await client.evaluate(`window.__complimentaryFixture.optionValues('Preset days')`), ['7', '30', '90', '365'])
    for (const days of ['7', '30', '90', '365']) {
      await client.evaluate(`window.__complimentaryFixture.setValue('Preset days', '${days}')`)
      assert.equal(await client.evaluate(`window.__complimentaryFixture.optionValues('Preset days').includes('${days}')`), true)
    }
    await client.evaluate(`window.__complimentaryFixture.setValue('Preset days', '7'); window.__complimentaryFixture.clickButton('Review grant')`)
    await waitForPage(client, `window.__complimentaryFixture.dialogText().includes('server time is authoritative')`)
    assert.match(await client.evaluate('window.__complimentaryFixture.dialogText()'), /Target.*person@example.com.*Plan and tier.*Pro · pro/s)
    assert.match(await client.evaluate('window.__complimentaryFixture.dialogText()'), /Current effective state.*Paid fallback/s)
    await client.evaluate(`window.__complimentaryFixture.clickButton('Cancel')`)

    await client.evaluate(`window.__complimentaryFixture.setValue('Validity type', 'custom')`)
    await client.evaluate(`window.__complimentaryFixture.setValue('Custom expiration', '2999-01-01T05:30')`)
    await client.evaluate(`window.__complimentaryFixture.clickButton('Review grant')`)
    await waitForPage(client, `window.__complimentaryFixture.dialogText().includes('2999')`)
    await client.evaluate(`window.__complimentaryFixture.clickButton('Cancel')`)

    await client.evaluate(`window.__complimentaryFixture.setValue('Validity type', 'lifetime')`)
    await waitForPage(client, `document.body.innerText.includes('No expiration will be created')`)
    await client.evaluate(`window.__complimentaryFixture.clickButton('Review grant')`)
    await waitForPage(client, `window.__complimentaryFixture.dialogText().includes('Lifetime')`)
    await client.evaluate(`window.__complimentaryFixture.clickButton('Confirm grant')`)
    await waitForPage(client, `document.body.innerText.includes('Authoritative grant result')`)
    const createCall = await client.evaluate(`window.__complimentaryFixture.billing().calls.find(call => call.method === 'createComplimentaryGrant')`)
    assert.deepEqual(createCall.payload.validity, { type: 'lifetime' })
    assert.match(createCall.payload.idempotencyKey, /^grant-/)
    assert.equal('targetUid' in createCall.payload, false)

    await client.evaluate(`window.__complimentaryFixture.setValue('Exact email', 'person@example.com'); window.__complimentaryFixture.setValue('Plan', 'pro'); window.__complimentaryFixture.setValue('Status', 'active'); window.__complimentaryFixture.clickButton('Apply')`)
    await waitForPage(client, `window.__complimentaryFixture.billing().calls.filter(call => call.method === 'listComplimentaryGrants').some(call => call.payload.email === 'person@example.com' && call.payload.planId === 'pro' && call.payload.status === 'active')`)
    await client.evaluate(`window.__complimentaryFixture.clickButton('Load next page')`)
    await waitForPage(client, `window.__complimentaryFixture.grantIds().includes('grant-history')`)
    assert.equal((await client.evaluate('window.__complimentaryFixture.billing().calls')).some(call => call.payload?.cursor === 'cursor-page-two'), true)

    await client.evaluate(`window.__complimentaryFixture.setValue('Exact email', 'empty@example.com'); window.__complimentaryFixture.setValue('Plan', ''); window.__complimentaryFixture.setValue('Status', ''); window.__complimentaryFixture.clickButton('Apply')`)
    await waitForPage(client, `document.body.innerText.includes('No complimentary grants match these filters')`)

    await client.evaluate(`window.__complimentaryFixture.setValue('Exact email', 'error@example.com'); window.__complimentaryFixture.clickButton('Apply')`)
    await waitForPage(client, `document.body.innerText.includes('Grant history is temporarily unavailable') && document.body.innerText.includes('Retry history')`)
    await client.evaluate(`window.__complimentaryFixture.setValue('Exact email', ''); window.__complimentaryFixture.clickButton('Apply')`)
    await waitForPage(client, `window.__complimentaryFixture.grantIds().length > 0`)

    await client.evaluate(`window.__complimentaryFixture.clickButton('Revoke access')`)
    await waitForPage(client, `window.__complimentaryFixture.dialogText().includes('Confirm access revocation')`)
    assert.match(await client.evaluate('window.__complimentaryFixture.dialogText()'), /person@example.com.*Pro.*Lifetime/s)
    await client.evaluate(`window.__complimentaryFixture.setValue('Revocation reason', 'Access complete'); window.__complimentaryFixture.clickButton('Confirm revoke')`)
    await waitForPage(client, `document.body.innerText.includes('Authoritative revoke result')`)
    const revokeCall = await client.evaluate(`window.__complimentaryFixture.billing().calls.find(call => call.method === 'revokeComplimentaryGrant')`)
    assert.equal(revokeCall.payload.reason, 'Access complete')
    assert.match(revokeCall.payload.idempotencyKey, /^revoke-/)
    const finalText = await client.evaluate('window.__complimentaryFixture.text()')
    assert.match(finalText, /Authoritative revoke result/)
    assert.match(finalText, /Paid fallback/)
    assert.match(finalText, /Basic · basic · paid/)

    await client.evaluate(`window.__complimentaryFixture.clickLink('Coupon Admin')`)
    await waitForPage(client, `document.body.innerText.includes('Coupon Admin Screen')`)
  } finally {
    await stopBrowserHarness(harness)
  }
})
