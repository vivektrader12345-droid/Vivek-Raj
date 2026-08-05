# Implementation Plan

- [x] 1. Write the Trade History bug-condition exploration test
  - **Property 1: Bug Condition** - Trade History Safely Renders the Full Heterogeneous Collection
  - **CRITICAL**: Write and run this property-based browser test BEFORE implementing the fix; it MUST FAIL on unfixed code, and that failure confirms the bug.
  - **DO NOT** change application code or weaken the assertion when the expected failure occurs.
  - Create a routed fixture under `tests/trade-history/` using the existing Vite + built-in Node test runner + headless Edge harness pattern, with mocked authenticated Trade/Currency/Alert contexts and the real Dashboard/TradeHistory navigation behavior.
  - Implement `isBugCondition(input)` from the design: authenticated target `/history`, Dashboard's first seven records are renderable, and at least one full-history record admitted by initial filters has an unsupported direction or unsafe route-consumed field.
  - **Scoped PBT Approach**: Always include the deterministic collection of seven newer canonical trades plus `{ id: 'legacy-8', pair: 'BTC/USDT', type: null, pnl: 0, date: '2026-07-01' }`; then deterministically generate missing/null/non-string variants for fields consumed by search, filtering, sorting, totals, table/detail rendering, export, and custom-option storage.
  - Confirm Dashboard renders its Recent Trades preview before clicking `View All →`; then click the actual link and assert the expected fixed behavior: path `/history`, visible application shell and Trade History, all identities represented with stable fallbacks, no runtime exception, and no data-shape boundary activation.
  - Generate a second primary case through `rowToTrade` with valid Trading Pair and missing/unrecognized Direction to prove the counterexample is reachable through the supported CSV production path.
  - Seed malformed and non-array `vmt_custom_strategies` / `vmt_custom_sessions` values and record whether they produce independent route counterexamples.
  - Run on UNFIXED code and capture URL, DOM state, runtime/console errors, boundary state, generated seed, and minimized failing input.
  - **EXPECTED OUTCOME**: FAILURE, including the primary counterexample `TypeError: Cannot read properties of null (reading 'toUpperCase')`; mark complete only after the failure is documented.
  - Add a one-shot `test:trade-history:exploration` script; do not use watch mode.
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3_

- [x] 2. Write Trade History preservation property tests before implementing the fix
  - **Property 2: Preservation** - Canonical Trade History and Navigation Behavior
  - **IMPORTANT**: Follow observation-first methodology and complete this task on UNFIXED code.
  - Observe canonical manual, CSV, Pro Trading, and TradingView extension records on the unfixed route; record stable semantics only: row identities/order, labels, values, totals, detail fields, filter/search/sort outputs, action targets, routes, persistence calls, and boundary output.
  - Generate canonical trade collections and exercise every current search/filter/sort control, including win/loss/breakeven totals and date/session/strategy constraints; store deterministic semantic baselines rather than full DOM/class snapshots.
  - Verify Dashboard `View All →`, sidebar `/history`, Add Trade `/history`, edit `/edit-trade/:id`, and browser back/forward paths.
  - Characterize view/edit/delete/clear/import/export actions and prove rendering does not invoke TradeContext persistence writes or mutate raw Firestore-shaped objects.
  - Inject an unrelated child render error and record the visible error-boundary text, diagnostic logging, and controls.
  - Run these property tests on UNFIXED code.
  - **EXPECTED OUTCOME**: PASS, establishing the behavior the fix must preserve.
  - Add a one-shot `test:trade-history:preservation` script; do not use watch mode.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 3. Fix the Trade History full-collection runtime failure

  - [x] 3.1 Add a pure Trade History view-model normalization boundary
    - Add `src/utils/tradeHistoryViewModel.js` or an equivalently isolated pure module with explicit normalization for nullable/non-string text, supported/unknown direction, finite numbers, parseable dates, ratings/tags, search keys, sort keys, totals, display placeholders, and export values.
    - Preserve each raw trade's Firestore identity/reference for view/edit/delete/export behavior; do not write normalized values back to Firestore.
    - Add guarded JSON and array-shape parsing for `vmt_custom_strategies` and `vmt_custom_sessions`, falling back to `[]` for corrupt/legacy values without changing valid stored values.
    - Keep canonical values semantically unchanged according to task 2's observations.
    - _Bug_Condition: `isBugCondition(input)` where the full history contains a route-admitted record with unsupported `type` or another unsafe field while Dashboard's Recent_Window remains renderable_
    - _Expected_Behavior: `expectedBehavior(result)` from design—visible `/history`, stable fallbacks, all identities represented, no runtime exception or data-shape boundary activation_
    - _Preservation: Canonical rows, filtering, sorting, totals, actions, routes, synchronization, and boundary behavior from the design Preservation Requirements_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.4, 3.5_

  - [x] 3.2 Render and operate exclusively through the safe History view model
    - Update `src/pages/TradeHistory.jsx` to memoize normalized records and use their safe fields consistently for strategy options, search, all filters, sorting, total P&L, table cells, detail modal, rating display, and CSV export.
    - Replace the null-unsafe direction rendering with the specified stable `Unknown` fallback while retaining existing long/short labels and colors for canonical trades.
    - Ensure action handlers and links use the original record ID/data and the empty-history experience remains unchanged.
    - Do not add a component-wide catch that hides programming defects; unrelated errors must still reach the existing boundary.
    - _Bug_Condition: The verified all-record `trade.type.toUpperCase()` failure and adjacent direct raw-field operations listed in design_
    - _Expected_Behavior: Property 1 and `expectedBehavior(result)` from design_
    - _Preservation: Property 2 canonical semantic baseline from task 2_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.5_

  - [x] 3.3 Verify route-boundary recovery and production artifact parity
    - Keep `ErrorBoundary` visible and diagnostic for synthetic unrelated exceptions; if the exploration test confirms stale route error state across navigation, key/reset only the route boundary on location changes without weakening the application boundary.
    - Add a direct-load `/history` browser check and verify Netlify's existing SPA rewrite remains sufficient.
    - Build the application and inspect/run the built artifact to confirm the fixed history path and visible boundary fallback are included; do not treat a stale deployment or generic fallback as a substitute for fixing TradeHistory.
    - Record the production asset identifier used for post-deployment verification against `vijaycontractor.space`.
    - _Bug_Condition: Data-shape exceptions currently activate a generic fallback/retry loop; inspected production asset lacked expected source fallback strings_
    - _Expected_Behavior: Known heterogeneous data is handled inside TradeHistory, while unrelated errors show a visible fallback_
    - _Preservation: Existing authenticated routing, application shell, diagnostics, and recovery controls_
    - _Requirements: 2.3, 3.3, 3.6_

  - [x] 3.4 Verify the original bug-condition exploration test now passes
    - **Property 1: Expected Behavior** - Trade History Safely Renders the Full Heterogeneous Collection
    - **IMPORTANT**: Re-run the SAME property test and deterministic counterexamples from task 1; do not replace them with a new test.
    - Confirm the seven-valid-plus-one-null-type and CSV-origin unknown-Direction cases remain at `/history`, show visible History UI and stable fallbacks, represent all input identities, and report no uncaught exception or data-shape boundary activation.
    - Confirm generated nullable/non-string fields and malformed custom-option storage are handled according to the view-model contract.
    - **EXPECTED OUTCOME**: PASS, proving the verified runtime failure is fixed.
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.5 Verify the original preservation tests still pass
    - **Property 2: Preservation** - Canonical Trade History and Navigation Behavior
    - **IMPORTANT**: Re-run the SAME observation-first properties and baselines from task 2; do not write replacement tests after seeing the fix.
    - Confirm canonical rows, search/filter/sort results, totals, actions, routes, context side effects, and unrelated boundary behavior remain semantically unchanged.
    - **EXPECTED OUTCOME**: PASS, proving no regressions.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 4. Checkpoint - run complete one-shot validation
  - Run `npm run test:trade-history:exploration` and confirm Property 1 passes after the fix.
  - Run `npm run test:trade-history:preservation` and confirm Property 2 passes after the fix.
  - Run `npm run test:trade-history` for all new unit/property/integration checks.
  - Run the existing `npm test` suite and any affected startup smoke test with one-shot execution.
  - Run `npm run build` and the built-artifact `/history` smoke test; do not start a development server or watcher.
  - Verify no test mutated real Firestore data and review captured runtime/console diagnostics.
  - Ensure all tests pass; ask the user if questions or production-account-only counterexamples remain.
