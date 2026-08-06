export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    }).then(registration => {
      registration.update().catch(() => undefined)
    }).catch(error => {
      console.error('Service worker registration failed:', error)
    })
  }, { once: true })
}
