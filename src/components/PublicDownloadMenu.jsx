import React, { useEffect, useRef, useState } from 'react'
import { Download, Menu, X } from 'lucide-react'
import { selectAndroidApk } from './pwaInstallSelection.js'

function PublicDownloadMenu() {
  const [open, setOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined

    const closeOutside = event => {
      if (!menuRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const downloadApp = () => {
    setOpen(false)
    selectAndroidApk(document)
  }

  return (
    <div ref={menuRef} className="fixed right-4 top-4 z-[130]">
      <button
        type="button"
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
          className="absolute right-0 mt-2 w-52 overflow-hidden rounded-xl border border-[#2a2a5a] bg-[#12122a] p-2 shadow-2xl"
        >
          <button
            type="button"
            role="menuitem"
            data-pwa-install
            onClick={downloadApp}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium text-gray-200 transition-colors hover:bg-[#2a2a5a]/60 hover:text-white"
          >
            <Download size={19} aria-hidden="true" />
            <span>Download App</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default PublicDownloadMenu
