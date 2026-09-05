import assert from 'node:assert/strict'
import test from 'node:test'

const selectionModule = new URL('../src/components/pwaInstallSelection.js', import.meta.url)
const APK_PATH = '/downloads/vivek-marco-trader.apk'
const APK_FILENAME = 'vivek-marco-trader.apk'
const ACTIVATE_DOWNLOAD_APP = 'activate-download-app'

function safelyRead(value, key) {
  try {
    return value?.[key]
  } catch {
    return undefined
  }
}

function isBugCondition(input) {
  if (!input?.visible || input.isStandalone || input.action !== ACTIVATE_DOWNLOAD_APP) return false

  const navigatorLike = input.navigator
  if (!navigatorLike || typeof navigatorLike !== 'object') return false

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

function expectedBehavior(result) {
  return result?.selectedPath === APK_PATH
    && result.apkSelectionCount === 1
    && result.pwaPromptInvocationCount === 0
    && result.instructionsOpened === false
}

function withAlternatingCase(value, offset) {
  return [...value]
    .map((character, index) => ((index + offset) % 2 === 0 ? character.toUpperCase() : character.toLowerCase()))
    .join('')
}

function createDocumentFixture(seed) {
  const observations = {
    createdTags: [],
    appendedAnchors: [],
    clickCount: 0,
    removeCount: 0,
  }
  const anchor = {
    href: `initial-${seed}`,
    download: `initial-${seed}`,
    click() { observations.clickCount += 1 },
    remove() { observations.removeCount += 1 },
  }
  const documentLike = {
    body: {
      appendChild(element) { observations.appendedAnchors.push(element) },
    },
    createElement(tagName) {
      observations.createdTags.push(tagName)
      return anchor
    },
  }
  return { anchor, documentLike, observations }
}

test('Property 1 oracle encodes the Android bug condition and required direct-selection result', () => {
  // **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
  const activation = navigator => ({
    action: ACTIVATE_DOWNLOAD_APP,
    isStandalone: false,
    visible: true,
    navigator,
  })

  assert.equal(isBugCondition(activation({ userAgentData: { platform: '  AnDrOiD  ' }, userAgent: 'Desktop' })), true)
  assert.equal(isBugCondition(activation({ userAgent: 'Mozilla/5.0 (Linux; aNdRoId 14)' })), true)
  assert.equal(isBugCondition(activation({ userAgentData: { platform: 'Windows' }, userAgent: 'Android' })), false)
  assert.equal(isBugCondition(activation({ userAgentData: { platform: '' }, userAgent: 'Android' })), false)
  assert.equal(isBugCondition({ ...activation({ userAgent: 'Android' }), isStandalone: true }), false)
  assert.equal(isBugCondition({ ...activation({ userAgent: 'Android' }), visible: false }), false)
  assert.equal(isBugCondition({ ...activation({ userAgent: 'Android' }), action: 'other-action' }), false)

  assert.equal(expectedBehavior({
    selectedPath: APK_PATH,
    apkSelectionCount: 1,
    pwaPromptInvocationCount: 0,
    instructionsOpened: false,
  }), true)
})

test('Property 1 classifier is total and conservatively identifies generated Android evidence', async () => {
  // **Validates: Requirements 2.1, 2.2, 2.3**
  const { classifyAndroidPlatform } = await import(selectionModule)
  const fixtures = []

  for (let seed = 0; seed < 8; seed += 1) {
    const platform = `${' '.repeat(seed % 3)}${withAlternatingCase('android', seed)}${' '.repeat((seed + 1) % 3)}`
    fixtures.push({
      name: `generated authoritative Android client hint ${seed}`,
      navigator: { userAgentData: { platform, mobile: seed % 2 === 0 }, userAgent: seed % 2 ? 'Android-looking contradiction' : 'Synthetic desktop UA' },
      expected: true,
    })

    const userAgentAndroid = withAlternatingCase('android', seed + 1)
    fixtures.push({
      name: `generated legacy Android user-agent fallback ${seed}`,
      navigator: { userAgent: `Mozilla/5.0 (Linux; ${userAgentAndroid} ${10 + seed}; Device-${seed})` },
      expected: true,
    })
  }

  fixtures.push(
    {
      name: 'authoritative non-Android hint wins over Android-looking user agent',
      navigator: { userAgentData: { platform: 'Windows' }, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
      expected: false,
    },
    {
      name: 'empty client hint is uncertain and blocks contradictory fallback',
      navigator: { userAgentData: { platform: '   ' }, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
      expected: false,
    },
    {
      name: 'partial client hint is uncertain',
      navigator: { userAgentData: {}, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
      expected: false,
    },
    {
      name: 'non-string client hint is uncertain',
      navigator: { userAgentData: { platform: { value: 'Android' } }, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
      expected: false,
    },
    { name: 'missing navigator', navigator: undefined, expected: false },
    { name: 'partial navigator', navigator: {}, expected: false },
    { name: 'non-string legacy user agent', navigator: { userAgent: 14 }, expected: false },
    {
      name: 'unsupported client-hint access never throws or falls back',
      navigator: {
        get userAgentData() { throw new Error('unsupported userAgentData') },
        userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      },
      expected: false,
    },
    {
      name: 'throwing client-hint platform never throws or falls back',
      navigator: {
        userAgentData: { get platform() { throw new Error('unsupported platform') } },
        userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      },
      expected: false,
    },
    {
      name: 'throwing legacy user-agent access never throws',
      navigator: { get userAgent() { throw new Error('unsupported userAgent') } },
      expected: false,
    },
  )

  for (const fixture of fixtures) {
    assert.doesNotThrow(() => classifyAndroidPlatform(fixture.navigator), fixture.name)
    assert.equal(classifyAndroidPlatform(fixture.navigator), fixture.expected, fixture.name)
  }
})

test('Property 1 activation uses one verified digest-versioned same-origin URL and removes its temporary anchor', async () => {
  // **Validates: Requirements 2.1, 2.2, 2.4, 2.6**
  const {
    ANDROID_APK_FILENAME,
    ANDROID_APK_PATH,
    activateAndroidApk,
  } = await import(selectionModule)
  const descriptor = {
    schemaVersion: 2,
    path: APK_PATH,
    filename: APK_FILENAME,
    mediaType: 'application/vnd.android.package-archive',
    applicationId: 'com.vivekmarco.trader',
    versionCode: 3,
    versionName: '1.0.2',
    sourceRevision: 'a'.repeat(40),
    byteSize: 2_000_000,
    sha256: 'b'.repeat(64),
    signer: {
      classification: 'approved-release',
      certificateSha256: Array(32).fill('CC').join(':'),
    },
  }
  const expectedUrl = `https://app.invalid${APK_PATH}?v=${descriptor.sha256}&download=1`

  assert.equal(ANDROID_APK_PATH, APK_PATH)
  assert.equal(ANDROID_APK_FILENAME, APK_FILENAME)

  for (let seed = 0; seed < 6; seed += 1) {
    const { anchor, documentLike, observations } = createDocumentFixture(seed)
    const result = activateAndroidApk({
      descriptor,
      document: documentLike,
      location: { origin: 'https://app.invalid' },
      url: expectedUrl,
    })

    assert.equal(result.status, 'requested', `requested result for generated fixture ${seed}`)
    assert.equal(result.manualUrl, expectedUrl, `manual recovery URL for generated fixture ${seed}`)
    assert.equal(result.claimedTransferCompleted, false, `no completion claim for generated fixture ${seed}`)
    assert.deepEqual(observations.createdTags, ['a'], `created tag for generated fixture ${seed}`)
    assert.equal(anchor.href, expectedUrl, `versioned href for generated fixture ${seed}`)
    assert.equal(anchor.download, APK_FILENAME, `stable filename for generated fixture ${seed}`)
    assert.equal(observations.clickCount, 1, `single click for generated fixture ${seed}`)
    assert.equal(observations.removeCount, 1, `single cleanup for generated fixture ${seed}`)
    assert.equal(observations.appendedAnchors.length, 1, `one temporary append for generated fixture ${seed}`)
    assert.equal(observations.appendedAnchors[0], anchor)
  }
})
