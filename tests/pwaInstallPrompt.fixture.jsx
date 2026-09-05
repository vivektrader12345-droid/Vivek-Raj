import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import PWAInstallPrompt from '../src/components/PWAInstallPrompt.jsx'

let root

function PWAInstallPromptFixture({ token }) {
  useEffect(() => {
    window.__pwaInstallPromptFixtureReady = token
  }, [token])

  return <PWAInstallPrompt />
}

function mountFixture(token) {
  root = createRoot(document.getElementById('root'))
  root.render(<PWAInstallPromptFixture token={token} />)
}

window.__resetPwaInstallPromptFixture = ({ token, navigatorEvidence }) => {
  root?.unmount()
  window.__resetAndroidRegression()
  window.__applyRequestedNavigatorEvidence(navigatorEvidence)
  mountFixture(token)
}

mountFixture('initial')
