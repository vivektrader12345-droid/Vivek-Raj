export const APK_DOWNLOAD_UI_PHASES = Object.freeze({
  IDLE: 'idle', CHECKING: 'checking', REQUESTING: 'requesting', AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable', MANUAL: 'manual',
})

export default function useAndroidApkDownload() {
  return {
    phase: APK_DOWNLOAD_UI_PHASES.AVAILABLE,
    manualUrl: '/downloads/test.apk',
    statusMessage: '',
    retry: async () => {},
  }
}
