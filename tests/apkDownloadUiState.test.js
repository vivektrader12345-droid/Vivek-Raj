import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APK_DOWNLOAD_UI_ACTIONS,
  APK_DOWNLOAD_UI_PHASES,
  androidApkDownloadReducer,
  apkDownloadStatusMessage,
  createAndroidApkDownloadState,
} from '../src/components/useAndroidApkDownload.js'
import { ANDROID_APK_UNAVAILABLE_REASONS } from '../src/components/pwaInstallSelection.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manualUrl = `https://app.invalid/downloads/vivek-marco-trader.apk?v=${'b'.repeat(64)}`

function availableResult() {
  return {
    status: 'available',
    verifiedAvailable: true,
    manualUrl,
    expiresAt: 31_000,
    selectedCount: 0,
    claimedDownloadStarted: false,
    claimedTransferCompleted: false,
  }
}

function unavailableResult(reason = ANDROID_APK_UNAVAILABLE_REASONS.MISSING) {
  return {
    status: 'unavailable',
    reason,
    verifiedAvailable: false,
    selectedCount: 0,
    claimedDownloadStarted: false,
    claimedTransferCompleted: false,
  }
}

function reduce(state, type, values = {}) {
  return androidApkDownloadReducer(state, { type, ...values })
}

test('shared state model follows checking, available, requesting, and manual-guidance transitions', () => {
  // **Validates: Requirements 2.5, 2.6, 2.7, 3.1**
  let state = createAndroidApkDownloadState()
  assert.equal(state.phase, APK_DOWNLOAD_UI_PHASES.IDLE)

  state = reduce(state, APK_DOWNLOAD_UI_ACTIONS.CHECK_STARTED)
  assert.equal(state.phase, APK_DOWNLOAD_UI_PHASES.CHECKING)
  assert.equal(apkDownloadStatusMessage(state), 'Checking app download availability')

  const availability = availableResult()
  state = reduce(state, APK_DOWNLOAD_UI_ACTIONS.CHECK_SETTLED, { result: availability })
  assert.equal(state.phase, APK_DOWNLOAD_UI_PHASES.AVAILABLE)
  assert.equal(state.manualUrl, manualUrl)
  assert.equal(state.stale, false)

  state = reduce(state, APK_DOWNLOAD_UI_ACTIONS.REQUEST_STARTED)
  assert.equal(state.phase, APK_DOWNLOAD_UI_PHASES.REQUESTING)
  assert.equal(apkDownloadStatusMessage(state), 'Requesting app download')

  const requested = {
    ...availability,
    status: 'requested',
    selectedCount: 1,
  }
  state = reduce(state, APK_DOWNLOAD_UI_ACTIONS.REQUEST_SETTLED, { result: requested, now: 5_000 })
  assert.equal(state.phase, APK_DOWNLOAD_UI_PHASES.MANUAL)
  assert.equal(state.manualUrl, manualUrl)
  assert.equal(state.expiresAt, 35_000)
  assert.equal(apkDownloadStatusMessage(state), 'The browser was asked to download the app.')
  assert.equal(state.result.claimedTransferCompleted, false)
})

test('failed checks expose unavailable state and only an explicit retry returns to checking', () => {
  // **Validates: Requirements 2.5, 2.7**
  const initial = createAndroidApkDownloadState()
  const failureReasons = [
    ANDROID_APK_UNAVAILABLE_REASONS.MISSING,
    ANDROID_APK_UNAVAILABLE_REASONS.TIMEOUT,
    ANDROID_APK_UNAVAILABLE_REASONS.INVALID_METADATA,
    ANDROID_APK_UNAVAILABLE_REASONS.WRONG_CONTENT,
    ANDROID_APK_UNAVAILABLE_REASONS.TRUNCATION,
  ]

  for (const reason of failureReasons) {
    const checking = reduce(initial, APK_DOWNLOAD_UI_ACTIONS.CHECK_STARTED)
    const unavailable = reduce(checking, APK_DOWNLOAD_UI_ACTIONS.CHECK_SETTLED, {
      result: unavailableResult(reason),
    })
    assert.equal(unavailable.phase, APK_DOWNLOAD_UI_PHASES.UNAVAILABLE, reason)
    assert.equal(unavailable.reason, reason)
    assert.equal(unavailable.manualUrl, null)
    assert.equal(apkDownloadStatusMessage(unavailable), 'App download unavailable')
    assert.equal(
      reduce(unavailable, APK_DOWNLOAD_UI_ACTIONS.REQUEST_STARTED),
      unavailable,
      `unverified ${reason} state cannot enter requesting`,
    )

    const retry = reduce(unavailable, APK_DOWNLOAD_UI_ACTIONS.CHECK_STARTED)
    assert.equal(retry.phase, APK_DOWNLOAD_UI_PHASES.CHECKING)
  }
})

test('browser-restricted activation retains verified manual recovery without a success claim', () => {
  // **Validates: Requirements 2.6, 2.7**
  const available = reduce(createAndroidApkDownloadState(), APK_DOWNLOAD_UI_ACTIONS.CHECK_SETTLED, {
    result: availableResult(),
  })
  const requesting = reduce(available, APK_DOWNLOAD_UI_ACTIONS.REQUEST_STARTED)
  const restricted = reduce(requesting, APK_DOWNLOAD_UI_ACTIONS.REQUEST_SETTLED, {
    now: 10_000,
    result: {
      ...unavailableResult(ANDROID_APK_UNAVAILABLE_REASONS.ACTIVATION_RESTRICTED),
      descriptor: { filename: 'vivek-marco-trader.apk' },
      manualUrl,
      url: manualUrl,
    },
  })

  assert.equal(restricted.phase, APK_DOWNLOAD_UI_PHASES.MANUAL)
  assert.equal(restricted.manualUrl, manualUrl)
  assert.equal(restricted.result.selectedCount, 0)
  assert.equal(restricted.result.claimedDownloadStarted, false)
  assert.equal(restricted.result.claimedTransferCompleted, false)
  assert.equal(apkDownloadStatusMessage(restricted), 'The browser could not open the download automatically.')
})

test('visibility staleness only invalidates verified states before their next activation', () => {
  // **Validates: Requirements 2.5, 3.1**
  const idle = createAndroidApkDownloadState()
  assert.equal(reduce(idle, APK_DOWNLOAD_UI_ACTIONS.MARK_STALE), idle)

  const available = reduce(idle, APK_DOWNLOAD_UI_ACTIONS.CHECK_SETTLED, { result: availableResult() })
  const staleAvailable = reduce(available, APK_DOWNLOAD_UI_ACTIONS.MARK_STALE)
  assert.equal(staleAvailable.phase, APK_DOWNLOAD_UI_PHASES.AVAILABLE)
  assert.equal(staleAvailable.stale, true)

  const manual = reduce(
    reduce(available, APK_DOWNLOAD_UI_ACTIONS.REQUEST_STARTED),
    APK_DOWNLOAD_UI_ACTIONS.REQUEST_SETTLED,
    { result: { ...availableResult(), status: 'requested', selectedCount: 1 }, now: 1_000 },
  )
  const staleManual = reduce(manual, APK_DOWNLOAD_UI_ACTIONS.MARK_STALE)
  assert.equal(staleManual.phase, APK_DOWNLOAD_UI_PHASES.MANUAL)
  assert.equal(staleManual.stale, true)
  assert.equal(staleManual.manualUrl, manualUrl)
})

test('both active entry points consume the shared accessible model and preserve interaction contracts', async () => {
  // **Validates: Requirements 2.5, 2.6, 2.7, 3.1, 3.4, 3.8**
  const [hookSource, publicSource, layoutSource, appSource] = await Promise.all([
    readFile(path.join(repositoryRoot, 'src', 'components', 'useAndroidApkDownload.js'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'components', 'PublicDownloadMenu.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'components', 'Layout.jsx'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'App.jsx'), 'utf8'),
  ])

  assert.match(hookSource, /checkInFlightRef\.current\) return checkInFlightRef\.current/, 'repeated checks share one in-flight probe')
  assert.match(hookSource, /requestInFlightRef\.current\) return requestInFlightRef\.current/, 'repeated activations share one in-flight request')
  assert.match(hookSource, /void runCheck\(\)/, 'mount starts one bounded availability check')
  assert.match(hookSource, /checkControllerRef\.current\?\.abort\(\)/, 'unmount aborts pending preflight')
  assert.match(hookSource, /visibilitychange/)
  assert.match(hookSource, /event\.preventDefault\(\)[\s\S]*requestDownload\(\)/, 'stale manual links revalidate')
  assert.doesNotMatch(hookSource, /setInterval|setTimeout/, 'the UI adds no background retry loop')

  for (const [name, source] of [['public', publicSource], ['authenticated', layoutSource]]) {
    assert.match(source, /useAndroidApkDownload\(\)/, `${name} entry point uses the shared model`)
    assert.doesNotMatch(source, /selectAndroidApk/, `${name} entry point has no blind selector call`)
    assert.match(source, /aria-live="polite"/, `${name} state is announced`)
    assert.match(source, /aria-busy/, `${name} checking/requesting state is busy`)
    assert.match(source, /App download unavailable/, `${name} exposes unavailable copy`)
    assert.match(source, />\s*Retry\s*</, `${name} exposes bounded user retry`)
    assert.match(source, /Manual download/, `${name} retains manual recovery`)
    assert.match(source, /supported browser/, `${name} explains browser recovery`)
  }

  assert.match(publicSource, /<button[\s\S]*?type="button"[\s\S]*?data-public-menu-trigger[\s\S]*?onClick=/, 'native trigger preserves pointer, touch, Enter, and Space activation')
  assert.match(publicSource, /role="menu"/)
  assert.match(publicSource, /role="menuitem"/)
  assert.match(publicSource, /disabled[\s\S]*aria-busy="true"/, 'checking control cannot imply availability')
  assert.match(publicSource, /aria-expanded=\{open\}/)
  assert.match(publicSource, /aria-controls="public-download-menu"/)
  assert.match(publicSource, /event\.key !== 'Escape'/)
  assert.match(publicSource, /triggerRef\.current\?\.focus\(\)/)
  assert.match(publicSource, /pointerdown/)
  assert.match(publicSource, /menuRef\.current\?\.contains\(event\.target\)/, 'outside pointer dismissal preserves inside interactions')
  assert.match(layoutSource, /aria-label=\{sidebarOpen \? 'Close navigation menu' : 'Open navigation menu'\}/)
  assert.match(layoutSource, /aria-controls="app-sidebar"/)
  assert.match(layoutSource, /className="lg:hidden[\s\S]*onClick=\{\(\) => setSidebarOpen\(!sidebarOpen\)\}/, 'mobile sidebar remains pointer and keyboard operable')
  assert.match(layoutSource, /sidebarOpen && \([\s\S]*onClick=\{\(\) => setSidebarOpen\(false\)\}/, 'mobile outside overlay dismisses the sidebar')
  assert.match(layoutSource, /result\?\.status === 'requested'\) setSidebarOpen\(false\)/)
  assert.match(layoutSource, /title=\{collapsed \? 'Download App' : undefined\}/)
  assert.match(layoutSource, /title=\{collapsed \? 'Retry app download' : undefined\}/)
  assert.match(layoutSource, /title=\{collapsed \? 'Manual download' : undefined\}/)
  assert.match(layoutSource, /className=\{collapsed \? 'sr-only'/, 'collapsed state retains announced status text')
  assert.equal((appSource.match(/<PublicDownloadMenu\s*\/>/g) || []).length, 1)
  assert.equal((appSource.match(/<Layout\s*\/>/g) || []).length, 1)
  assert.doesNotMatch(appSource, /PWAInstallPrompt/)
})
