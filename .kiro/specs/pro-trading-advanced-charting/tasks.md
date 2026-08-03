# Implementation Plan

## Execution Contract

- Standalone Tasks 1, 2, and 4 plus every checkbox with a decimal task ID are dispatchable leaves sized for one implementation subagent; parent tasks complete only after all required child tasks complete.
- `_Depends on:` annotations are hard DAG edges. A task may start only after every listed dependency is complete.
- Task 4 is the first release gate. No advanced-feature task (Task 5 or later) may start until Task 4 passes.
- Property-based test labels map directly to the numbered correctness properties in `design.md`.
- No source change may mutate the `pro-trading-store` key or its persisted subset, create a second Pro Trading journal writer, introduce private Binance endpoints/credentials, or add an arbitrary-code execution path.
- Task 13.10 is the only optional enhancement. Final acceptance does not depend on it unless Task 13.7 demonstrates that the required performance targets cannot otherwise be met.

## Dependency Waves

| Wave | Runnable work after prior dependencies pass | Gate/output |
|---|---|---|
| 0 | Task 1 | Reproducible failing geometry counterexamples on the unfixed shell |
| 1 | Task 2 | Passing preservation baseline on unfixed code |
| 2 | Tasks 3.1–3.4 | Scoped terminal foundation, grid, header, and portal primitives |
| 3 | Tasks 3.5–3.12 | Rails, paper quote, HUD, dock, chart interactions, responsive shell, baseline composition |
| 4 | Tasks 3.13–3.16, then Task 4 | Clean single-chart release gate |
| 5 | Task 5 | Adapter/runtime/persisted-state separation |
| 6 | Tasks 6, 7, and 8 may proceed in parallel | Drawings, indicator instances, and shared subscriptions |
| 7 | Task 9 | Multi-chart and linking |
| 8 | Tasks 10 and 11 may proceed in parallel | Watchlist/scanner and sequenced order book |
| 9 | Task 12 | Firebase layouts, ownership, conflicts, recovery, journal idempotency |
| 10 | Task 13 required leaves; Task 13.10 only if triggered | Accessibility, reliability, security, and measured performance |
| 11 | Task 14 | Final regression, visual, security, recovery, and performance gate |

- [x] 1. Write the terminal geometry bug-condition exploration test
  - **Property 1: Bug Condition** - Terminal Geometry Is Safe
  - **CRITICAL**: Write and run this property-based/geometry test before changing the terminal shell. It MUST FAIL on the current unfixed layout; do not weaken the assertion or fix production code as part of this task.
  - Generate supported viewport snapshots across widths 320–2560 and scope deterministic runs to 1024×768, 1366×768, 1920×1080, and 390×844.
  - Implement the design's `isBugCondition(X)` probes for unapproved clipping, viewport escape, forbidden rectangle intersections, document-level horizontal overflow, missing essential controls/desktop rail reservations, dock tab gaps below 8px, and inadequate 1366×768 chart allocation.
  - Assert the design's `expectedBehavior(X)`: no bug condition, desktop header at most 88px, expanded rails at most 44px, collapsed dock at most 40px, expanded dock at most 240px, visible price/time scales, and styled application menus contained by an 8px viewport inset.
  - Exercise menu-open-near-edge, rails expanded/collapsed, dock expanded/collapsed, paper-order open, order overlays present, stale/error state, and maximum-label states.
  - Record screenshots and concrete counterexamples from the current shell, including the failing viewport/state, offending element roles/rectangles, scroll metrics, and expected invariant.
  - Mark complete only when the test is committed to the test suite, has run against UNFIXED code, and its expected failure is documented.
  - _Depends on: none_
  - _Requirements: 4.9, 8.7, 11.2–11.5, 11.9–11.13_

- [x] 2. Write preservation characterization property tests on the unfixed product
  - **Property 2: Preservation** - Paper Trading and Journal Behavior
  - **IMPORTANT**: Follow observation-first methodology and do not implement the layout fix in this task.
  - Observe and record `tradingStore` transitions for market/limit/stop orders, fees, margin, mark-price/P&L, SL/TP/liquidation, partial close, reverse, close-all, reset, pending orders, and persisted rehydration; assert model-based transition parity and the unchanged `pro-trading-store` key/subset.
  - Observe Binance REST kline bootstrap and public WebSocket lifecycle for symbol/timeframe changes, finite epoch-second OHLCV mapping, mark-price updates, reconnect, and obsolete-stream cleanup; capture passing contract tests without changing stream ownership.
  - Observe `lightweight-charts` 4.1.1 behavior for history/live updates, candles/wicks, volume, grid, crosshair, price line/label, time and price scales, markers, order lines, risk/reward, wheel/pointer/axis interactions, reset, auto-scale, fullscreen, resize, screenshot, and destroy cleanup.
  - Characterize `useTradeBridge` as the single mounted writer: persisted-count baseline, reset handling, count advancement before async writes, multi-append processing, deterministic `tradeId: pro_${closedTrade.id}`, `source: pro_trading`, authenticated UID use, and retry behavior through an idempotent `addTrade` boundary.
  - Verify Dashboard/History observation, manual trade entry, authentication, Settings, and unrelated local-storage keys remain unchanged.
  - Use generated valid order/position histories and event sequences where practical. These tests MUST PASS on unfixed code and become the comparison oracle for Tasks 3.16 and 14.5.
  - Mark complete only when observed outputs are documented and the full preservation suite passes on UNFIXED code.
  - _Depends on: 1_
  - _Requirements: 1.1–1.5, 9.4–9.7, 10.5, 10.8–10.9, 11.7–11.8, 11.12_

- [ ] 3. Clean single-chart terminal release-gate implementation
  - Implement only the deterministic professional single-chart shell and preserved baseline composition in this task group. Advanced drawings, indicator instances, multi-chart, market utilities, and saved-layout features remain disabled.
  - _Depends on: 1, 2_
  - _Requirements: 1.1–1.5, 4.9, 8.1–8.8, 9.2, 10.8–10.9, 11.1–11.13_

  - [x] 3.1 Create the scoped terminal stylesheet and composition boundary
    - Create the terminal entry/composition boundary with `[data-pro-terminal]`, and directly import `./ProTradingTerminal.css` from `src/trading/ProTrading.jsx` or the replacement terminal entry; do not append terminal rules to `src/index.css`.
    - Root every selector at `[data-pro-terminal]` or a locally prefixed class, add the approved scoped reset, define only the approved layer tokens, and prevent body/terminal horizontal overflow.
    - Establish feature-level error-boundary slots while keeping the baseline chart and paper-order flow outside failures in optional feature slices.
    - Add a style-import assertion and selector/layer-token lint or unit check that catches global leakage and arbitrary z-index values.
    - _Bug_Condition: `isBugCondition(X)` from the design's Observed Layout Defect and Formal Condition_
    - _Expected_Behavior: `expectedBehavior(X)` from the design_
    - _Preservation: Preserved Existing Contracts and Expected Behavior and Preservation Requirements from the design_
    - _Depends on: 1, 2_
    - _Requirements: 1.1, 1.5, 11.1–11.2_

  - [x] 3.2 Implement the deterministic CSS Grid shell
    - Implement `header | workspace | dock | status` rows and `leftRail | chartRegion | utilityPanel | rightRail` columns using `minmax(0, 1fr)` and zero min-size grid children.
    - Implement the approved 1920, 1366, 1024, tablet, and mobile track contracts, including overlay/drawer utility behavior where a persistent panel would violate chart minimums.
    - Size from `100dvh` with `100vh` fallback and test computed tracks, no page-level overflow, and the 1366×768 default chart width/height minimums.
    - _Depends on: 3.1_
    - _Requirements: 4.9, 8.7, 11.2–11.3, 11.9, 11.11_

  - [x] 3.3 Build the compact header and deterministic overflow priority
    - Implement the two desktop rows (44px + 40px, or 44px + 36px at 1024), priority controls, supported disabled states, and one styled `More` menu for secondary controls.
    - Keep Home, market selector, live status, account summary, layout/save/fullscreen, paper Trade, priority timeframes, style, and indicators reachable without accidental clipping.
    - Add breakpoint/label-length component tests proving desktop height never exceeds 88px and unsupported controls do not crowd supported controls.
    - _Depends on: 3.1_
    - _Requirements: 1.1, 8.1–8.5, 11.2, 11.4, 11.11_

  - [x] 3.4 Implement viewport-safe portal menu primitives
    - Add one body-mounted `#pro-terminal-portal-root`, portal theme propagation, fixed positioning, preferred-side flip, two-axis clamp with 8px padding, reposition on resize/scroll, and approved layer tokens.
    - Implement reusable styled `Popover`, `ContextMenu`, `ModalSheet`, and symbol combobox/listbox primitives with focus return, roving focus/trap as applicable, topmost Escape dismissal, and pointer-down-outside dismissal without click replay.
    - Add unit/property tests for anchors near every viewport edge, oversized content, zoomed text, nested overflow-hidden ancestors, focus restoration, and unintended-action prevention.
    - _Depends on: 3.1_
    - _Requirements: 5.1, 8.1–8.5, 11.2, 11.10–11.11_

  - [x] 3.5 Implement reserved compact rails and responsive drawers
    - Build fixed independently collapsible left drawing and right action rail tracks at 40px desktop/36px compact desktop, never exceeding 44px, with a retained 28px collapsed edge control.
    - At tablet/mobile widths replace fixed rails with labeled accessible drawers/actions; keep rail/drawer surfaces out of the price/time scale and HUD safe zones.
    - Add geometry, keyboard, touch-target, collapse-state, and no-obscuration tests.
    - _Depends on: 3.2, 3.4_
    - _Requirements: 8.1, 8.5–8.8, 11.2, 11.5, 11.11_

  - [x] 3.6 Add the paper SELL/BUY quote box through the explicit draft flow
    - Place bid, ask, spread, and explicit `Paper SELL`/`Paper BUY` labels in the chart's upper-left safe band without covering symbol/OHLC/current-price information.
    - Route both actions only through `openPaperOrderDraft`; prove no click/keyboard action calls `placeOrder` until the existing review/confirmation submit action.
    - Add component/integration tests for current/stale/unavailable quote states, side/price prefill, keyboard and touch activation, and no live/private Binance request.
    - _Depends on: 3.2, 3.4_
    - _Requirements: 1.2, 8.1–8.6, 10.5, 10.9, 11.6_

  - [ ] 3.7 Reserve chart HUD and paper-overlay safe zones
    - Add the inset legend/OHLC row, quote row, price-scale top margin, right-side paper-overlay lane, collision grouping, compact labels, and non-obscuring opacity rules.
    - Keep paper positions/orders visually distinct from market data and each other while preserving readable candles, wicks, OHLC, last-price label, and scales.
    - Add rectangle-intersection and maximum-position/order-overlay tests at all four required acceptance viewports.
    - _Depends on: 3.2_
    - _Requirements: 1.1–1.2, 11.2–11.3, 11.6–11.7, 11.12–11.13_

  - [ ] 3.8 Rebuild the trading dock within fixed geometry limits
    - Implement a 36px desktop/40px touch collapsed dock and `clamp(160px, 26dvh, 240px)` expanded dock, falling back to a modal sheet if expansion would violate chart minimums.
    - Provide Positions, Orders, History, and Account tabs backed only by `tradingStore`, with 8px minimum gaps, active state, approved internal scrolling, keyboard scroll controls, and edge fades.
    - Add geometry and store-backed rendering tests for collapsed/expanded states, long labels, empty/loaded content, and chart-allocation preservation.
    - _Depends on: 3.2, 3.4_
    - _Requirements: 1.1–1.4, 8.1–8.5, 11.2–11.3, 11.9, 11.13_

  - [ ] 3.9 Preserve professional chart presentation and interactions inside the new host
    - Rehost the existing chart without changing its data source and retain discernible bodies/wicks, volume, grid, crosshair, last-price line/label, OHLC, scales, adaptive spacing, and an original subtle watermark.
    - Preserve wheel zoom, pointer pan, price/time-axis drag, double-click reset, auto-scale, fullscreen, screenshot, markers, order lines, risk/reward, and simulated mark-price updates.
    - Add interaction parity and screenshot assertions using the characterization oracle from Task 2.
    - _Depends on: 3.2, 3.7_
    - _Requirements: 1.1, 9.2, 11.1, 11.3, 11.7–11.8, 11.12_

  - [ ] 3.10 Implement progressive tablet and mobile reflow
    - Implement stacked tablet tiles/surfaces and the mobile active-chart composition with compact market/status header, position status, chart, 40px dock, and 56px Tools/Markets/Paper SELL/Paper BUY action bar.
    - Keep essential market selection, active-chart identification, chart viewing, paper-order access, and position status usable at every width from 320px without page-level horizontal scrolling.
    - Add responsive tests at 768×1024, 390×844, and 320px width with touch and 200% text scaling.
    - _Depends on: 3.2–3.8_
    - _Requirements: 4.9, 8.5–8.8, 11.2, 11.10–11.11, 11.13_

  - [ ] 3.11 Move baseline sidebar, status, and paper panels into shell boundaries
    - Compose existing market status, paper order panel, account data, positions/orders/history, markers, lines, and risk/reward through the new header/rails/drawers/dock without changing their source stores or action semantics.
    - Keep existing symbol/timeframe/fullscreen settings compatible and preserve readable `pro-trading-settings` values without deleting or reinterpreting order defaults/notifications.
    - Add route-level integration tests proving advanced-feature placeholders/failures do not block the baseline chart or paper-order access.
    - _Depends on: 3.3–3.10_
    - _Requirements: 1.1–1.5, 10.8–10.9, 11.2–11.12_

  - [ ] 3.12 Add shell-level accessibility and contextual interaction behavior
    - Implement header-to-rails-to-chart-to-action/dock focus order, active-chart accessible naming/outline, documented non-reserved shortcuts, visible equivalents, polite status regions, non-color-only states, and drawing-mode cancel placeholder behavior.
    - Verify menus/dialogs restore focus, Escape closes only the top context, text inputs suppress shortcuts, and pointer/touch actions do not require hover.
    - Run automated accessibility checks plus keyboard-only, forced-colors, reduced-motion, contrast, and 200% zoom tests on the single-chart shell.
    - _Depends on: 3.3–3.11_
    - _Requirements: 8.1–8.8, 11.10–11.11_

  - [ ] 3.13 Run clean-shell unit, integration, and overflow validation
    - Run scoped-style, grid-track, breakpoint, portal-clamp, paper-draft-only, chart-interaction, dock, rail, accessibility, and preserved baseline suites.
    - Test default and stressed states at 1024×768, 1366×768, 1920×1080, and 390×844; include tablet 768×1024 as an additional design profile.
    - Fix shell-only failures and record the exact commands and passing results; do not begin adapter or advanced-feature work.
    - _Depends on: 3.1–3.12_
    - _Requirements: 1.1–1.5, 4.9, 8.1–8.8, 9.2, 10.8–10.9, 11.1–11.13_

  - [ ] 3.14 Capture release-gate screenshots and geometry artifacts
    - Capture reviewable screenshots at 1024×768, 1366×768, 1920×1080, and 390×844 for default, edge-menu, rails expanded/collapsed, dock expanded/collapsed, paper order open, positions/order lines, stale/error, and maximum-label states.
    - Assert document width equality, viewport/menu containment, allowed-only intersections, no text clipping, header/rail/dock caps, 8px dock tab gaps, 1366 chart allocation, and visibility of scales/OHLC/last-price/quote controls.
    - Store or attach geometry JSON and image diffs using the repository's established visual-test artifact mechanism and require human review for original visual identity and candle/overlay readability.
    - _Depends on: 3.13_
    - _Requirements: 11.1–11.13_

  - [ ] 3.15 Verify the original exploration test now passes
    - **Property 1: Expected Behavior** - Terminal Geometry Is Safe
    - Re-run the SAME test and deterministic counterexamples from Task 1; do not replace it with a weaker shell-specific test.
    - Confirm all generated supported viewports satisfy `expectedBehavior(X)` and attach the before/after counterexample resolution.
    - _Depends on: 3.13, 3.14_
    - _Requirements: 4.9, 8.7, 11.2–11.5, 11.9–11.13_

  - [ ] 3.16 Verify preservation characterization still passes
    - **Property 2: Preservation** - Paper Trading and Journal Behavior
    - Re-run the SAME observation-based suites from Task 2; do not create a new baseline after the shell change.
    - Confirm identical valid `tradingStore` transitions/persistence, Binance bootstrap/stream semantics, `lightweight-charts` interactions/cleanup, one `useTradeBridge` writer with deterministic IDs, and unaffected adjacent product routes.
    - _Depends on: 3.11, 3.13_
    - _Requirements: 1.1–1.5, 9.4–9.7, 10.5, 10.8–10.9, 11.7–11.8, 11.12_

- [ ] 4. Release gate — ship the fixed single-chart terminal before advanced features
  - Confirm Tasks 1–3 are complete, Task 1's formerly failing counterexamples now pass, Task 2's preservation suite remains unchanged and passing, all four required screenshot profiles are approved, and no advanced feature is needed for a usable terminal.
  - Confirm the release artifact has directly imported scoped CSS, deterministic grid geometry, viewport-safe portals, compact header, rails no wider than 44px, paper quote box, chart HUD/safe zones, collapsed dock no taller than 40px, responsive/mobile behavior, and recoverable baseline feature errors.
  - Block Task 5 and later on any unresolved clipping, overlap, page overflow, chart-allocation, paper-execution, journaling, stream, chart-interaction, or accessibility regression.
  - _Depends on: 3.14, 3.15, 3.16_
  - _Requirements: 1.1–1.5, 4.9, 8.1–8.8, 9.2, 10.8–10.9, 11.1–11.13_

- [ ] 5. Separate chart adapters, persisted workspace state, and runtime state
  - _Depends on: 4_
  - _Requirements: 1.1–1.5, 3.10, 4.1–4.11, 7.1, 7.4, 9.2–9.4, 9.7–9.8, 10.3, 10.8_

  - [ ] 5.1 Define validated versioned `WorkspaceStore` state and commands
    - Model only serializable schema/version metadata, tile configuration, active tile/order, links, indicator/drawing references, watchlist/scanner preferences, dock/drawer settings, and autosave preference.
    - Use the approved namespaced keys, enforce valid defaults and atomic validation, and add reducer/schema/round-trip tests without reading or writing `pro-trading-store`.
    - _Depends on: 4_
    - _Requirements: 3.10, 4.1–4.8, 7.1, 7.4, 7.9–7.10, 10.3, 10.8_

  - [ ] 5.2 Define non-persisted `RuntimeStore` state and lifecycle commands
    - Model chart handles, candles/buffers, gestures, focus/menu state, history stacks, requests/controllers/leases, live health, errors, and hidden-tile runtime exclusively in memory.
    - Add serialization-guard and reset/auth-change tests proving runtime handles and private product state can never enter workspace persistence.
    - _Depends on: 5.1_
    - _Requirements: 4.8, 4.10–4.11, 7.1, 9.4–9.8, 10.3, 10.8_

  - [ ] 5.3 Implement the narrow `ChartAdapter` API and cleanup contract
    - Implement mount/history/live update/indicators/drawings/order overlays/crosshair/mode/fit/scale/reset/screenshot/destroy methods around `lightweight-charts` 4.1.1.
    - Use `series.update` for live data, frame-batched `ResizeObserver`, zero-size deferral, finite epoch-second OHLCV validation, and complete listener/series/primitive teardown.
    - Add adapter unit/integration tests for every method, resize batching, no duplicate handlers, and post-destroy leak counts.
    - _Depends on: 5.2_
    - _Requirements: 1.1, 4.10–4.11, 9.1–9.4, 9.7, 11.7–11.8, 11.12_

  - [ ] 5.4 Add compatibility selectors and migrate the single chart to the adapter
    - Read supported existing chart/settings values into workspace commands while preserving order defaults/notifications and all paper-store ownership.
    - Move the release-gate chart behind one adapter instance without changing Binance initialization, visual behavior, overlays, or user interactions.
    - Add before/after parity tests against Task 2 and rollback tests that return to the last-valid single-chart workspace without touching paper/journal state.
    - _Depends on: 5.1–5.3_
    - _Requirements: 1.1–1.5, 7.4, 9.8, 10.8, 11.7–11.8, 11.12_

  - [ ] 5.5 Add local draft deadline persistence and last-valid recovery
    - Debounce writes while guaranteeing a local flush within 5 seconds of the first unsaved mutation, add best-effort `beforeunload` persistence, and retain last-valid state after validation/storage failure.
    - Add fake-timer, quota/failure, corrupt-draft, namespace-isolation, and in-memory-continuation tests.
    - _Depends on: 5.1, 5.2_
    - _Requirements: 2.9, 7.5–7.6, 7.10, 7.12, 9.8, 10.8_

  - [ ] 5.6 Validate adapter/state separation and single-chart parity
    - Run workspace/runtime serialization, adapter lifecycle, local recovery, release-gate geometry, chart interaction, trading-store, stream, and journal characterization suites.
    - Confirm one chart is usable before deferred utility initialization and record active chart ready timing for later performance comparison.
    - _Depends on: 5.3–5.5_
    - _Requirements: 1.1–1.5, 9.2–9.3, 9.7–9.8, 10.8, 11.2–11.13_

- [ ] 6. Implement drawings, reversible history, and pair persistence
  - _Depends on: 5.6_
  - _Requirements: 2.1–2.11, 8.1–8.8, 10.3–10.4, 10.7–10.8_

  - [ ] 6.1 Implement inert drawing schemas and validation
    - Define all seven drawing types, anchor counts, finite positive price/epoch-second time validation, style ranges, lock/hidden flags, plain-text normalization, 1,000-character limit, versions, and stable IDs/pair keys.
    - Add boundary and malicious-input tests proving invalid data is rejected/normalized without replacing last-valid state or interpreting markup, URLs, scripts, or expressions.
    - _Depends on: 5.6_
    - _Requirements: 2.1–2.5, 2.10, 10.3–10.4_

  - [ ] 6.2 Implement pair-isolated drawing reducers and limits
    - Add create/update/delete/lock/show/hide commands keyed by authenticated-or-anonymous user and canonical `SYMBOL@TIMEFRAME`.
    - Enforce 500 drawings per pair while preserving edits/deletes at the limit, and add reducer tests for cross-symbol/timeframe isolation and atomic last-valid behavior.
    - _Depends on: 6.1_
    - _Requirements: 2.2–2.5, 2.8, 2.10–2.11, 10.7–10.8_

  - [ ] 6.3 Implement command history, inverse operations, and redo truncation
    - Add apply/inverse snapshots for every drawing mutation, session-only pair stacks capped at 200 commands, undo/redo transfer, new-mutation redo clearing, and recoverable confirmed clear-all behavior.
    - Add generated command-sequence unit tests for inverse identity, stack caps, lock restrictions, batch deletion, and redo-branch truncation.
    - _Depends on: 6.2_
    - _Requirements: 2.3–2.7, 10.7_

  - [ ] 6.4 Implement drawing gesture state machines and adapter rendering
    - Implement place/preview/commit and select/move/resize/commit states, adapter coordinate conversion, hit testing, finite-anchor commit guards, frame-local previews, and visible mode/cancel behavior.
    - Render each drawing type through inert primitives; locked and hidden behavior must match the schema and never block chart pan/zoom after mode exit.
    - Add pointer/touch/keyboard integration tests, invalid-coordinate cases, chart gesture conflicts, and adapter teardown tests.
    - _Depends on: 6.2, 6.3_
    - _Requirements: 2.1–2.5, 2.10, 8.3, 8.6, 8.8_

  - [ ] 6.5 Build drawing catalog, inspector, and hidden-item manager
    - Add accessible rail/drawer catalog, selection/edit/style/lock/hide/show/delete controls, hidden drawing management, explicit destructive confirmation, validation messages, and visible shortcut equivalents.
    - Add component/accessibility tests for all drawing types and states at desktop/mobile widths.
    - _Depends on: 6.4_
    - _Requirements: 2.1, 2.3–2.5, 2.10–2.11, 8.1–8.8, 10.7_

  - [ ] 6.6 Persist pair drawings locally within the deadline
    - Write validated pair documents to `pro-trading-drawings:v1:{uid-or-anonymous}:{pairKey}` no later than 5 seconds after the first mutation, quarantine invalid instances individually, and retain a last-valid pair recovery copy.
    - Add fake-timer, reload, two-symbol/two-timeframe, corrupt-instance, quota/failure, and auth-namespace tests.
    - _Depends on: 6.2, 6.3_
    - _Requirements: 2.8–2.11, 9.8, 10.3–10.4, 10.8_

  - [ ] 6.7 Verify drawing isolation and reversible mutation
    - **Property 3: Drawing Isolation and Reversible Mutation** - Pair-scoped drawings and command history
    - Generate valid/invalid drawing command sequences across multiple pair keys and assert pair isolation, inverse/redo behavior, redo truncation, lock/hide semantics, limits, validation, and persistence round trips.
    - Add end-to-end create/edit/lock/hide/undo/redo/reload coverage for two symbols and two timeframes.
    - _Depends on: 6.3–6.6_
    - _Requirements: 2.1–2.11_

- [ ] 7. Implement safe independent indicator instances
  - _Depends on: 5.6_
  - _Requirements: 3.1–3.11, 8.1–8.6, 9.2, 10.3–10.4_

  - [ ] 7.1 Build the supported indicator schema and pure calculation registry
    - Define EMA, VWAP, RSI, MACD, Volume, ATR, Bollinger Bands, and Supertrend schemas with defaults, finite ranges/steps, compatible sources, style fields, placement, pane support, lookback, and null pre-lookback output.
    - Add known-vector and insufficient-history tests for every calculation and reject any expression/parser/plug-in/executable field.
    - _Depends on: 5.6_
    - _Requirements: 3.1, 3.3–3.4, 3.7, 3.9, 3.11_

  - [ ] 7.2 Implement stable-ID instance reducers and atomic validation
    - Add/update/remove/reorder by instance ID, preserve complete last-valid configs on field failure, and enforce 20 instances per tile and 5 per type.
    - Add generated mutation tests covering duplicate types, identity independence, validation messages, limits, visibility, source/style, and placement.
    - _Depends on: 7.1_
    - _Requirements: 3.2–3.8, 3.11_

  - [ ] 7.3 Render indicator overlays and panes through `ChartAdapter`
    - Add memoized revision/config-hash computation, overlay/separate-pane placement, 80px pane minimum, constrained-tile summary fallback, pane order, visibility, and remove-only-target behavior.
    - Add adapter/component tests for duplicate indicator types, pane resize/collapse, null outputs, and unchanged candle interaction responsiveness.
    - _Depends on: 7.1, 7.2_
    - _Requirements: 3.2–3.6, 3.9, 9.2_

  - [ ] 7.4 Build the accessible indicator catalog and inspector
    - Expose only schema-backed controls for parameters, source, style, visibility, placement, removal, and field-specific validation; provide no arbitrary text formula or executable input.
    - Add keyboard/touch/screen-reader tests and explicit 20/5 limit messages.
    - _Depends on: 7.2, 7.3_
    - _Requirements: 3.1–3.8, 3.11, 8.1–8.6, 10.4_

  - [ ] 7.5 Persist and restore complete indicator instance state
    - Serialize IDs, type, parameters, source, style, visibility, placement, pane order, and version through workspace drafts; validate atomically before adapter application.
    - Add round-trip, corrupt-instance quarantine, duplicate-type, and rollback-to-last-valid tests.
    - _Depends on: 7.2–7.4_
    - _Requirements: 3.6–3.10, 7.1, 7.4, 10.3–10.4, 10.8_

  - [ ] 7.6 Verify indicator instance independence and no-code safety
    - **Property 4: Indicator Instance Independence** - Stable independent indicator configurations
    - Generate accepted/rejected collections and mutations; assert one instance never changes another, limits and atomic validation hold, round trips preserve all fields, and no arbitrary code path exists.
    - Add integration coverage for duplicate types in distinct panes, save/reload, remove-one, insufficient history, and feature-local failure isolation.
    - _Depends on: 7.3–7.5_
    - _Requirements: 3.1–3.11, 10.3–10.4_

- [ ] 8. Implement the shared Binance subscription manager
  - _Depends on: 5.6_
  - _Requirements: 1.1, 4.10, 5.5, 5.8–5.10, 6.4–6.6, 6.8, 9.1, 9.4–9.7, 10.3, 10.5_

  - [ ] 8.1 Implement normalized acquire/release leases and ref counts
    - Canonicalize channel/symbol/interval/precision/depth keys, share one physical requirement per key, fan out last-valid state, and cancel pending cleanup on grace-window reacquisition without opening duplicates.
    - Add model-based acquire/release tests with multiple consumers and duplicate consumer actions.
    - _Depends on: 5.6_
    - _Requirements: 4.10, 9.4, 9.7_

  - [ ] 8.2 Add channel-specific market validators and safe fan-out
    - Validate event type, canonical symbol, timestamps, finite ranges, payload sizes, OHLCV/ticker/depth shapes, and foreign-symbol rejection before mutating manager state.
    - Add fuzz/malicious/malformed input tests proving last-valid preservation and no credentials/private endpoints.
    - _Depends on: 8.1_
    - _Requirements: 6.8, 10.3–10.6_

  - [ ] 8.3 Migrate existing kline bootstrap/live behavior behind leases
    - Preserve `TIMEFRAME_TO_BINANCE`, REST history bootstrap, public live kline semantics, O(1) chart updates, simulated mark-price updates, and symbol/timeframe cleanup while replacing singleton ownership.
    - Add parity tests against Task 2, rapid symbol/timeframe switch tests, abort races, and no-duplicate-update assertions.
    - _Depends on: 8.1, 8.2_
    - _Requirements: 1.1, 4.10, 9.1, 9.4, 9.7, 10.5_

  - [ ] 8.4 Add exchange-info, batched ticker, and depth channel ownership
    - Add cached active spot-USDT exchange info, visible-row batched/combined ticker requirements, and active-symbol depth requirements without subscribing non-visible rows individually.
    - Add cache, visibility, fan-out isolation, and channel-key tests; panel reducers remain separate tasks.
    - _Depends on: 8.1, 8.2_
    - _Requirements: 5.1, 5.5, 6.1, 9.4, 10.5_

  - [ ] 8.5 Implement truthful health, stale timers, bounded retry, and cleanup
    - Mark only an expected resource stale after 10 seconds, clear only on a valid fresh event, retain last-valid data as non-current, and implement one jittered bounded retry per key with offline pause/manual reset.
    - Release sockets, requests, timers, listeners, and leases within 5 seconds after the last consumer; add fake-timer/reconnect/offline/cleanup tests.
    - _Depends on: 8.1–8.4_
    - _Requirements: 4.10, 5.8–5.10, 6.5–6.6, 9.4–9.7_

  - [ ] 8.6 Verify subscription uniqueness and cleanup
    - **Property 6: Subscription Uniqueness and Cleanup** - One physical requirement per normalized key
    - Generate acquire/release/reacquire/reconnect sequences and assert physical requirement uniqueness, fan-out isolation, one retry, ref-count correctness, and complete cleanup within 5 seconds.
    - _Depends on: 8.3–8.5_
    - _Requirements: 4.10, 9.4–9.7_

  - [ ] 8.7 Run stream parity, leak, and failure-isolation integration tests
    - Exercise REST-to-WebSocket chart flow, multiple consumers, malformed data, disconnect/reconnect, offline/online, stale recovery, rapid switching, and workspace close.
    - Compare sockets, leases, timers, listeners, requests, and processed updates before/after; re-run Task 2 Binance and chart preservation tests.
    - _Depends on: 8.6_
    - _Requirements: 1.1, 4.10–4.11, 9.1, 9.4–9.7, 10.3, 10.5_

- [ ] 9. Implement 1/2/4-chart layouts and linking
  - _Depends on: 6.7, 7.6, 8.7_
  - _Requirements: 4.1–4.11, 8.1, 8.3, 8.6–8.8, 9.2, 9.4, 9.7_

  - [ ] 9.1 Implement layout and active-tile transition reducers
    - Support exactly 1, 2, or 4 visible tile IDs, exactly one active visible tile, pointer/touch/keyboard activation, stable tile order, and retained serializable hidden-tile state.
    - Add exhaustive transition tests for layout changes, invalid counts/IDs, active-tile replacement, and session restoration.
    - _Depends on: 6.7, 7.6, 8.7_
    - _Requirements: 4.1–4.3, 4.8_

  - [ ] 9.2 Render isolated `ChartTile` adapters in the responsive workspace grid
    - Create one adapter/error boundary/HUD/overlay composition per visible tile, defer secondary initialization until the active chart is ready, and route chart-specific actions only to the active tile.
    - Add 1/2/4 desktop/tablet/mobile geometry and tile-failure-isolation tests.
    - _Depends on: 9.1_
    - _Requirements: 4.1–4.3, 4.8–4.9, 4.11, 9.2–9.3_

  - [ ] 9.3 Implement central symbol and timeframe linking
    - Propagate linked changes to exactly the configured linked tiles, preserve independent unlinked values, and route watchlist/scanner/order actions through the active tile command.
    - Add generated transition tests for link toggles, mixed symbols/timeframes, hidden tiles, and rapid changes.
    - _Depends on: 9.1, 9.2_
    - _Requirements: 4.4–4.5, 4.8, 5.7_

  - [ ] 9.4 Implement exact-time frame-throttled crosshair linking
    - Publish `{sourceTileId,time}` at animation-frame cadence, resolve only exact target time indexes, clear targets without that time, and preserve independent crosshairs when disabled.
    - Add missing-time, different-timeframe, source-destroy, loop-prevention, and performance tests.
    - _Depends on: 9.2_
    - _Requirements: 4.6–4.7, 9.2_

  - [ ] 9.5 Integrate tile leases, hidden-state release, and local retry
    - Acquire requirements per visible tile, share duplicates, release hidden/removed/changed tile leases within 5 seconds, retain only serializable hidden config, and keep failures/retries tile-local.
    - Add switch/hide/restore/close leak tests and verify other tiles remain interactive during one tile's failure.
    - _Depends on: 9.2–9.4_
    - _Requirements: 4.8, 4.10–4.11, 9.4–9.7_

  - [ ] 9.6 Verify chart layout and linking invariants
    - **Property 5: Chart Layout and Linking** - Active tile, retained state, and scoped propagation
    - Generate 1/2/4 layout, activation, link-toggle, field-change, hide/restore, and failure sequences; assert exactly one active visible tile, correct linked/unlinked behavior, exact-time crosshairs, and retained state.
    - Add end-to-end independent/linked symbol, timeframe, crosshair, responsive layout, and lease-cleanup coverage.
    - _Depends on: 9.3–9.5_
    - _Requirements: 4.1–4.11_

- [ ] 10. Implement the Binance USDT watchlist and scanner
  - _Depends on: 9.6_
  - _Requirements: 5.1–5.11, 8.1–8.7, 9.1, 9.4–9.6, 10.3–10.4_

  - [ ] 10.1 Build the eligible-market catalog and symbol search
    - Derive active Binance spot USDT markets and recognizable asset names from validated exchange info; implement deterministic normalized symbol/name search and unavailable-market handling.
    - Add catalog validation, query, suspended/delisted, loading/empty/error, and styled-combobox accessibility tests.
    - _Depends on: 9.6_
    - _Requirements: 5.1, 5.8–5.9, 5.11, 10.3–10.4_

  - [ ] 10.2 Implement ordered duplicate-free watchlist state
    - Add favorite/unfavorite/reorder commands, stable IDs/order, 100-entry limit, unavailable marking/removal, local persistence, and explicit messages without unsolicited active-symbol changes.
    - Add generated set/order/limit/round-trip tests and storage failure recovery.
    - _Depends on: 10.1_
    - _Requirements: 5.2–5.4, 5.11, 7.1, 9.8_

  - [ ] 10.3 Implement deterministic scanner rows, filters, and stable sorting
    - Normalize price, 24h percentage change, and quote volume; apply supported symbol/price/change/volume criteria with symbol as stable secondary sort and clearly expose active criteria.
    - Batch live row updates at animation-frame cadence and subscribe only visible requirements; add generated sort/filter determinism and update batching tests.
    - _Depends on: 10.1, 8.7_
    - _Requirements: 5.5–5.6, 9.1–9.2, 9.4_

  - [ ] 10.4 Build watchlist/scanner panels with truthful live states
    - Display loading without fake live values, last-valid stale/disconnected data with non-color labels, error/retry, unavailable rows, and keyboard/touch activation.
    - Route row activation through `changeActiveTileSymbol` so only the active or configured linked tiles change; add component/integration tests for every state.
    - _Depends on: 10.2, 10.3_
    - _Requirements: 5.5, 5.7–5.11, 8.1–8.6, 9.5–9.6_

  - [ ] 10.5 Verify deterministic watchlist and scanner behavior
    - **Property 7: Watchlist and Scanner Determinism** - Ordered favorites and scoped row activation
    - Generate eligible catalogs, queries, filters/sorts, watchlist operations, live states, and link configurations; assert deterministic rows, duplicate-free order, limits, truthful health, and active/linked tile routing.
    - _Depends on: 10.2–10.4_
    - _Requirements: 5.1–5.11_

  - [ ] 10.6 Run watchlist/scanner persistence, accessibility, and failure integration tests
    - Exercise reload, rapid filter changes, viewport virtualization/visibility, disconnect/stale/fresh/retry, unavailable markets, auth namespace changes, mobile drawer use, and one-panel failure isolation.
    - Confirm no row action submits or prefills an order without opening the explicit paper-order flow.
    - _Depends on: 10.5_
    - _Requirements: 5.1–5.11, 8.1–8.8, 9.1, 9.4–9.8, 10.9_

- [ ] 11. Implement sequence-safe Binance order book
  - _Depends on: 9.6_
  - _Requirements: 6.1–6.8, 8.1–8.7, 9.1, 9.4–9.7, 10.3, 10.9_

  - [ ] 11.1 Implement validated snapshot/diff synchronization
    - Buffer validated diffs, validate the REST snapshot, discard old events, enforce the first bridge and every contiguous update/previous ID, apply absolute quantities, delete zero quantities, and reject crossed books.
    - On malformed/foreign/gapped input stop current publication and restart from a fresh synchronized snapshot; add table-driven sequencing tests.
    - _Depends on: 9.6, 8.7_
    - _Requirements: 6.4–6.6, 6.8, 10.3_

  - [ ] 11.2 Implement precision aggregation, ordering, spread, and depth caps
    - Validate supported tick precision and 10/25/50/100 depth, aggregate quantities, sort bids descending/asks ascending, calculate spread, and cap after aggregation.
    - Add numerical boundary, zero deletion, finite value, precision, sorting, spread, and cap tests.
    - _Depends on: 11.1_
    - _Requirements: 6.1–6.3, 6.8_

  - [ ] 11.3 Integrate active-symbol depth leases and truthful recovery states
    - Release obsolete depth, clear mismatched visible levels immediately, synchronize the new symbol, preserve last-valid data only as labeled stale/disconnected context, and mark current only after a valid synchronized snapshot.
    - Add rapid-symbol switch, late foreign message, disconnect/reconnect, stale timer, retry, and cleanup tests.
    - _Depends on: 11.1, 11.2_
    - _Requirements: 6.4–6.6, 6.8, 9.4–9.7_

  - [ ] 11.4 Build the accessible order-book panel and paper-price prefill
    - Render valid level quantities, spread, precision/depth controls, loading/stale/error/retry states, and keyboard/touch activation.
    - Route level activation only to `openPaperOrderDraft` for the current active tile; prove it cannot submit, confirm, auto-execute, or reach a live/private endpoint.
    - _Depends on: 11.2, 11.3_
    - _Requirements: 6.1–6.7, 8.1–8.6, 10.5, 10.9_

  - [ ] 11.5 Verify order-book sequence safety
    - **Property 8: Order-Book Sequence Safety** - Contiguous active-symbol depth only
    - Generate valid snapshots/deltas plus malformed numbers, gaps, duplicate/old IDs, foreign symbols, zero quantities, crossed books, precisions, and depths; assert no invalid mutation, deterministic aggregation/order/caps, and required resynchronization.
    - _Depends on: 11.1–11.4_
    - _Requirements: 6.1–6.8_

  - [ ] 11.6 Run order-book stream, recovery, and paper-only integration tests
    - Exercise snapshot/buffer bridge, sustained diffs, precision/depth changes, stale/disconnect/recovery, active symbol switch, panel failure isolation, mobile use, and price prefill review.
    - Assert socket/lease/timer cleanup and zero `placeOrder`/live-order calls before explicit paper submit.
    - _Depends on: 11.5_
    - _Requirements: 6.1–6.8, 8.1–8.8, 9.4–9.7, 10.9_

- [ ] 12. Implement Firebase layouts, ownership, conflicts, and recovery
  - _Depends on: 6.7, 7.6, 10.6, 11.6_
  - _Requirements: 2.9, 7.1–7.12, 9.8, 10.1–10.8_

  - [ ] 12.1 Implement the validated versioned layout envelope and size limits
    - Define schema version, layout/name/revision/parent/timestamps/device/payload/hash, plain-text 1–80 character normalized unique names, collection limits, total-size checks, and supported workspace payload fields.
    - Add schema, name collision, oversized payload, inert text, hash, and last-valid preservation tests.
    - _Depends on: 6.7, 7.6, 10.6, 11.6_
    - _Requirements: 7.1, 7.3–7.4, 7.9–7.10, 10.3–10.4_

  - [ ] 12.2 Implement pure migrations and staged atomic layout loading
    - Add sequential idempotent supported-version migrations and parse → schema validate → migrate → domain validate → stage adapters → atomic commit loading.
    - Reject unsupported/corrupt versions without changing the current workspace and offer last-valid local/cloud recovery; add migration idempotence, partial-stage failure, and rollback tests.
    - _Depends on: 12.1_
    - _Requirements: 7.4, 7.9–7.10, 10.8_

  - [ ] 12.3 Implement authenticated UID-owned Firebase CRUD and rules
    - Derive layout/drawing/preference paths only from Firebase Auth, enforce normalized-name uniqueness transactionally, and implement list/create/rename/duplicate/delete-confirmation without silent overwrite.
    - Update ownership rules only for approved UID-owned paths and add two-user emulator get/list/create/update/delete denial tests without disclosing content.
    - _Depends on: 12.1_
    - _Requirements: 7.1–7.4, 7.11, 10.1–10.2, 10.4, 10.6–10.7_

  - [ ] 12.4 Implement local draft, autosave, offline sync, and retry status
    - Guarantee local draft saves within 5 seconds and online Firebase autosave within 30 seconds, retain dirty/base/local revisions, display truthful local/sync-pending/error states, and retry after auth/connectivity recovery.
    - Add fake-timer, offline/reconnect, write failure, newer-local preservation, and last-valid-copy tests.
    - _Depends on: 12.1, 12.3_
    - _Requirements: 7.5–7.7, 7.12, 9.8_

  - [ ] 12.5 Implement revision conflict detection and explicit resolution UI
    - Use compare-against-base remote transactions, preserve both divergent descendants with timestamps/device labels, and require Keep local, Use cloud, or Duplicate both before replacement.
    - Ensure resolution creates a new revision and never uses implicit last-write-wins; add generated revision-graph tests and accessible conflict-dialog tests.
    - _Depends on: 12.3, 12.4_
    - _Requirements: 7.7–7.8, 7.12, 8.1–8.5_

  - [ ] 12.6 Synchronize pair drawings/preferences and isolate authentication changes
    - Store validated drawings/preferences in UID-owned documents, release old UID persistence/subscription handles before loading the next namespace, and never copy private data between users.
    - Quarantine invalid drawing slices, retain recovery copies, and add sign-in/sign-out/account-switch emulator tests.
    - _Depends on: 12.3, 12.4, 6.7_
    - _Requirements: 2.9, 7.2, 7.6–7.7, 10.1–10.4, 10.8_

  - [ ] 12.7 Verify versioned layout recovery and authenticated ownership
    - **Property 9: Versioned Layout Recovery** - Atomic load, migration, and conflict preservation
    - **Property 12: Authenticated Ownership and Safe Validation** - Auth-derived isolation and inert external data
    - Generate layout histories, revision graphs, versions, corrupt/oversized fields, and two-user operations; assert atomic loading, recognized migration preservation, no silent conflict loss, auth-derived paths, denial, and last-valid recovery.
    - _Depends on: 12.2–12.6_
    - _Requirements: 7.1–7.12, 10.1–10.8_

  - [ ] 12.8 Harden exactly-once Pro Trading journal persistence without changing the bridge API
    - Preserve `useTradeBridge` mapping and sole-writer ownership while making `addTrade` idempotent for `source: pro_trading` under authenticated UID and deterministic `pro_${closedTrade.id}` document identity/transaction semantics.
    - Add emulator tests for retries, concurrent duplicate requests, multi-append, baseline/reset, partial close/reverse/SL/TP/liquidation, and cross-user isolation; retries must return the existing record.
    - Re-run Task 2 bridge characterization and prove no workspace store writes journal records.
    - _Depends on: 12.3_
    - _Requirements: 1.3–1.4, 10.1–10.2, 10.6, 10.8_

  - [ ] 12.9 Run complete layout CRUD/offline/conflict/recovery integration tests
    - Exercise create/list/load/rename/duplicate/delete confirmation, reload, autosave, offline draft, reconnect, conflict choices, migration, corrupt/unsupported load, drawings/indicators/watchlist restore, auth switching, and emulator denial.
    - Confirm deletion preserves active memory, failure never reports success, one last-valid copy remains, and paper/journal/unrelated local data is untouched.
    - _Depends on: 12.7, 12.8_
    - _Requirements: 1.3–1.5, 7.1–7.12, 9.8, 10.1–10.8_

- [ ] 13. Complete accessibility, reliability, security, and performance hardening
  - _Depends on: 12.9_
  - _Requirements: 1.5, 5.8–5.10, 6.5–6.6, 8.1–8.8, 9.1–9.8, 10.3–10.9, 11.8, 11.10–11.13_

  - [ ] 13.1 Complete the registry-driven contextual shortcut system
    - Register only documented non-reserved shortcuts, disable them in text inputs, scope undo/redo/delete/Escape/navigation to valid active contexts, and expose a visible equivalent and description for every shortcut.
    - Add generated context/focus tests proving actions never leak to an inactive tile, locked drawing, closed menu, or paper-order submit.
    - _Depends on: 12.9_
    - _Requirements: 8.1–8.3, 10.9_

  - [ ] 13.2 Complete advanced-feature keyboard, screen-reader, touch, and zoom support
    - Verify names/roles/states/messages/live regions/focus order for charts, drawings, indicators, layouts, watchlist, scanner, order book, dock, and paper controls; add touch alternatives and 44px touch targets.
    - Run automated accessibility, keyboard-only, screen-reader-oriented, contrast, forced-colors, reduced-motion, 200% zoom, 320px width, and gesture-conflict tests.
    - _Depends on: 13.1_
    - _Requirements: 8.1–8.8, 11.10–11.11_

  - [ ] 13.3 Add feature-level error boundaries and recoverable state isolation
    - Wrap individual tiles, drawings, indicators, scanner, order book, and layout manager; preserve baseline chart/paper access, last-valid stale data, and retry/reset only for the affected feature.
    - Add injected initialization/runtime/storage/network failures and prove unaffected features, paper state, journals, and other tiles remain usable.
    - _Depends on: 12.9_
    - _Requirements: 1.5, 4.11, 5.9, 6.5–6.6, 7.10, 7.12, 9.4–9.8, 10.8_

  - [ ] 13.4 Verify truthful per-resource live-data health
    - **Property 11: Truthful Live-Data Health** - Isolated stale, disconnect, retry, and recovery states
    - Generate heartbeat/message/disconnect/retry timelines across chart/ticker/depth resources; assert 10-second stale transitions, valid-fresh clearing, one bounded retry, labeled last-valid data, and unrelated-resource isolation.
    - _Depends on: 13.3, 8.7, 10.6, 11.6_
    - _Requirements: 5.8–5.10, 6.5–6.6, 9.1, 9.4–9.6_

  - [ ] 13.5 Verify every market interaction remains paper-only
    - **Property 13: Paper-Only Market Interactions** - Selection or draft prefill, never direct/live execution
    - Generate quote, chart, context-menu, order-book, scanner, watchlist, marker, line, alert, drawing, and shortcut actions; assert they only select a market or open a validated draft and that only explicit existing submit calls `tradingStore.placeOrder`.
    - Assert no exchange API key storage, authenticated Binance client import, private endpoint, live order, or automated execution path exists.
    - _Depends on: 12.9, 13.1_
    - _Requirements: 1.2, 6.7, 10.5, 10.9, 11.6_

  - [ ] 13.6 Add safe external-data validation and redacted diagnostics
    - Apply expected type/range/sequence/size/schema validation at persisted and market-data boundaries, inert normalization for text/styles/filters/prices, safe error codes/context, and redaction of tokens, credentials, payload text, stack details, and private layouts.
    - Add malicious corpus, oversized payload, log-capture, endpoint allowlist, corrupt-slice isolation, and last-valid-state tests.
    - _Depends on: 12.9, 13.3_
    - _Requirements: 10.3–10.8_

  - [ ] 13.7 Instrument and measure the required responsiveness distributions
    - Add receipt-to-paint, interaction-to-paint, and mount-to-active-chart-ready marks; batch scanner/crosshair/geometry events, keep live candles O(1), and use narrow selectors.
    - Under 4 charts × 5,000 candles × supported indicator/drawing limits, measure at least 1,000 market updates and representative interactions; report percentages within 1s, 200ms, and 3s rather than averages.
    - Add leak snapshots for sockets, leases, timers, observers, listeners, adapters, panes, and primitives before/after close; document the baseline device/environment.
    - _Depends on: 13.3, 13.4_
    - _Requirements: 9.1–9.3, 9.7, 11.8_

  - [ ] 13.8 Verify accessible contextual interaction invariants
    - **Property 10: Accessible Contextual Interaction** - Named, focused, scoped, and modality-equivalent actions
    - Generate focus/context/modality transitions and assert visible focus, accessible names/states, active-target-only shortcuts, focus restoration, topmost dismissal, and keyboard/touch equivalents.
    - _Depends on: 13.1, 13.2_
    - _Requirements: 8.1–8.8_

  - [ ] 13.9 Verify measured responsiveness and reliability targets
    - **Property 14: Measured Responsiveness** - 95th-percentile acceptance distributions
    - Run the instrumented baseline repeatedly and require at least 95% of updates within 1 second, interactions within 200ms, and eligible cold loads within 3 seconds; fail on leaks, duplicate processing, or unbounded retries.
    - If indicator computation is the measured blocker, record the triggering profile for Task 13.10; otherwise explicitly skip that optional task.
    - _Depends on: 13.5–13.8_
    - _Requirements: 9.1–9.7, 11.8_

  - [ ] 13.10 Optional enhancement — move profiled indicator computation off the interaction path
    - **OPTIONAL/TRIGGERED ONLY**: Start only if Task 13.9 fails a required target and profiling identifies indicator calculation as the material cause.
    - Implement a validated worker protocol with revision/config-hash cancellation and deterministic fallback, or a measured chunked scheduler if worker overhead is worse; do not move chart handles or executable code across the boundary.
    - Re-run indicator vectors/Property 4 and the exact Task 13.9 profile; keep the change only if correctness is identical and required distributions improve.
    - _Depends on: 13.9 (triggered failure with documented indicator bottleneck)_
    - _Requirements: 3.9, 9.2, 10.3–10.4_

- [ ] 14. Final regression, visual, security, recovery, and release validation
  - _Depends on: 13.9; 13.10 only if triggered_
  - _Requirements: 1.1–11.13_

  - [ ] 14.1 Run the complete functional and property regression suite
    - Run all unit, property-based, integration, emulator, accessibility, and leak suites for Properties 1–14, including 1/2/4 charts and all advanced feature limits.
    - Re-run Dashboard, manual Add Trade, Trade History, authentication, Settings, trading-store, chart, Binance, and journal tests; fix regressions without updating preservation oracles to accept changed behavior.
    - _Depends on: 13.9; 13.10 if triggered_
    - _Requirements: 1.1–10.9_

  - [ ] 14.2 Capture and approve the full visual/geometry matrix
    - Capture 1920×1080, 1366×768, 1024×768, 768×1024, and 390×844 for 1/2/4 layouts as applicable, all edge menus, rails/drawers, docks, paper order, drawings, indicator panes, utility panels, overlays, stale/error/conflict states, and maximum labels.
    - Re-run the exact Task 1 geometry assertions and require no viewport/page overflow, forbidden overlap, clipping, missing essentials, scale/HUD obstruction, or geometry-cap violation.
    - Require human review for original identity, discernible candles/wicks/watermark, non-color states, and readable paper overlays.
    - _Depends on: 14.1_
    - _Requirements: 4.9, 8.5–8.8, 11.1–11.13_

  - [ ] 14.3 Run final performance and resource-cleanup acceptance
    - Re-run the documented Task 13.9 profile with production-like build settings, at least 1,000 updates, four charts, 5,000 candles each, supported indicator limits, utility streams, drawings, and repeated open/close cycles.
    - Publish percentage distributions and before/after resource counts; block release unless all 1s/200ms/3s, stale, retry, and 5-second cleanup contracts pass.
    - _Depends on: 14.1_
    - _Requirements: 4.10, 9.1–9.7, 11.8_

  - [ ] 14.4 Run final persistence, ownership, validation, and paper-only security acceptance
    - Run two-user Firebase emulator denial, layout CRUD/offline/conflict/migration/corruption/recovery, drawing/indicator/watchlist restoration, journal idempotency, malicious input, redacted logging, endpoint allowlist, and no-arbitrary-code checks.
    - Confirm no exchange credentials/private endpoints/live execution and no reset/recovery path can delete paper/journal/unrelated product data.
    - _Depends on: 14.1_
    - _Requirements: 2.8–2.10, 3.7–3.11, 7.1–7.12, 9.8, 10.1–10.9_

  - [ ] 14.5 Re-run the original bug and preservation gates unchanged
    - **Property 1: Expected Behavior** - Terminal Geometry Is Safe
    - **Property 2: Preservation** - Paper Trading and Journal Behavior
    - Run the SAME Task 1 and Task 2 tests/oracles against the completed workspace; require geometry safety for all generated supported states and identical paper/Binance/chart/journal/adjacent-route behavior.
    - _Depends on: 14.2–14.4_
    - _Requirements: 1.1–1.5, 4.9, 8.7, 9.4–9.7, 10.8–10.9, 11.2–11.13_

  - [ ] 14.6 Validate feature flags, failure isolation, and rollback recovery
    - Disable each advanced slice independently, inject feature initialization failures, load corrupt advanced state, and simulate auth/network/storage failures.
    - Confirm the clean single-chart shell and explicit paper-order flow remain available, rollback restores the last-valid local single-chart workspace, and paper/journal state is never rewritten or cleared.
    - _Depends on: 14.1, 14.4_
    - _Requirements: 1.5, 4.11, 7.10, 7.12, 9.4–9.8, 10.8_

  - [ ] 14.7 Final checkpoint — approve the advanced charting release
    - Confirm every required leaf task and gate is complete, all required tests pass, all artifacts are reviewable, no optional task remains ambiguously triggered, and requirement traceability covers every acceptance criterion.
    - Record approved commands/results, screenshot review, measured distributions, emulator/security results, known upstream exclusions, and rollback verification.
    - Do not approve release if any geometry, preservation, exactly-once journal, paper-only, ownership, stale-data, cleanup, accessibility, or performance invariant is unresolved.
    - _Depends on: 14.5, 14.6_
    - _Requirements: 1.1–11.13_
