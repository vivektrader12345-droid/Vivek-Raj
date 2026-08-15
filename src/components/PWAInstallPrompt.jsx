import React, { useEffect, useRef, useState } from 'react'
import { Download, MoreVertical, X } from 'lucide-react'
import { classifyAndroidPlatform, selectAndroidApk } from './pwaInstallSelection.js'

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function PWAInstallPrompt() {
  const [installEvent, setInstallEvent] = useState(null)
  const [showInstructions, setShowInstructions] = useState(false)
  const [installed, setInstalled] = useState(() => isStandalone())
  const installButtonRef = useRef(null)
  const dialogRef = useRef(null)
  const closeButtonRef = useRef(null)

  useEffect(() => {
    if (installed) return undefined

    const handleInstallable = event => {
      event.preventDefault()
      setInstallEvent(event)
    }
    const handleInstalled = () => {
      setInstallEvent(null)
      setShowInstructions(false)
      setInstalled(true)
    }

    window.addEventListener('beforeinstallprompt', handleInstallable)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallable)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [installed])

  useEffect(() => {
    if (!showInstructions) return undefined

    const previouslyFocused = document.activeElement
    closeButtonRef.current?.focus()

    const handleKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setShowInstructions(false)
        return
      }
      if (event.key !== 'Tab') return

      const focusable = [...(dialogRef.current?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || [])]
        .filter(element => !element.disabled && element.getAttribute('aria-hidden') !== 'true')
      if (!focusable.length) {
        event.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      const focusTarget = previouslyFocused?.isConnected ? previouslyFocused : installButtonRef.current
      window.requestAnimationFrame(() => focusTarget?.focus())
    }
  }, [showInstructions])

  if (installed) return null

  const downloadApp = async () => {
    if (classifyAndroidPlatform(window.navigator)) {
      selectAndroidApk(document)
      return
    }

    if (!installEvent) {
      setShowInstructions(true)
      return
    }

    const promptEvent = installEvent
    setInstallEvent(null)
    await promptEvent.prompt()
    const choice = await promptEvent.userChoice
    if (choice.outcome !== 'accepted') setShowInstructions(true)
  }

  return (
    <>
      <button
        type="button"
        data-pwa-install
        ref={installButtonRef}
        onClick={downloadApp}
        aria-haspopup={installEvent ? undefined : 'dialog'}
        className="fixed bottom-4 right-4 z-[125] flex items-center gap-2 rounded-full border border-[#e94560]/50 bg-gradient-to-r from-[#e94560] to-[#f5a623] px-4 py-3 text-sm font-bold text-white shadow-2xl shadow-black/50 transition-transform hover:scale-105 active:scale-95"
      >
        <Download size={18} aria-hidden="true" /> Download App
      </button>

      {showInstructions && (
        <div className="fixed inset-0 z-[140] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center" role="presentation">
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pwa-install-title"
            className="relative w-full max-w-md rounded-2xl border border-[#2a2a5a] bg-[#0a0a1f] p-5 text-white shadow-2xl"
          >
            <button
              type="button"
              ref={closeButtonRef}
              aria-label="Close install instructions"
              onClick={() => setShowInstructions(false)}
              className="absolute right-3 top-3 rounded-lg p-2 text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X size={18} />
            </button>

            <div className="flex items-center gap-3 pr-8">
              <img src="/icons/icon-192.png" alt="" className="h-14 w-14 rounded-xl" />
              <div>
                <h2 id="pwa-install-title" className="font-semibold">Install Vivek Marco Trader</h2>
                <p className="mt-1 text-xs text-gray-400">Chrome ne abhi automatic install dialog offer nahi kiya.</p>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-[#0f3460] bg-[#060612] p-4">
              <p className="text-sm font-semibold text-[#f5a623]">Android Chrome par:</p>
              <ol className="mt-3 space-y-3 text-sm text-gray-300">
                <li className="flex gap-3"><span className="font-bold text-white">1.</span><span>Website ko Chrome browser mein kholen.</span></li>
                <li className="flex gap-3"><span className="font-bold text-white">2.</span><span className="flex items-center gap-1">Top-right <MoreVertical size={17} aria-label="three-dot menu" /> menu dabayein.</span></li>
                <li className="flex gap-3"><span className="font-bold text-white">3.</span><span><strong className="text-white">Install app</strong> ya <strong className="text-white">Add to Home screen</strong> select karein.</span></li>
              </ol>
            </div>

            <p className="mt-4 text-xs leading-relaxed text-gray-500">
              Install option ke liye latest website HTTPS par aur Chrome mein khuli honi chahiye. WhatsApp ya Instagram ke internal browser se Chrome mein open karein.
            </p>
            <button
              type="button"
              onClick={() => setShowInstructions(false)}
              className="mt-4 w-full rounded-xl bg-[#0f3460] px-4 py-3 text-sm font-semibold text-white hover:bg-[#16457d]"
            >
              Theek Hai
            </button>
          </section>
        </div>
      )}
    </>
  )
}

export default PWAInstallPrompt
