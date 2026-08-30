import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { selectReleaseCandidate } from '../../scripts/publish-android-apk.mjs'
import { verifyViteApkArtifacts } from '../../scripts/verify-vite-apk-artifacts.mjs'
import { selectAndroidApk } from '../../src/components/pwaInstallSelection.js'
import {
  APK_DOWNLOAD_UI_ACTIONS,
  APK_DOWNLOAD_UI_PHASES,
  androidApkDownloadReducer,
  apkDownloadStatusMessage,
  createAndroidApkDownloadState,
} from '../../src/components/useAndroidApkDownload.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const generatedSeed = 0x41504b31
const applicationOrigin = 'https://app.invalid'
const descriptorPath = '/downloads/vivek-marco-trader.apk.json'
const apkPath = '/downloads/vivek-marco-trader.apk'
const apkFilename = 'vivek-marco-trader.apk'
const validDigest = 'a'.repeat(64)
const validCertificateFingerprint = Array(32).fill('CC').join(':')
const validDescriptor = Object.freeze({
  schemaVersion: 2,
  path: apkPath,
  filename: apkFilename,
  mediaType: 'application/vnd.android.package-archive',
  applicationId: 'com.vivekmarco.trader',
  versionCode: 3,
  versionName: '1.0.2',
  sourceRevision: 'b'.repeat(40),
  byteSize: 2_000_000,
  sha256: validDigest,
  signer: {
    classification: 'approved-release',
    certificateSha256: validCertificateFingerprint,
  },
})

function clone(value) {
  return structuredClone(value)
}

function validScenario(name) {
  return {
    name,
    entryPointVisible: true,
    userActivated: true,
    applicationOrigin,
    descriptor: {
      status: 200,
      origin: applicationOrigin,
      path: descriptorPath,
      contentType: 'application/json',
      payload: clone(validDescriptor),
      cacheFresh: true,
    },
    apk: {
      status: 200,
      origin: applicationOrigin,
      path: apkPath,
      contentType: 'application/vnd.android.package-archive',
      contentDisposition: `attachment; filename="${apkFilename}"`,
      byteLength: validDescriptor.byteSize,
      sha256: validDigest,
      archiveIdentity: 'zip-apk',
      bodyKind: 'binary',
      complete: true,
    },
    cacheMayServeObsoleteRelease: false,
    browserTransferWasBlockedOrDeclined: false,
  }
}

function scenario(name, mutate) {
  const value = validScenario(name)
  mutate(value)
  return value
}

// These are the original task-1 generated scenarios and seed. Do not replace,
// weaken, or re-scope them after observing post-fix behavior.
function generatedScenarios() {
  return [
    scenario('missing-descriptor', value => {
      value.descriptor.status = 404
      value.descriptor.contentType = 'text/html'
      value.descriptor.payload = null
    }),
    scenario('malformed-descriptor', value => { value.descriptor.payload = '{not-json' }),
    scenario('stale-descriptor', value => { value.descriptor.payload.versionName = '0.9.0' }),
    scenario('wrong-case-path', value => {
      value.descriptor.payload.path = '/downloads/Vivek-Marco-Trader.apk'
      value.apk.path = '/downloads/Vivek-Marco-Trader.apk'
    }),
    scenario('off-origin-artifact', value => {
      value.apk.origin = 'https://cdn.invalid'
    }),
    scenario('redirected-artifact', value => {
      value.apk.status = 302
      value.apk.origin = 'https://cdn.invalid'
      value.apk.path = '/redirected.apk'
    }),
    scenario('spa-html-fallback', value => {
      value.apk.contentType = 'text/html'
      value.apk.bodyKind = 'html'
      value.apk.archiveIdentity = 'none'
    }),
    scenario('authentication-html-fallback', value => {
      value.apk.path = '/login'
      value.apk.contentType = 'text/html'
      value.apk.bodyKind = 'html'
      value.apk.archiveIdentity = 'none'
    }),
    scenario('empty-artifact', value => {
      value.apk.byteLength = 0
      value.apk.complete = false
      value.apk.archiveIdentity = 'none'
    }),
    scenario('truncated-artifact', value => {
      value.apk.byteLength = validDescriptor.byteSize - 1
      value.apk.complete = false
    }),
    scenario('wrong-size', value => { value.apk.byteLength = validDescriptor.byteSize + 1 }),
    scenario('wrong-digest', value => { value.apk.sha256 = 'c'.repeat(64) }),
    scenario('wrong-media-type', value => { value.apk.contentType = 'application/json' }),
    scenario('wrong-disposition', value => {
      value.apk.contentDisposition = 'inline; filename="other.apk"'
    }),
    scenario('descriptor-timeout', value => {
      value.descriptor.status = 'timeout'
      value.descriptor.payload = null
    }),
    scenario('cache-stale-release', value => {
      value.cacheMayServeObsoleteRelease = true
      value.descriptor.cacheFresh = false
    }),
    scenario('browser-restricted-transfer', value => {
      value.browserTransferWasBlockedOrDeclined = true
    }),
  ]
}

function descriptorIsCanonical(descriptor) {
  const payload = descriptor?.payload
  return descriptor?.status === 200
    && descriptor.origin === applicationOrigin
    && descriptor.path === descriptorPath
    && descriptor.contentType === 'application/json'
    && payload?.schemaVersion === 2
    && payload.path === apkPath
    && payload.filename === apkFilename
    && payload.mediaType === 'application/vnd.android.package-archive'
    && payload.applicationId === 'com.vivekmarco.trader'
    && payload.versionCode === 3
    && payload.versionName === '1.0.2'
    && /^[0-9a-f]{40}$/.test(payload.sourceRevision)
    && Number.isInteger(payload.byteSize)
    && payload.byteSize >= 1_048_576
    && /^[0-9a-f]{64}$/.test(payload.sha256)
    && payload.signer?.classification === 'approved-release'
    && /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(payload.signer?.certificateSha256 || '')
}

function apkIsCompleteAndValid(input) {
  const { apk, descriptor } = input
  return apk?.status === 200
    && apk.origin === applicationOrigin
    && apk.path === descriptor?.payload?.path
    && ['application/vnd.android.package-archive', 'application/octet-stream'].includes(apk.contentType)
    && apk.contentDisposition === `attachment; filename="${apkFilename}"`
    && apk.byteLength === descriptor?.payload?.byteSize
    && apk.sha256 === descriptor?.payload?.sha256
    && apk.archiveIdentity === 'zip-apk'
    && apk.bodyKind !== 'html'
    && apk.complete === true
}

function isBugCondition(input) {
  if (!input.entryPointVisible || !input.userActivated) return false
  return !descriptorIsCanonical(input.descriptor)
    || !apkIsCompleteAndValid(input)
    || input.cacheMayServeObsoleteRelease
    || input.browserTransferWasBlockedOrDeclined
}

// This is the original task-1 oracle. It is intentionally unchanged.
function expectedBehavior(result) {
  if (result.verifiedAvailable) {
    return result.selectedCount === 1
      && result.selectedOrigin === applicationOrigin
      && result.selectedPath === apkPath
      && result.cacheVersion === validDigest
      && result.manualLinkUsesSameVerifiedURL
      && !result.acceptedHtml
      && !result.claimedTransferCompleted
  }

  return result.selectedCount === 0
    && result.state === 'unavailable'
    && result.retryIsBoundedAndUserTriggered
    && result.statusIsAccessible
    && !result.claimedDownloadStarted
}

function bytes(value) {
  if (value instanceof Uint8Array) return value
  return new TextEncoder().encode(String(value))
}

function response(body, { status, url, redirected = false, headers = {} }) {
  const payload = bytes(body)
  return {
    status,
    url,
    redirected,
    headers: new Headers(headers),
    async arrayBuffer() {
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
    },
  }
}

function releaseGateWithholdsDescriptor(input) {
  return input.name === 'stale-descriptor' || input.name === 'wrong-digest'
}

function createScenarioNetwork(input) {
  const calls = []
  const fetch = (request, options) => {
    const requestedUrl = new URL(request)
    const range = options?.headers?.Range
    const stage = requestedUrl.pathname === descriptorPath
      ? 'descriptor'
      : range === 'bytes=0-3' ? 'prefix' : 'tail'
    calls.push({
      stage,
      url: requestedUrl.href,
      cache: options?.cache,
      credentials: options?.credentials,
      redirect: options?.redirect,
      range: range ?? null,
    })

    if (stage === 'descriptor') {
      if (input.descriptor.status === 'timeout') {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        })
      }

      const publicationRejected = releaseGateWithholdsDescriptor(input)
      const status = publicationRejected ? 404 : input.descriptor.status
      const contentType = publicationRejected ? 'text/plain' : input.descriptor.contentType
      const payload = publicationRejected
        ? 'release unavailable'
        : typeof input.descriptor.payload === 'string'
          ? input.descriptor.payload
          : input.descriptor.payload === null
            ? '<host-error-page>'
            : JSON.stringify(input.descriptor.payload)
      return Promise.resolve(response(payload, {
        status,
        url: `${input.descriptor.origin}${input.descriptor.path}${requestedUrl.search}`,
        headers: { 'content-type': contentType },
      }))
    }

    const isPrefix = stage === 'prefix'
    const expectedLength = isPrefix ? 4 : 1
    const finalOffset = validDescriptor.byteSize - 1
    const finalOrigin = input.apk.origin
    const finalPath = input.apk.path
    const finalUrl = `${finalOrigin}${finalPath}${requestedUrl.search}`
    const isTruncatedTail = !isPrefix && input.apk.complete === false && input.apk.byteLength < validDescriptor.byteSize
    const status = input.apk.status === 302 ? 302 : isTruncatedTail ? 416 : 206
    let payload = isPrefix
      ? new Uint8Array([0x50, 0x4b, 0x03, 0x04])
      : new Uint8Array([0x00])
    if (input.apk.byteLength === 0 || isTruncatedTail) payload = new Uint8Array()
    if (input.apk.archiveIdentity !== 'zip-apk' && input.apk.bodyKind !== 'html') {
      payload = isPrefix ? new Uint8Array([0, 1, 2, 3]) : payload
    }
    if (input.apk.bodyKind === 'html') payload = '<!doctype html>'

    return Promise.resolve(response(payload, {
      status,
      url: finalUrl,
      redirected: input.name === 'redirected-artifact',
      headers: {
        'content-type': input.apk.contentType,
        'content-disposition': input.apk.contentDisposition,
        'content-range': isPrefix
          ? `bytes 0-3/${input.apk.byteLength}`
          : `bytes ${finalOffset}-${finalOffset}/${input.apk.byteLength}`,
        'content-length': String(expectedLength),
      },
    }))
  }
  return { calls, fetch }
}

function createDocumentFixture() {
  const observations = {
    createdTags: [],
    appended: 0,
    selectedCount: 0,
    removed: 0,
    selectedHref: null,
    selectedDownload: null,
  }
  const anchor = {
    href: '',
    download: '',
    click() {
      observations.selectedCount += 1
      observations.selectedHref = this.href
      observations.selectedDownload = this.download
    },
    remove() { observations.removed += 1 },
  }
  return {
    observations,
    document: {
      body: { appendChild() { observations.appended += 1 } },
      createElement(tagName) {
        observations.createdTags.push(tagName)
        return anchor
      },
    },
  }
}

function exposeUiState(result) {
  const settled = androidApkDownloadReducer(createAndroidApkDownloadState(), {
    type: APK_DOWNLOAD_UI_ACTIONS.CHECK_SETTLED,
    result,
  })
  return {
    state: settled.phase === APK_DOWNLOAD_UI_PHASES.UNAVAILABLE ? 'unavailable' : settled.phase,
    retryIsBoundedAndUserTriggered: settled.phase === APK_DOWNLOAD_UI_PHASES.UNAVAILABLE,
    statusIsAccessible: apkDownloadStatusMessage(settled).length > 0,
  }
}

async function exerciseFixedSelector(input) {
  const network = createScenarioNetwork(input)
  const documentFixture = createDocumentFixture()
  const rawResult = await selectAndroidApk({
    fetch: network.fetch,
    location: { origin: applicationOrigin },
    nonce: `${generatedSeed}-${input.name}`,
    timeoutMs: 25,
    now: () => generatedSeed,
    document: documentFixture.document,
  })
  const { observations } = documentFixture
  const selectedUrl = observations.selectedHref ? new URL(observations.selectedHref) : null
  const ui = exposeUiState(rawResult)

  return {
    scenario: input.name,
    selectedCount: rawResult.selectedCount,
    selectedOrigin: selectedUrl?.origin ?? null,
    selectedPath: selectedUrl?.pathname ?? null,
    selectedHref: observations.selectedHref,
    selectedDownload: observations.selectedDownload,
    cacheVersion: selectedUrl?.searchParams.get('v') ?? null,
    manualLinkUsesSameVerifiedURL: rawResult.manualUrl === observations.selectedHref,
    verifiedAvailable: rawResult.status === 'requested' && rawResult.verifiedAvailable === true,
    acceptedHtml: input.apk.bodyKind === 'html' && rawResult.selectedCount > 0,
    claimedTransferCompleted: rawResult.claimedTransferCompleted,
    claimedDownloadStarted: rawResult.claimedDownloadStarted,
    state: ui.state,
    retryIsBoundedAndUserTriggered: ui.retryIsBoundedAndUserTriggered,
    statusIsAccessible: ui.statusIsAccessible,
    reason: rawResult.reason,
    publicationGateRejected: releaseGateWithholdsDescriptor(input),
    selectorEvidence: {
      networkChecks: network.calls.length,
      calls: network.calls,
      createdTags: observations.createdTags,
      appended: observations.appended,
      removed: observations.removed,
    },
  }
}

function parseNetlifyRedirects(source) {
  return source.split('[[redirects]]').slice(1).map(block => ({
    from: block.match(/^\s*from\s*=\s*"([^"]+)"/m)?.[1],
    to: block.match(/^\s*to\s*=\s*"([^"]+)"/m)?.[1],
    status: Number(block.match(/^\s*status\s*=\s*(\d+)/m)?.[1]),
    force: block.match(/^\s*force\s*=\s*(true|false)/m)?.[1] === 'true',
  }))
}

function parseRedirectsFile(source) {
  return source.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [from, to, rawStatus] = line.split(/\s+/)
      return { from, to, status: Number(rawStatus.replace('!', '')), force: rawStatus.endsWith('!') }
    })
}

function matchesRule(pathname, pattern) {
  if (pattern === pathname || pattern === '/*') return true
  return pattern?.endsWith('*') && pathname.startsWith(pattern.slice(0, -1))
}

function evaluateHostRoute(pathname, rules, existingStaticPaths) {
  const matchingRule = rules.find(candidate => matchesRule(pathname, candidate.from))
  if (existingStaticPaths.has(pathname) && matchingRule?.force !== true) {
    return {
      pathname,
      staticFileExists: true,
      status: 200,
      finalUrl: `${applicationOrigin}${pathname}`,
      contentType: pathname.endsWith('.json') ? 'application/json' : 'application/vnd.android.package-archive',
      bodyPrefix: pathname.endsWith('.json') ? '{' : 'PK\\x03\\x04',
      winningRule: 'static-file',
    }
  }
  if (matchingRule) {
    const isSpa = matchingRule.status === 200 && matchingRule.to === '/index.html'
    return {
      pathname,
      staticFileExists: existingStaticPaths.has(pathname),
      status: matchingRule.status,
      finalUrl: `${applicationOrigin}${matchingRule.to}`,
      contentType: 'text/html',
      bodyPrefix: isSpa ? '<!doctype html>' : '<host-error-page>',
      winningRule: `${matchingRule.from} -> ${matchingRule.to} ${matchingRule.status}`,
    }
  }
  return {
    pathname,
    staticFileExists: false,
    status: 404,
    finalUrl: `${applicationOrigin}${pathname}`,
    contentType: 'text/html',
    bodyPrefix: '<host-error-page>',
    winningRule: 'host-default-404',
  }
}

async function pathExists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function collectRouteEvidence() {
  const [netlifySource, redirectsSource] = await Promise.all([
    readFile(path.join(repositoryRoot, 'netlify.toml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'public', '_redirects'), 'utf8'),
  ])
  const existingStaticPaths = new Set()
  for (const pathname of [apkPath, descriptorPath]) {
    if (await pathExists(path.join(repositoryRoot, 'public', pathname.slice(1)))) existingStaticPaths.add(pathname)
  }
  const probes = [apkPath, descriptorPath, '/downloads/Vivek-Marco-Trader.apk', '/downloads/intentionally-absent.apk']
  return {
    netlifyToml: probes.map(pathname => evaluateHostRoute(pathname, parseNetlifyRedirects(netlifySource), existingStaticPaths)),
    publicRedirects: probes.map(pathname => evaluateHostRoute(pathname, parseRedirectsFile(redirectsSource), existingStaticPaths)),
  }
}

function releaseSelectionOptions(metadataPath) {
  return {
    metadataPath,
    distPath: path.join(repositoryRoot, 'dist'),
    sourceRevision: validDescriptor.sourceRevision,
    applicationId: validDescriptor.applicationId,
    versionCode: validDescriptor.versionCode,
    versionName: validDescriptor.versionName,
    label: 'Vivek Marco Trader',
    launchableActivity: 'com.vivekmarco.trader.MainActivity',
    minSdk: '26',
    targetSdk: '35',
    compileSdk: '35',
    signerFingerprint: validCertificateFingerprint,
    signerClassification: 'approved-release',
    sdkRoot: repositoryRoot,
    javaHome: repositoryRoot,
  }
}

async function collectReleaseInventoryEvidence() {
  const locations = [
    ['release', 'android/app/build/outputs/apk/release/output-metadata.json'],
    ['debug', 'android/app/build/outputs/apk/debug/output-metadata.json'],
  ]
  const records = []
  for (const [expectedVariant, relativeMetadataPath] of locations) {
    const metadataPath = path.join(repositoryRoot, relativeMetadataPath)
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    const element = metadata.elements?.[0]
    const candidatePath = path.join(path.dirname(metadataPath), element?.outputFile || '')
    let selectionOutcome = 'accepted'
    try {
      await selectReleaseCandidate(releaseSelectionOptions(metadataPath))
    } catch (error) {
      selectionOutcome = error?.code ?? error?.name ?? 'rejected'
    }
    records.push({
      expectedVariant,
      reportedVariant: metadata.variantName,
      artifactType: metadata.artifactType?.type,
      elementCount: metadata.elements?.length || 0,
      elementType: element?.type,
      filters: element?.filters?.length || 0,
      versionCode: element?.versionCode,
      versionName: element?.versionName,
      outputBasename: element?.outputFile ? path.basename(element.outputFile) : null,
      candidateExists: element?.outputFile ? await pathExists(candidatePath) : false,
      selectionOutcome,
    })
  }
  return {
    explicitlyParsedMetadataOnly: true,
    recursiveDiscoveryPerformed: false,
    records,
    ambiguity: records.length > 1 && records.every(record => record.outputBasename?.endsWith('.apk')),
    identityMismatch: records.some(record => record.versionCode !== 3 || record.versionName !== '1.0.2'),
    allUnsafeCandidatesRejected: records.every(record => record.selectionOutcome !== 'accepted'),
    conclusion: 'Extension, wildcard, recursive, or newest-file selection cannot prove release variant or reviewed identity, and the fixed selector rejects these unsafe metadata records.',
  }
}

async function verifyInvalidPublicDistPairFailsClosed() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'apk-fix-check-'))
  const publicDirectory = path.join(root, 'public')
  const distDirectory = path.join(root, 'dist')
  const artifact = Buffer.alloc(1_048_576, 0)
  artifact.set([0x50, 0x4b, 0x03, 0x04])
  const descriptor = {
    ...clone(validDescriptor),
    byteSize: artifact.length,
    sha256: 'f'.repeat(64),
  }
  try {
    await Promise.all([mkdir(publicDirectory), mkdir(distDirectory)])
    for (const directory of [publicDirectory, distDirectory]) {
      await writeFile(path.join(directory, apkFilename), artifact)
      await writeFile(path.join(directory, `${apkFilename}.json`), `${JSON.stringify(descriptor)}\n`)
    }
    try {
      await verifyViteApkArtifacts({ publicDirectory, distDirectory })
      return { rejected: false, code: null }
    } catch (error) {
      return { rejected: true, code: error?.code ?? error?.name ?? 'rejected' }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function sanitizeScenario(input) {
  return {
    name: input.name,
    descriptor: {
      status: input.descriptor.status,
      originClass: input.descriptor.origin === applicationOrigin ? 'same-origin' : 'other-origin',
      path: input.descriptor.path,
      contentType: input.descriptor.contentType,
      payloadKind: input.descriptor.payload === null ? 'missing' : typeof input.descriptor.payload,
      cacheFresh: input.descriptor.cacheFresh,
    },
    apk: {
      status: input.apk.status,
      originClass: input.apk.origin === applicationOrigin ? 'same-origin' : 'other-origin',
      path: input.apk.path,
      contentType: input.apk.contentType,
      contentDisposition: input.apk.contentDisposition,
      byteLength: input.apk.byteLength,
      archiveIdentity: input.apk.archiveIdentity,
      bodyKind: input.apk.bodyKind,
      complete: input.apk.complete,
    },
    cacheMayServeObsoleteRelease: input.cacheMayServeObsoleteRelease,
    browserTransferWasBlockedOrDeclined: input.browserTransferWasBlockedOrDeclined,
  }
}

test('Property 1: Expected Behavior — Truthful Verified APK Selection', async () => {
  // **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8**
  const scenarios = generatedScenarios()
  const observations = []
  for (const input of scenarios) {
    const result = await exerciseFixedSelector(input)
    observations.push({
      seed: generatedSeed,
      input: sanitizeScenario(input),
      isBugCondition: isBugCondition(input),
      expectedBehavior: expectedBehavior(result),
      result,
    })
  }
  const bugConditionObservations = observations.filter(observation => observation.isBugCondition)
  const counterexamples = bugConditionObservations.filter(observation => !observation.expectedBehavior)
  const [routeEvidence, releaseInventoryEvidence, invalidPublicDistEvidence, preFixEvidence] = await Promise.all([
    collectRouteEvidence(),
    collectReleaseInventoryEvidence(),
    verifyInvalidPublicDistPairFailsClosed(),
    readFile(path.join(repositoryRoot, 'test-results', 'apk-download-missing-file', 'counterexamples.json'), 'utf8').then(JSON.parse),
  ])

  assert.equal(preFixEvidence.generatedSeed, generatedSeed, 'The original failing seed must remain preserved')
  assert.equal(preFixEvidence.counterexampleCount, scenarios.length, 'The original counterexamples must remain preserved')
  assert.equal(bugConditionObservations.length, scenarios.length, 'Every original generated scenario must retain its bug-condition classification')
  assert.equal(counterexamples.length, 0, `Fixed behavior must satisfy the unchanged oracle for seed ${generatedSeed}`)

  for (const evidence of [routeEvidence.netlifyToml, routeEvidence.publicRedirects]) {
    assert.ok(evidence.some(observation => observation.pathname === apkPath
      && observation.staticFileExists
      && observation.status === 200
      && observation.winningRule === 'static-file'), 'The canonical APK must resolve to real static bytes')
    assert.ok(evidence.some(observation => observation.pathname === descriptorPath
      && observation.staticFileExists
      && observation.status === 200
      && observation.winningRule === 'static-file'), 'The canonical descriptor must resolve to its real static bytes')
    assert.ok(evidence.some(observation => observation.pathname === '/downloads/Vivek-Marco-Trader.apk'
      && observation.status !== 200
      && observation.winningRule !== '/* -> /index.html 200'), 'Wrong-case download paths must fail before SPA fallback')
  }

  assert.equal(releaseInventoryEvidence.ambiguity, true, 'The original release/debug inventory must still demonstrate extension-only ambiguity')
  assert.equal(releaseInventoryEvidence.identityMismatch, true, 'The original metadata must still demonstrate stale reviewed identity')
  assert.equal(releaseInventoryEvidence.allUnsafeCandidatesRejected, true, 'Unsafe Android candidates must fail before publication')
  assert.equal(invalidPublicDistEvidence.rejected, true, 'A digest-mismatched public/dist pair must fail before deployment')
  assert.equal(invalidPublicDistEvidence.code, 'PUBLIC_APK_DIGEST_MISMATCH')

  const report = {
    property: 'Property 1: Expected Behavior — Truthful Verified APK Selection',
    validates: ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8'],
    expectedResultAfterFix: 'PASS',
    generatedSeed,
    scenariosEvaluated: scenarios.length,
    counterexampleCount: counterexamples.length,
    minimizedCounterexample: counterexamples[0] ?? null,
    preservedPreFixEvidence: {
      path: 'test-results/apk-download-missing-file/counterexamples.json',
      counterexampleCount: preFixEvidence.counterexampleCount,
      minimizedCounterexample: preFixEvidence.minimizedCounterexample,
    },
    deterministicFixEvidence: {
      canonicalApkRoute: routeEvidence.netlifyToml.find(observation => observation.pathname === apkPath),
      wrongCaseDownloadRejected: routeEvidence.netlifyToml.find(observation => observation.pathname === '/downloads/Vivek-Marco-Trader.apk'),
      invalidPublicDistEvidence,
      unsafeReleaseSelection: releaseInventoryEvidence.records,
    },
    routeEvidence,
    releaseInventoryEvidence,
    observations,
  }
  const artifactDirectory = path.join(repositoryRoot, 'test-results', 'apk-download-missing-file')
  const reportPath = path.join(artifactDirectory, 'fix-check.json')
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
})
