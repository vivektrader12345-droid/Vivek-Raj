import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '../../src/index.css'

import Layout from '../../src/components/Layout.jsx'
import PublicDownloadMenu from '../../src/components/PublicDownloadMenu.jsx'
import apkDescriptor from '../../public/downloads/vivek-marco-trader.apk.json'

const observations = {
  downloads: [],
  errors: [],
  preflightRequests: [],
}

function verifiedResponse(body, { status, url, headers }) {
  const payload = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body))
  return {
    status,
    url,
    redirected: false,
    headers: new Headers(headers),
    body: new Response(payload).body,
    async arrayBuffer() {
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
    },
  }
}

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, options = {}) => {
  const url = new URL(input, location.href)
  if (url.pathname === `${apkDescriptor.path}.json`) {
    observations.preflightRequests.push({ path: url.pathname, range: null })
    return verifiedResponse(JSON.stringify(apkDescriptor), {
      status: 200,
      url: url.href,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (url.pathname === apkDescriptor.path && options.headers?.Range) {
    const range = options.headers.Range
    const isPrefix = range === 'bytes=0-3'
    const finalOffset = apkDescriptor.byteSize - 1
    observations.preflightRequests.push({ path: url.pathname, range })
    return verifiedResponse(isPrefix
      ? new Uint8Array([0x50, 0x4b, 0x03, 0x04])
      : new Uint8Array([0x00]), {
      status: 206,
      url: url.href,
      headers: {
        'content-type': apkDescriptor.mediaType,
        'content-disposition': `attachment; filename="${apkDescriptor.filename}"`,
        'content-range': isPrefix
          ? `bytes 0-3/${apkDescriptor.byteSize}`
          : `bytes ${finalOffset}-${finalOffset}/${apkDescriptor.byteSize}`,
        'content-length': isPrefix ? '4' : '1',
      },
    })
  }
  return nativeFetch(input, options)
}

window.addEventListener('error', event => observations.errors.push(String(event.error?.message || event.message)))
window.addEventListener('unhandledrejection', event => {
  observations.errors.push(String(event.reason?.message || event.reason))
  event.preventDefault()
})

const nativeAnchorClick = HTMLAnchorElement.prototype.click
HTMLAnchorElement.prototype.click = function click() {
  const url = new URL(this.href, location.href)
  if (url.pathname.startsWith('/downloads/')) {
    observations.downloads.push({ path: url.pathname, search: url.search, download: this.download })
    return
  }
  return nativeAnchorClick.call(this)
}

function AuthenticatedFixture() {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<div data-route-content>Dashboard fixture</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

const mode = new URLSearchParams(location.search).get('mode') || 'public'
createRoot(document.getElementById('root')).render(mode === 'authenticated' ? <AuthenticatedFixture /> : <PublicDownloadMenu />)

window.__apkPreservation = {
  ready: true,
  mode,
  resetDownloads() { observations.downloads.length = 0 },
  snapshot() {
    const trigger = document.querySelector('[data-public-menu-trigger]')
    const control = document.querySelector('[data-pwa-install]')
    const sidebar = document.getElementById('app-sidebar')
    return {
      mode,
      downloads: [...observations.downloads],
      errors: [...observations.errors],
      preflightRequests: [...observations.preflightRequests],
      installControlCount: document.querySelectorAll('[data-pwa-install]').length,
      trigger: trigger ? {
        label: trigger.getAttribute('aria-label'),
        expanded: trigger.getAttribute('aria-expanded'),
        controls: trigger.getAttribute('aria-controls'),
        hasPopup: trigger.getAttribute('aria-haspopup'),
      } : null,
      menuVisible: Boolean(document.querySelector('[role="menu"]')),
      menuItemVisible: Boolean(document.querySelector('[role="menuitem"]')),
      activeIsTrigger: document.activeElement === trigger,
      control: control ? {
        text: control.textContent.trim(),
        title: control.getAttribute('title'),
        tagName: control.tagName,
        type: control.getAttribute('type'),
      } : null,
      sidebarClass: sidebar?.className || null,
      mobileTriggerExpanded: document.querySelector('[aria-controls="app-sidebar"]')?.getAttribute('aria-expanded') || null,
      routeContentVisible: Boolean(document.querySelector('[data-route-content]')),
    }
  },
}
