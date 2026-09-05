import { useCallback, useEffect, useReducer, useRef } from 'react'

import {
  ANDROID_APK_AVAILABILITY_TTL_MS,
  ANDROID_APK_UNAVAILABLE_REASONS,
  checkAndroidApkAvailability,
  selectAndroidApk,
} from './pwaInstallSelection.js'

export const APK_DOWNLOAD_UI_PHASES = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  REQUESTING: 'requesting',
  UNAVAILABLE: 'unavailable',
  MANUAL: 'available-with-manual-guidance',
})

export const APK_DOWNLOAD_UI_ACTIONS = Object.freeze({
  CHECK_STARTED: 'check-started',
  CHECK_SETTLED: 'check-settled',
  REQUEST_STARTED: 'request-started',
  REQUEST_SETTLED: 'request-settled',
  MARK_STALE: 'mark-stale',
})

function unavailableResult(reason = ANDROID_APK_UNAVAILABLE_REASONS.NETWORK_ERROR) {
  return {
    status: 'unavailable',
    state: 'unavailable',
    reason,
    verifiedAvailable: false,
    selectedCount: 0,
    claimedDownloadStarted: false,
    claimedTransferCompleted: false,
  }
}

export function createAndroidApkDownloadState() {
  return {
    phase: APK_DOWNLOAD_UI_PHASES.IDLE,
    result: null,
    reason: null,
    manualUrl: null,
    expiresAt: 0,
    stale: true,
  }
}

export function androidApkDownloadReducer(state, action) {
  switch (action.type) {
    case APK_DOWNLOAD_UI_ACTIONS.CHECK_STARTED:
      return {
        ...state,
        phase: APK_DOWNLOAD_UI_PHASES.CHECKING,
        reason: null,
        manualUrl: null,
      }
    case APK_DOWNLOAD_UI_ACTIONS.CHECK_SETTLED:
      if (action.result?.status === 'available') {
        return {
          phase: APK_DOWNLOAD_UI_PHASES.AVAILABLE,
          result: action.result,
          reason: null,
          manualUrl: action.result.manualUrl,
          expiresAt: action.result.expiresAt,
          stale: false,
        }
      }
      return {
        phase: APK_DOWNLOAD_UI_PHASES.UNAVAILABLE,
        result: action.result,
        reason: action.result?.reason ?? ANDROID_APK_UNAVAILABLE_REASONS.NETWORK_ERROR,
        manualUrl: null,
        expiresAt: 0,
        stale: true,
      }
    case APK_DOWNLOAD_UI_ACTIONS.REQUEST_STARTED:
      if (![APK_DOWNLOAD_UI_PHASES.AVAILABLE, APK_DOWNLOAD_UI_PHASES.MANUAL].includes(state.phase)) return state
      return { ...state, phase: APK_DOWNLOAD_UI_PHASES.REQUESTING, reason: null }
    case APK_DOWNLOAD_UI_ACTIONS.REQUEST_SETTLED: {
      const hasVerifiedManualRecovery = action.result?.verifiedAvailable === true
        && typeof action.result?.manualUrl === 'string'
      const activationWasRestricted = action.result?.reason === ANDROID_APK_UNAVAILABLE_REASONS.ACTIVATION_RESTRICTED
        && typeof action.result?.manualUrl === 'string'
      if (action.result?.status === 'requested' || hasVerifiedManualRecovery || activationWasRestricted) {
        return {
          phase: APK_DOWNLOAD_UI_PHASES.MANUAL,
          result: action.result,
          reason: action.result.reason ?? null,
          manualUrl: action.result.manualUrl,
          expiresAt: action.now + ANDROID_APK_AVAILABILITY_TTL_MS,
          stale: false,
        }
      }
      return {
        phase: APK_DOWNLOAD_UI_PHASES.UNAVAILABLE,
        result: action.result,
        reason: action.result?.reason ?? ANDROID_APK_UNAVAILABLE_REASONS.NETWORK_ERROR,
        manualUrl: null,
        expiresAt: 0,
        stale: true,
      }
    }
    case APK_DOWNLOAD_UI_ACTIONS.MARK_STALE:
      if (![APK_DOWNLOAD_UI_PHASES.AVAILABLE, APK_DOWNLOAD_UI_PHASES.MANUAL].includes(state.phase)) return state
      return { ...state, stale: true }
    default:
      return state
  }
}

export function androidApkAvailabilityRequiresRevalidation(state, now = Date.now()) {
  return state?.result?.verifiedAvailable !== true
    || state.stale === true
    || !Number.isFinite(state.expiresAt)
    || now >= state.expiresAt
}

export function apkDownloadStatusMessage(state) {
  switch (state.phase) {
    case APK_DOWNLOAD_UI_PHASES.CHECKING:
      return 'Checking app download availability'
    case APK_DOWNLOAD_UI_PHASES.REQUESTING:
      return 'Requesting app download'
    case APK_DOWNLOAD_UI_PHASES.UNAVAILABLE:
      return 'App download unavailable'
    case APK_DOWNLOAD_UI_PHASES.MANUAL:
      return state.reason === ANDROID_APK_UNAVAILABLE_REASONS.ACTIVATION_RESTRICTED
        ? 'The browser could not open the download automatically.'
        : 'The browser was asked to download the app.'
    default:
      return ''
  }
}

function operationOptions(options, signal, includeDocument = false) {
  const operation = { signal }
  if (options.fetch !== undefined) operation.fetch = options.fetch
  if (options.location !== undefined) operation.location = options.location
  if (options.timeoutMs !== undefined) operation.timeoutMs = options.timeoutMs
  if (options.now !== undefined) operation.now = options.now
  if (includeDocument && options.document !== undefined) operation.document = options.document
  return operation
}

export default function useAndroidApkDownload(options = {}) {
  const [state, dispatch] = useReducer(androidApkDownloadReducer, undefined, createAndroidApkDownloadState)
  const stateRef = useRef(state)
  const optionsRef = useRef(options)
  const mountedRef = useRef(false)
  const checkInFlightRef = useRef(null)
  const requestInFlightRef = useRef(null)
  const checkControllerRef = useRef(null)
  const requestControllerRef = useRef(null)
  const wasHiddenRef = useRef(false)
  stateRef.current = state
  optionsRef.current = options

  const runCheck = useCallback(() => {
    if (checkInFlightRef.current) return checkInFlightRef.current

    const currentOptions = optionsRef.current
    const check = currentOptions.checkAvailability ?? checkAndroidApkAvailability
    const controller = new AbortController()
    checkControllerRef.current = controller
    if (mountedRef.current) dispatch({ type: APK_DOWNLOAD_UI_ACTIONS.CHECK_STARTED })

    const attempt = Promise.resolve()
      .then(() => check(operationOptions(currentOptions, controller.signal)))
      .catch(() => unavailableResult())
      .then(result => {
        if (mountedRef.current && !controller.signal.aborted) {
          dispatch({ type: APK_DOWNLOAD_UI_ACTIONS.CHECK_SETTLED, result })
        }
        return result
      })
      .finally(() => {
        if (checkInFlightRef.current === attempt) checkInFlightRef.current = null
        if (checkControllerRef.current === controller) checkControllerRef.current = null
      })

    checkInFlightRef.current = attempt
    return attempt
  }, [])

  const requestDownload = useCallback(() => {
    if (requestInFlightRef.current) return requestInFlightRef.current
    if (![APK_DOWNLOAD_UI_PHASES.AVAILABLE, APK_DOWNLOAD_UI_PHASES.MANUAL].includes(stateRef.current.phase)) {
      return Promise.resolve(stateRef.current.result)
    }

    const currentOptions = optionsRef.current
    const select = currentOptions.selectApk ?? selectAndroidApk
    const controller = new AbortController()
    requestControllerRef.current = controller
    if (mountedRef.current) dispatch({ type: APK_DOWNLOAD_UI_ACTIONS.REQUEST_STARTED })

    const attempt = Promise.resolve()
      .then(() => select(operationOptions(currentOptions, controller.signal, true)))
      .catch(() => unavailableResult())
      .then(result => {
        if (mountedRef.current && !controller.signal.aborted) {
          const now = typeof currentOptions.now === 'function' ? currentOptions.now() : Date.now()
          dispatch({ type: APK_DOWNLOAD_UI_ACTIONS.REQUEST_SETTLED, result, now })
        }
        return result
      })
      .finally(() => {
        if (requestInFlightRef.current === attempt) requestInFlightRef.current = null
        if (requestControllerRef.current === controller) requestControllerRef.current = null
      })

    requestInFlightRef.current = attempt
    return attempt
  }, [])

  const retry = useCallback(() => runCheck(), [runCheck])

  const handleManualDownload = useCallback(event => {
    const current = stateRef.current
    const now = typeof optionsRef.current.now === 'function' ? optionsRef.current.now() : Date.now()
    if (androidApkAvailabilityRequiresRevalidation(current, now)) {
      event.preventDefault()
      void requestDownload()
    }
  }, [requestDownload])

  useEffect(() => {
    mountedRef.current = true
    void runCheck()
    return () => {
      mountedRef.current = false
      checkInFlightRef.current = null
      requestInFlightRef.current = null
      checkControllerRef.current?.abort()
      requestControllerRef.current?.abort()
    }
  }, [runCheck])

  useEffect(() => {
    const documentLike = optionsRef.current.document ?? globalThis.document
    if (typeof documentLike?.addEventListener !== 'function') return undefined

    const handleVisibilityChange = () => {
      if (documentLike.hidden) {
        wasHiddenRef.current = true
      } else if (wasHiddenRef.current) {
        wasHiddenRef.current = false
        dispatch({ type: APK_DOWNLOAD_UI_ACTIONS.MARK_STALE })
      }
    }

    documentLike.addEventListener('visibilitychange', handleVisibilityChange)
    return () => documentLike.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  return {
    ...state,
    ariaBusy: state.phase === APK_DOWNLOAD_UI_PHASES.CHECKING
      || state.phase === APK_DOWNLOAD_UI_PHASES.REQUESTING,
    statusMessage: apkDownloadStatusMessage(state),
    requestDownload,
    retry,
    handleManualDownload,
  }
}
