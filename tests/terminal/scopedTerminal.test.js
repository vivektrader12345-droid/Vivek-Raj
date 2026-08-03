import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const terminalEntryPath = path.join(repositoryRoot, 'src', 'trading', 'ProTrading.jsx')
const terminalStylesPath = path.join(repositoryRoot, 'src', 'trading', 'ProTradingTerminal.css')
const globalStylesPath = path.join(repositoryRoot, 'src', 'index.css')
const boundaryPath = path.join(repositoryRoot, 'src', 'trading', 'components', 'TerminalFeatureBoundary.jsx')

const approvedLayers = new Map([
  ['--pro-layer-chart-canvas', '0'],
  ['--pro-layer-chart-primitives', '10'],
  ['--pro-layer-drawings', '20'],
  ['--pro-layer-order-overlays', '24'],
  ['--pro-layer-tile-hud', '30'],
  ['--pro-layer-terminal-chrome', '40'],
  ['--pro-layer-drawers', '60'],
  ['--pro-layer-popovers', '80'],
  ['--pro-layer-modal', '100'],
  ['--pro-layer-toast', '120'],
])

function selectorHeaders(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const headers = []
  let start = 0

  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index]
    if (character === '{') {
      const header = withoutComments.slice(start, index).trim()
      if (header) headers.push(header)
      start = index + 1
    } else if (character === '}') {
      start = index + 1
    }
  }

  return headers
}

function pairedComponentRanges(source, componentName) {
  const tokens = source.matchAll(new RegExp(`<(/?)${componentName}\\b`, 'g'))
  const openComponents = []
  const ranges = []

  for (const match of tokens) {
    if (match[1] === '/') {
      const start = openComponents.pop()
      assert.notEqual(start, undefined, `unexpected closing ${componentName} tag`)
      ranges.push({ start, end: match.index + match[0].length })
    } else {
      openComponents.push(match.index)
    }
  }

  assert.equal(openComponents.length, 0, `expected every ${componentName} tag to be structurally closed`)
  return ranges.sort((left, right) => left.start - right.start)
}

function rangesIntersect(left, right) {
  return left.start < right.end && right.start < left.end
}

test('Pro Trading directly imports its scoped stylesheet and owns the terminal boundary', async () => {
  const [entry, globalStyles] = await Promise.all([
    readFile(terminalEntryPath, 'utf8'),
    readFile(globalStylesPath, 'utf8'),
  ])

  assert.match(entry, /import\s+['"]\.\/ProTradingTerminal\.css['"]/, 'ProTrading.jsx must directly import ProTradingTerminal.css')
  assert.match(entry, /data-pro-terminal(?:=|\s|>)/, 'the terminal entry must render [data-pro-terminal]')
  assert.doesNotMatch(globalStyles, /Premium Pro Trading terminal|\.pro-terminal\s*\{|\.terminal-topbar\s*\{/, 'terminal rules must not live in index.css')
})

test('terminal stylesheet selectors stay scoped and z-index declarations use approved layer tokens', async () => {
  const css = await readFile(terminalStylesPath, 'utf8')
  const headers = selectorHeaders(css)
  const selectors = headers
    .filter(header => !header.startsWith('@'))
    .filter(header => !['from', 'to'].includes(header) && !/^\d+%$/.test(header))
    .flatMap(header => header.split(',').map(selector => selector.trim()))

  assert.ok(selectors.length > 0, 'expected scoped terminal selectors')
  for (const selector of selectors) {
    assert.ok(
      selector.startsWith('[data-pro-terminal]') || selector.startsWith('.pro-terminal-'),
      `global selector leaked from ProTradingTerminal.css: ${selector}`,
    )
  }

  const declarations = [...css.matchAll(/(--pro-layer-[\w-]+)\s*:\s*([^;]+);/g)]
  assert.deepEqual(
    new Map(declarations.map(([, name, value]) => [name, value.trim()])),
    approvedLayers,
    'the stylesheet must define only the approved fixed layer tokens',
  )

  const zIndexes = [...css.matchAll(/z-index\s*:\s*([^;}]+)[;}]/g)].map(([, value]) => value.trim())
  assert.ok(zIndexes.length > 0, 'expected terminal layer usage')
  for (const value of zIndexes) {
    const token = value.match(/^var\((--pro-layer-[\w-]+)\)$/)?.[1]
    assert.ok(token && approvedLayers.has(token), `arbitrary z-index is prohibited: ${value}`)
  }
})

test('optional feature slots are isolated from the baseline chart and paper-order flow', async () => {
  const [entry, boundary] = await Promise.all([
    readFile(terminalEntryPath, 'utf8'),
    readFile(boundaryPath, 'utf8'),
  ])

  assert.match(entry, /TerminalFeatureBoundary/, 'the terminal must compose feature-level error boundaries')
  assert.match(boundary, /getDerivedStateFromError/, 'feature slots must catch render and lifecycle failures')
  assert.match(boundary, /data-pro-feature-slot/, 'feature slots must identify the affected feature')
  assert.match(boundary, />Retry<\/button>/, 'feature failures must expose a retry action')

  const chartTags = [...entry.matchAll(/<ProChart\b/g)]
  const boundaryRanges = pairedComponentRanges(entry, 'TerminalFeatureBoundary')
  const orderSheetRanges = pairedComponentRanges(entry, 'BottomSheet')

  assert.equal(chartTags.length, 1, 'the terminal must render exactly one baseline chart')
  assert.ok(boundaryRanges.length > 0, 'the terminal must compose optional feature boundaries')
  assert.ok(
    boundaryRanges.every(range => chartTags[0].index < range.start || chartTags[0].index >= range.end),
    'the baseline chart must remain outside every optional feature boundary',
  )

  assert.equal(orderSheetRanges.length, 1, 'the terminal must render exactly one explicit paper-order sheet')
  assert.ok(
    boundaryRanges.every(range => !rangesIntersect(range, orderSheetRanges[0])),
    'the explicit paper-order sheet must remain outside every optional feature boundary',
  )
})
