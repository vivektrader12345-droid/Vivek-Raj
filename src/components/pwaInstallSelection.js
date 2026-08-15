export const ANDROID_APK_PATH = '/downloads/vivek-marco-trader.apk'
export const ANDROID_APK_FILENAME = 'vivek-marco-trader.apk'

function safelyRead(value, key) {
  try {
    return value?.[key]
  } catch {
    return undefined
  }
}

export function classifyAndroidPlatform(navigatorLike) {
  if (navigatorLike == null) return false

  let userAgentData
  try {
    userAgentData = navigatorLike.userAgentData
  } catch {
    return false
  }

  if (userAgentData !== undefined) {
    const platform = safelyRead(userAgentData, 'platform')
    return typeof platform === 'string' && platform.trim().toLowerCase() === 'android'
  }

  const userAgent = safelyRead(navigatorLike, 'userAgent')
  return typeof userAgent === 'string' && /android/i.test(userAgent)
}

export function selectAndroidApk(documentLike) {
  const anchor = documentLike.createElement('a')
  anchor.href = ANDROID_APK_PATH
  anchor.download = ANDROID_APK_FILENAME

  documentLike.body?.appendChild(anchor)

  try {
    anchor.click()
  } finally {
    anchor.remove()
  }
}
