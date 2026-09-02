import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom'

import Layout from '../../src/components/Layout.jsx'
import AdminRoute from '../../src/components/AdminRoute.jsx'
import { SubscriptionProvider, useSubscription } from '../../src/context/SubscriptionContext.jsx'
import AdminComplimentarySubscriptions from '../../src/pages/AdminComplimentarySubscriptions.jsx'
import { entitlementSourceLabel, formatEntitlementValidity } from '../../src/services/subscriptionEntitlements.js'
import { mockBillingSnapshot } from './mockBillingService.js'

const normalizedText = value => String(value || '').replace(/\s+/g, ' ').trim()

function matchingElement(selector, text) {
  const expected = normalizedText(text)
  return [...document.querySelectorAll(selector)].find(element => normalizedText(element.textContent) === expected)
}

function controlForLabel(labelText) {
  const expected = normalizedText(labelText)
  const label = [...document.querySelectorAll('label')].find(candidate => normalizedText(candidate.childNodes[0]?.textContent).startsWith(expected)
    || normalizedText(candidate.textContent).startsWith(expected))
  return label?.querySelector('input, select, textarea') || null
}

function setNativeValue(control, value) {
  if (!control) throw new Error('Fixture control was not found')
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')
  descriptor?.set?.call(control, value)
  control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  if (control.tagName !== 'SELECT') control.dispatchEvent(new Event('change', { bubbles: true }))
}

function ContextProbe() {
  const context = useSubscription()
  return (
    <section data-testid="context-probe">
      <h2>Entitlement context probe</h2>
      <p data-testid="active">{context.active ? 'active' : 'inactive'}</p>
      <p data-testid="source">{entitlementSourceLabel(context.subscription)}</p>
      <p data-testid="validity">{formatEntitlementValidity(context.subscription) || 'No validity'}</p>
      <p data-testid="error">{context.error || 'No error'}</p>
    </section>
  )
}

function AdminScreen({ name }) {
  return <section><h2>{name}</h2><p>Existing administrator route remains available.</p></section>
}

function FixtureBridge() {
  const context = useSubscription()
  const navigate = useNavigate()

  useEffect(() => {
    window.__complimentaryFixture = {
      ready: context.initialized && !context.loading,
      scenario: new URLSearchParams(location.search).get('scenario') || 'full',
      billing: mockBillingSnapshot,
      context: () => ({
        active: context.active,
        isAdmin: context.isAdmin,
        adminCapabilities: context.adminCapabilities,
        initialized: context.initialized,
        loading: context.loading,
        error: context.error,
        subscription: context.subscription,
      }),
      text: () => document.body.innerText,
      navLabels: () => [...document.querySelectorAll('nav a')].map(anchor => normalizedText(anchor.textContent)),
      grantIds: () => [...document.querySelectorAll('[data-grant-id]')].map(element => element.getAttribute('data-grant-id')),
      dialogText: () => normalizedText(document.querySelector('[role="dialog"]')?.textContent),
      hasUnsafeRenderedElement: () => Boolean(document.querySelector('#unsafe-render-probe')),
      hasExactText: text => [...document.querySelectorAll('body *')].some(element => normalizedText(element.textContent) === normalizedText(text)),
      buttonDisabled: text => Boolean(matchingElement('button', text)?.disabled),
      optionValues: label => [...(controlForLabel(label)?.options || [])].map(option => option.value),
      setValue: (label, value) => setNativeValue(controlForLabel(label), value),
      clickButton: text => {
        const button = matchingElement('button', text)
        if (!button) throw new Error(`Button not found: ${text}`)
        button.click()
      },
      clickLink: text => {
        const link = matchingElement('a', text)
        if (!link) throw new Error(`Link not found: ${text}`)
        link.click()
      },
      navigate: path => navigate(path),
    }
  }, [context, navigate])

  return null
}

function FixtureApp() {
  return (
    <SubscriptionProvider>
      <BrowserRouter>
        <FixtureBridge />
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<ContextProbe />} />
            <Route path="probe" element={<ContextProbe />} />
            <Route path="admin/plans" element={<AdminRoute><AdminScreen name="Plan Admin Screen" /></AdminRoute>} />
            <Route path="admin/coupons" element={<AdminRoute><AdminScreen name="Coupon Admin Screen" /></AdminRoute>} />
            <Route path="admin/complimentary-subscriptions" element={<AdminRoute requiredCapability="complimentarySubscriptions"><AdminComplimentarySubscriptions /></AdminRoute>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SubscriptionProvider>
  )
}

createRoot(document.getElementById('root')).render(<FixtureApp />)
