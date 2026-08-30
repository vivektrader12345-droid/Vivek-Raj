import React, { useEffect, useRef, useState } from 'react'
import { Download, Menu, RefreshCw, X } from 'lucide-react'
import useAndroidApkDownload, { APK_DOWNLOAD_UI_PHASES } from './useAndroidApkDownload.js'

function PublicDownloadMenu() {
  const [open, setOpen] = useState(false)
  const menuRef = useRef(null)
  const triggerRef = useRef(null)
  const download = useAndroidApkDownload()

  useEffect(() => {
    if (!open) return undefined

    const closeOutside = event => {
      if (!menuRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      window.requestAnimationFrame(() => triggerRef.current?.focus())
    }

    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const renderDownloadState = () => {
    if (download.phase === APK_DOWNLOAD_UI_PHASES.AVAILABLE) {
      return (
        <button
          type="button"
          role="menuitem"
          data-pwa-install
          onClick={() => { void download.requestDownload() }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium text-gray-200 transition-colors hover:bg-[#2a2a5a]/60 hover:text-white"
        >
          <Download size={19} aria-hidden="true" />
          <span>Download App</span>
        </button>
      )
    }

    if (download.phase === APK_DOWNLOAD_UI_PHASES.UNAVAILABLE) {
      return (
        <div className="rounded-lg px-3 py-2 text-sm text-gray-300">
          <p role="status" aria-live="polite">App download unavailable</p>
          <button
            type="button"
            role="menuitem"
            data-pwa-install
            onClick={() => { void download.retry() }}
            className="mt-2 flex w-full items-center gap-2 rounded-lg border border-[#2a2a5a] px-3 py-2 font-medium text-white transition-colors hover:bg-[#2a2a5a]/60"
          >
            <RefreshCw size={17} aria-hidden="true" /> Retry
          </button>
        </div>
      )
    }

    if (download.phase === APK_DOWNLOAD_UI_PHASES.MANUAL) {
      return (
        <div className="rounded-lg px-3 py-2 text-sm text-gray-300">
          <p role="status" aria-live="polite">{download.statusMessage}</p>
          <p className="mt-1 text-xs text-gray-400">If nothing happens, retry or open this page in a supported browser.</p>
          <a
            role="menuitem"
            data-pwa-install
            href={download.manualUrl}
            download="vivek-marco-trader.apk"
            onClick={download.handleManualDownload}
            className="mt-3 flex w-full items-center gap-2 rounded-lg border border-[#2a2a5a] px-3 py-2 font-medium text-white transition-colors hover:bg-[#2a2a5a]/60"
          >
            <Download size={17} aria-hidden="true" /> Manual download
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => { void download.requestDownload() }}
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 font-medium text-gray-300 transition-colors hover:bg-[#2a2a5a]/60 hover:text-white"
          >
            <RefreshCw size={17} aria-hidden="true" /> Retry
          </button>
        </div>
      )
    }

    return (
      <button
        type="button"
        role="menuitem"
        data-pwa-install
        disabled
        aria-busy="true"
        className="flex w-full cursor-wait items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium text-gray-400"
      >
        <Download size={19} aria-hidden="true" />
        <span role="status" aria-live="polite">
          {download.statusMessage || 'Checking app download availability'}
        </span>
      </button>
    )
  }

  return (
    <div ref={menuRef} className="fixed right-4 top-4 z-[130]">
      <button
        type="button"
        ref={triggerRef}
        data-public-menu-trigger
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="public-download-menu"
        onClick={() => setOpen(value => !value)}
        className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#2a2a5a] bg-[#12122a]/95 text-white shadow-xl backdrop-blur transition-colors hover:border-[#e94560]/60 hover:bg-[#1a1a36]"
      >
        {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
      </button>

      {open && (
        <div
          id="public-download-menu"
          role="menu"
          aria-busy={download.ariaBusy}
          className="absolute right-0 mt-2 w-64 overflow-hidden rounded-xl border border-[#2a2a5a] bg-[#12122a] p-2 shadow-2xl"
        >
          {renderDownloadState()}
        </div>
      )}
    </div>
  )
}

export default PublicDownloadMenu
