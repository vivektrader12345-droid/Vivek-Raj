import React, { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function PWAInstallPrompt() {
  const [installEvent, setInstallEvent] = useState(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (isStandalone()) return undefined

    const handleInstallable = event => {
      event.preventDefault()
      setInstallEvent(event)
      setDismissed(false)
    }
    const handleInstalled = () => setInstallEvent(null)

    window.addEventListener('beforeinstallprompt', handleInstallable)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallable)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  if (!installEvent || dismissed) return null

  const promptForInstall = async () => {
    await installEvent.prompt()
    await installEvent.userChoice
    setInstallEvent(null)
  }

  return (
    <aside
      role="dialog"
      aria-label="Install Vivek Marco Trader"
      className="fixed bottom-4 left-4 right-4 z-[130] mx-auto max-w-md rounded-2xl border border-[#e94560]/40 bg-[#0a0a1f]/95 p-4 text-white shadow-2xl shadow-black/50 backdrop-blur-xl sm:left-auto"
    >
      <button
        type="button"
        aria-label="Dismiss install prompt"
        onClick={() => setDismissed(true)}
        className="absolute right-3 top-3 rounded-lg p-1 text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X size={17} />
      </button>
      <div className="flex items-start gap-3 pr-7">
        <img src="/icons/icon-192.png" alt="" className="h-12 w-12 rounded-xl" />
        <div>
          <h2 className="text-sm font-semibold">Install Vivek Marco Trader</h2>
          <p className="mt-1 text-xs leading-relaxed text-gray-400">Add the app to your device for standalone access and an offline-ready app shell.</p>
        </div>
      </div>
      <button
        type="button"
        onClick={promptForInstall}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#e94560] to-[#f5a623] px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90"
      >
        <Download size={16} /> Install App
      </button>
    </aside>
  )
}

export default PWAInstallPrompt
