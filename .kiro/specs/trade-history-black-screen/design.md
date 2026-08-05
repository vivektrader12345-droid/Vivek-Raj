# Trade History Black Screen Bugfix Design

## Overview

The fix will make the authenticated `/history` route a total rendering function over the trade shapes that can actually enter Firestore. The primary counterexample is a collection with seven canonical recent trades and an older record whose `pair` is valid but whose `type` is null: Dashboard renders only `trades.slice(0, 7)`, while Trade History filters and renders every record and calls `trade.type.toUpperCase()`. The supported CSV path can create this shape when Direction is absent or unrecognized, and Firestore rules impose no field schema.

The implementation will introduce a pure Trade History view-model normalization boundary, use normalized values throughout the route, preserve raw trade identity for actions, and add route-level browser tests. The fix will not rewrite Firestore records, change route definitions, or weaken the existing application error boundary. A production-build smoke check will ensure the visible boundary and fixed route are present in the artifact deployed to `vijaycontractor.space`.

## Glossary

- **Bug_Condition (C)**: An authenticated navigation to `/history` with at least one trade admitted by the route whose fields violate Trade History's implicit string/number/date assumptions, especially a valid `pair` with null or unsupported `type`.
- **Property (P)**: `/history` remains visible and usable, renders stable fallback values for unsupported fields, and emits no uncaught render exception.
- **Preservation**: Canonical trade rendering, filtering, sorting, totals, actions, synchronization, and navigation remain observationally equivalent to the unfixed application.
- **Canonical_Trade**: A manual-entry-compatible trade with string `pair`, `type` in `long | short`, finite numeric values, parseable date, and optional text fields represented as strings or null.
- **Heterogeneous_Trade**: A Firestore trade from manual entry, CSV import, Pro Trading, TradingView extension, or legacy/external writes with missing, nullable, or differently typed fields.
- **History_View_Model**: A render-only projection that converts a raw trade into safe display, search, filter, sort, total, detail, and export values while retaining raw identity.
- **Recent_Window**: Dashboard's `trades.slice(0, 7)` preview.
- **Route_Boundary**: The `ErrorBoundary` wrapping `<Outlet />` in `src/components/Layout.jsx`.
- **TradeHistory**: The route component in `src/pages/TradeHistory.jsx`.
- **TradeContext**: The provider in `src/context/TradeContext.jsx` that loads Firestore records and currently normalizes only timestamp metadata.

## Bug Details

### Bug Condition

The bug manifests when Dashboard's Recent_Window contains only records that its table can render, but the full collection contains a record that TradeHistory includes and then dereferences as if every field were canonical. The minimal verified counterexample uses a valid `pair` and `type = null`; this shape is admitted by `rowToTrade` when CSV Direction is missing or unrecognized and is accepted by the schema-free per-user Firestore rules.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type HistoryNavigationInput
  OUTPUT: boolean

  recent := firstSeven(input.trades)
  historyCandidates := all(input.trades)

  RETURN input.userIsAuthenticated
         AND input.navigationTarget = "/history"
         AND dashboardCanRender(recent)
         AND EXISTS trade IN historyCandidates WHERE
               tradeIsIncludedByInitialHistoryFilters(trade)
               AND (
                 NOT isSupportedDirection(trade.type)
                 OR NOT historyFieldsAreSafelyConsumable(trade)
               )
         AND unfixedTradeHistoryThrows(historyCandidates)
END FUNCTION
```

`tradeIsIncludedByInitialHistoryFilters` reflects the default empty search, `all` filters, and `date-desc` sort. For the primary counterexample, `pair = "BTC/USDT"` makes the empty search match, while `type = null` reaches the table and fails at `toUpperCase()`.

### Examples

- **Primary deterministic counterexample**: Seven newer canonical trades plus `{ id: "legacy-8", pair: "BTC/USDT", type: null, pnl: 0, date: "2026-07-01" }`. Dashboard renders seven rows; clicking `View All →` reaches `/history`; the unfixed table throws `TypeError: Cannot read properties of null (reading 'toUpperCase')`. The fixed route shows all eight records and an `Unknown` direction badge for the eighth.
- **CSV-origin counterexample**: A CSV row has `Trading Pair=ETH/USDT` and an empty or unrecognized `Direction`. `rowToTrade` retains the pair and produces `type: null`; Firestore accepts the document. Trade History must render it without requiring a data migration.
- **Non-string optional field**: A legacy document contains array tags or numeric notes. Search and initial render must not call unavailable string methods; normalized searchable text is used instead.
- **Incomplete extension/import record**: Optional date, P&L, strategy, session, or price fields are absent/null. The route displays stable placeholders, excludes non-finite values from numeric totals as defined, and remains interactive.
- **Edge case**: An empty collection still shows the existing `No trades found` and `Add First Trade` experience.

### Production and Routing Evidence

- `src/App.jsx` correctly nests `path="history"` under the authenticated Layout; `netlify.toml` rewrites deep links to `index.html`, so this is not a missing-route or rewrite failure.
- Dashboard links directly to `/history` and renders only `trades.slice(0, 7)`.
- TradeHistory processes every record and contains unsafe operations including `trade.type.toUpperCase()`, text `.toLowerCase()`, pair `.localeCompare()`, notes `.replace()`, and unconditional local-storage JSON parsing.
- `src/utils/csvImporter.js` can emit a valid pair with `type: null`; `firestore.rules` validates ownership but not trade shape; `TradeContext` passes fields through while converting only `createdAt` and `updatedAt` timestamps.
- The production bundle served by `vijaycontractor.space` (`/assets/index-nyjOgzDg.js` at investigation time) contains the same Recent Trades link, all-record filter, and unsafe `H.type.toUpperCase()` history rendering path.
- The checked source has application and route boundaries, but the inspected production bundle did not contain their diagnostic/fallback strings. Artifact/deployment parity therefore requires explicit validation in addition to fixing the route exception.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Canonical long and short trades retain their current labels, colors, prices, quantities, P&L formatting, star rating, details, and action targets.
- Existing search, filter, date-range, sort, result classification, and total-P&L semantics remain unchanged for canonical records.
- Dashboard `View All →`, sidebar Trade History, Add Trade post-save navigation, Edit Trade links, and browser back/forward navigation retain their routes.
- `TradeContext` subscriptions, refresh behavior, UID selection, and Firestore documents remain unchanged; normalization is render-only.
- CSV import/export and view/edit/delete/clear-all interactions retain current behavior for canonical records.
- The generic boundary remains available for unrelated exceptions and logs diagnostics.

**Scope:**
Inputs that do not satisfy the Bug_Condition must be unaffected. This includes:
- Empty history and canonical manual-entry collections
- Canonical CSV, Pro Trading, and TradingView extension records
- Filter/sort/search combinations over canonical data
- Navigation to all routes other than `/history`
- Firestore synchronization success and failure behavior
- Unrelated descendant errors handled by the existing boundary

The fix may add stable display placeholders and safe coercion only where raw fields are absent, invalid, or non-canonical. It must not silently write those normalized values back to Firestore.

## Hypothesized Root Cause

The investigation confirms the primary root cause and identifies adjacent failure surfaces:

1. **Confirmed all-record nullable direction dereference**: TradeHistory includes a valid-pair record under the default empty search and calls `trade.type.toUpperCase()` even when `type` is null.
   - Dashboard masks an older invalid record because it renders only seven recent records.
   - The CSV importer can create `type: null`, and Firestore allows it.

2. **Missing route view-model boundary**: TradeHistory directly mixes raw Firestore fields into search, filter, sort, arithmetic, rendering, detail, and export operations.
   - Optional chaining protects only null/undefined receivers; it does not make arrays, numbers, objects, invalid dates, or non-finite numbers canonical.
   - Fixing only `toUpperCase()` would leave equivalent route-fatal operations elsewhere.

3. **Unsafe browser-storage parsing**: TradeHistory parses custom strategy/session storage inline during render without validating JSON or array shape.
   - Corrupt or legacy local-storage values can independently abort the route.
   - Safe option loading belongs at the same route input boundary.

4. **Boundary is mitigation, not correction**: The route boundary catches render failures but retries the same bad input, so it cannot make Trade History usable.
   - A visible fallback is still required for unrelated failures.
   - The production artifact must be checked because the inspected bundle did not expose the source boundary's expected diagnostic strings.

## Correctness Properties

**Expected Result Predicate:**
```
FUNCTION expectedBehavior(result)
  INPUT: result of type HistoryRouteObservation
  OUTPUT: boolean

  RETURN result.locationPath = "/history"
         AND result.applicationShellVisible
         AND result.tradeHistoryVisible
         AND result.uncaughtExceptions = []
         AND result.errorBoundaryActivated = false
         AND result.allInputTradeIdentitiesRepresented
         AND result.invalidFieldsUseStableFallbacks
         AND result.validTradeBehaviorMatchesBaseline
END FUNCTION
```

Property 1: Bug Condition - Trade History Safely Renders the Full Heterogeneous Collection

_For any_ authenticated history navigation where the Bug_Condition holds, including the deterministic seven-valid-plus-one-null-type collection and generated supported/legacy field variants, the fixed route SHALL satisfy `expectedBehavior`: remain at `/history`, keep the application shell and Trade History visible, render stable fallback values, and emit no uncaught render exception or data-shape boundary activation.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Canonical Trade History and Navigation Behavior

_For any_ collection and interaction where the Bug_Condition does not hold, the fixed route SHALL produce the same canonical rows, search/filter/sort results, totals, action identities, routes, synchronization side effects, and boundary behavior observed on the original application.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

Assuming the verified root-cause analysis remains consistent with the exploration test:

**File**: `src/utils/tradeHistoryViewModel.js` (new pure module, or an equivalently isolated existing utility)

**Functions**: `normalizeTradeForHistory`, collection projection/filter/sort helpers, safe custom-option parser

**Specific Changes**:
1. Define explicit conversion rules for nullable text, direction, finite numbers, dates, ratings/tags, and display placeholders.
2. Preserve `id` and raw trade references needed by view/edit/delete/export actions.
3. Make derived search strings, comparable pair/date values, result classification, and P&L totals total over heterogeneous inputs.
4. Parse `vmt_custom_strategies` and `vmt_custom_sessions` with guarded JSON and array validation, falling back to `[]` without rewriting valid storage.
5. Keep the module pure and independent from Firestore so it can be property-tested with generated objects.

**File**: `src/pages/TradeHistory.jsx`

**Function**: `TradeHistory`

**Specific Changes**:
1. Memoize a History_View_Model collection from raw `trades` and use it consistently for strategy options, search, filters, sorting, totals, table cells, detail modal, and CSV export.
2. Render an `Unknown` (or design-equivalent stable) direction badge rather than invoking methods on an unsupported direction.
3. Use stable placeholders for invalid optional values while preserving current output for canonical values.
4. Keep mutations keyed to the original Firestore identity and do not normalize or migrate persisted documents during render.
5. Do not add catch-all suppression around the component; unrelated programming errors must still reach the Route_Boundary.

**Files**: `src/components/ErrorBoundary.jsx`, `src/components/Layout.jsx`, `src/App.jsx`, deployment/build configuration

**Specific Changes**:
1. Do not use the generic boundary to mask known data-shape failures.
2. Verify the route boundary resets appropriately when navigation changes, if the exploration test shows stale boundary state across route transitions.
3. Preserve visible fallback text, diagnostics, and controls for unrelated exceptions.
4. Confirm the production build contains the fixed route and boundary UI before deployment; stale asset parity is a release validation concern, not a substitute for the route fix.

**Files**: `tests/trade-history/*`, `package.json`

**Specific Changes**:
1. Add a browser fixture with mocked authenticated, trade, currency, and alert contexts that exercises real Dashboard-to-History routing.
2. Add deterministic generated-data tests using the built-in Node test runner and the existing Vite/headless-Edge harness pattern; no new test dependency is required.
3. Add one-shot scripts for exploration/preservation/full Trade History validation and include them in the relevant test command without watch mode.

## Testing Strategy

### Validation Approach

Validation follows the bugfix sequence: reproduce and record the failure on unfixed code, characterize behavior that already works, implement only after the counterexample identifies the failing operation, then rerun the same properties against the fix. Browser tests must observe URL, visible shell/content, runtime exceptions, console errors, and boundary activation—not merely test a helper in isolation.

### Exploratory Bug Condition Checking

**Goal**: Surface the history-only counterexample before implementation and confirm the verified `type` dereference or revise the root-cause section if the real rendered fixture refutes it.

**Test Plan**: Build a real routed fixture using Dashboard, TradeHistory, Layout-equivalent shell, and mocked contexts. Supply seven newer canonical trades and one older valid-pair trade with `type: null`. Load Dashboard, confirm it renders, click `View All →`, and capture path, DOM, runtime exceptions, console errors, and boundary state on unfixed code.

**Test Cases**:
1. **Eight-record nullable direction**: Seven canonical recent records plus one older null-type record; Dashboard passes and History fails on unfixed code.
2. **Unsupported CSV direction**: Generate a trade via `rowToTrade` from a valid Trading Pair and unknown Direction, append it outside the Recent_Window, and reproduce the failure.
3. **Heterogeneous optional fields**: Generate missing, null, array, numeric, object, invalid-date, and non-finite variants for route-consumed fields and record minimal counterexamples.
4. **Malformed custom options**: Seed invalid/non-array custom strategy/session JSON and determine whether render fails independently.

**Expected Counterexamples**:
- `TypeError: Cannot read properties of null (reading 'toUpperCase')` for the primary dataset.
- Additional counterexamples may identify unavailable `.toLowerCase`, `.localeCompare`, or `.replace` methods, invalid repeated rating values, or unsafe inline JSON parsing.
- The URL reaches `/history`, proving navigation and rewrite success while component rendering fails.

### Fix Checking

**Goal**: Verify all generated inputs satisfying the Bug_Condition render safely after the fix.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := navigateDashboardToHistory_fixed(input)
  ASSERT expectedBehavior(result)
END FOR
```

Use deterministic seeds and always include the exact eight-record primary counterexample. Verify every input identity is represented either as a row with stable fallbacks or by an explicitly documented exclusion rule; malformed optional fields must never activate the boundary.

### Preservation Checking

**Goal**: Verify inputs outside the Bug_Condition behave identically before and after the fix.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  baseline := observeTradeHistory_original(input)
  fixed := observeTradeHistory_fixed(input)
  ASSERT equivalentCanonicalHistoryBehavior(baseline, fixed)
END FOR
```

**Testing Approach**: Observe canonical behavior on unfixed code first and store only stable semantic outputs: row identities/order, labels, displayed values, totals, filter counts, target paths, handler calls, and visible boundary content. Avoid brittle snapshots of generated classes or entire HTML.

**Test Cases**:
1. **Canonical row preservation**: Long/short, winning/losing/breakeven records render the same semantic values.
2. **Filter/sort preservation**: Generated canonical collections produce the same identities and totals for every existing control.
3. **Navigation preservation**: Dashboard, sidebar, add/edit, and back/forward paths remain unchanged.
4. **Action preservation**: View, edit, delete, clear, import, and export target the same raw IDs/data for canonical records.
5. **Context preservation**: Rendering invokes no TradeContext persistence operation and does not alter subscription behavior.
6. **Boundary preservation**: A synthetic unrelated child error still shows the fallback and records diagnostics.

### Unit Tests

- Test normalization of canonical and heterogeneous text, direction, number, date, rating/tags, and identity fields.
- Test CSV-origin unknown Direction maps to a safe History_View_Model direction without mutating the raw trade.
- Test safe custom-option parsing for missing, valid, malformed, and non-array JSON.
- Test search, filter, sort, total, detail, and export projections over generated trade objects.
- Test canonical projection is semantically identical to existing output.

### Property-Based Tests

- Generate collections with seven canonical recent trades and one or more older field variants; assert Dashboard remains renderable and fixed History satisfies Property 1.
- Generate heterogeneous values for every route-consumed field using deterministic seeds; assert normalization and all route derivations are total.
- Generate canonical collections and control combinations; compare fixed semantic output with the observation-first baseline for Property 2.
- Record exact seeds and minimized counterexamples when a property fails.

### Integration Tests

- Run a headless browser flow from authenticated Dashboard `View All →` to `/history` with the primary counterexample and assert visible shell/history, `/history` URL, no runtime exception, and no boundary activation.
- Direct-load `/history` through the Vite fixture and production build/deep-link fallback to validate routing.
- Verify sidebar and add/edit navigation plus browser back/forward behavior.
- Inject an unrelated render exception to confirm visible Route_Boundary behavior and recovery controls.
- Run `npm run test:trade-history`, the existing non-watch test suite, `npm run build`, and a one-shot built-artifact smoke check; verify the generated bundle contains the fixed behavior and visible fallback before deployment.
