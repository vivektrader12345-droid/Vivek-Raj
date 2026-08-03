# Pro Trading Advanced Charting Workspace — Technical Design

## Overview

This design replaces the current organically positioned Pro Trading screen with an original, deterministic professional-terminal workspace, then incrementally adds drawings, multiple indicator instances, multi-chart layouts, watchlist/scanner, order book, and versioned per-user layouts. The first release priority is to restore a clean single-chart experience at every required viewport: symbol choices render as styled application controls, timeframes and toolbars never overlap, both rails have reserved space, bottom tabs have measurable spacing, and the chart retains a useful canvas at 1024×768.

The solution keeps advanced workspace state separate from the existing paper-trading and journal stores. Public Binance data remains the only market source, `lightweight-charts` remains the chart engine, paper orders continue through the existing explicit simulated-order flow, and `useTradeBridge` remains the sole Pro Trading-to-Firestore journal bridge.

## Goals and Non-Goals

### Goals

- Deliver a deterministic, overflow-safe shell at 1920×1080, 1366×768, 1024×768, tablet, and 390×844.
- Preserve all existing chart, paper-trading, journal, Dashboard, manual-entry, authentication, Settings, marker, order-line, risk/reward, and fullscreen contracts.
- Add safe, no-code drawings and independently configurable indicator instances.
- Support exactly 1, 2, or 4 retained chart tiles with optional symbol, timeframe, and crosshair linking.
- Share and deduplicate validated Binance subscriptions among charts, watchlist/scanner, and depth consumers.
- Persist recoverable local workspace state and synchronize versioned, per-user layouts to Firebase without silent conflict loss.
- Meet keyboard, touch, screen-reader, stale-data, isolation, and measured performance requirements.
- Keep the visual language original: dense graphite surfaces, cyan/amber accents, compact rails, and a restrained watermark, without reproducing another terminal pixel-for-pixel.

### Non-Goals

- Live exchange order execution, exchange account access, API keys, deposits, or withdrawals.
- Pine Script, JavaScript, executable formulas, plug-ins, uploaded code, or automated strategies.
- Non-Binance market data, Chrome extension work, or an automated trading engine.
- Replacing the existing paper-trading accounting model or journal data model as part of workspace delivery.
- Recreating TradingView or any other proprietary terminal.

## Glossary

- **Bug_Condition (C)**: A supported viewport/render state in which a terminal element clips, overlaps, escapes the viewport, creates page-level horizontal scrolling, disappears without an accessible replacement, or leaves an undersized chart canvas.
- **Property (P)**: The required geometry, accessibility, state, and behavior invariants after the shell is rendered.
- **Preservation**: Existing behavior outside C, especially paper execution and journaling, that must remain unchanged.
- **WorkspaceStore**: Persistable advanced layout configuration, separate from paper positions/orders/trades.
- **RuntimeStore**: Ephemeral active UI, live data, chart handles, health, and interaction state.
- **ChartAdapter**: The only layer that creates and imperatively updates `lightweight-charts` instances.
- **SubscriptionManager**: A ref-counted owner of Binance REST/bootstrap requests, WebSockets, stale timers, retries, and validated fan-out.
- **PairKey**: Canonical `SYMBOL@TIMEFRAME`, for example `BTCUSDT@1m`, used to isolate drawings.
- **Revision**: An immutable layout version identifier with a parent revision used for conflict detection.

## Preserved Existing Contracts

The following are compatibility boundaries, not candidates for opportunistic redesign:

1. **Paper-trading store:** `src/trading/stores/tradingStore.js` remains the source of truth for positions, pending orders, closed trades, and account state. Its persisted Zustand key remains exactly `pro-trading-store`, and its persisted subset remains `positions`, `pendingOrders`, `trades`, and `account`. Existing market/limit/stop fill rules, fees, margin, P&L, SL/TP/liquidation, partial close, reverse, close-all, and reset semantics are unchanged.
2. **Settings compatibility:** Existing preferences under `pro-trading-settings` remain readable. A migration may copy supported display values into workspace preferences, but must not delete or reinterpret order defaults and notification settings.
3. **Paper-only execution:** UI actions may create an order draft or call the existing `placeOrder` only after the current explicit paper-order submission/confirmation flow. No advanced component receives exchange credentials or an exchange order client.
4. **Journal bridge:** `useTradeBridge` remains mounted once at the Pro Trading boundary and remains the sole bridge for closed Pro Trading trades. Its contract is preserved: establish the persisted trade-count baseline at mount, reset the baseline when local history is reset, advance the count before asynchronous writes, process every newly appended trade, and map each close to deterministic `tradeId: pro_${closedTrade.id}` with `source: pro_trading`. Advanced workspace stores never append journal records.
5. **Exactly-once remote journaling:** The `addTrade` API exposed to `useTradeBridge` remains unchanged. For `source: pro_trading`, the Firestore service must use the authenticated UID and deterministic `tradeId` as an idempotency key (create-if-absent/transaction at the UID-owned trade document, or equivalent query-and-transaction). Retries return the existing record rather than create another. This hardens remote exactly-once delivery without changing hook mapping or creating a second writer.
6. **Binance public data:** Existing Binance public REST kline bootstrap and public WebSocket kline semantics remain supported. The manager extends this with public exchange-info, ticker, and diff-depth channels; it never sends credentials. Existing symbol/timeframe representations and `TIMEFRAME_TO_BINANCE` mappings remain compatible.
7. **Chart engine:** `lightweight-charts` 4.1.1 remains the renderer. Candle time remains epoch seconds; OHLCV values remain finite numbers. Existing wheel zoom, drag/pan, axis drag, double-click reset, auto-scale, fullscreen, volume, crosshair, price line, time scale, screenshot, chart styles, markers, order lines, and risk/reward overlays are retained through adapters.
8. **Product isolation:** Journal, Dashboard, manual Add Trade, Trade History, authentication, and Settings continue to use their existing contexts/services. Workspace reset and corrupt-state recovery are forbidden from deleting `pro-trading-store`, journal documents, or unrelated local-storage keys.

## Observed Layout Defect and Formal Condition

### Current Defect

The current shell combines a long fixed-width symbol control, many timeframe buttons, toolbar actions, absolute chart overlays, a floating 72px drawing toolbar, a conditional 300px sidebar, and a wide bottom-tab row. At constrained widths this creates clipped or raw-looking symbol choices, horizontal toolbar competition, overlay collisions, rails that disappear or cover chart information, crowded tabs, and too little usable chart area. Absolute menus are positioned relative to local containers rather than the viewport.

### Bug Condition

Let `X` contain viewport dimensions, rendered element rectangles, visibility, scroll metrics, active layout state, and chart-canvas bounds. Let `E` be all visible controls, menus, rails, tabs, chart labels/scales, and order overlays, and let `K` be the allowed-overlap matrix (for example a menu may overlay its backdrop but not escape the viewport).

`C(X)` is true if any supported render violates viewport containment, non-overlap, essential-control availability, or chart allocation.

**Formal Specification:**

```text
FUNCTION isBugCondition(X)
  INPUT: X of type TerminalRenderSnapshot
  OUTPUT: boolean

  clipped := EXISTS e IN X.visibleElements WHERE
               e.scrollWidth > e.clientWidth AND NOT e.hasApprovedInternalScroll
  escaped := EXISTS e IN X.openMenusAndControls WHERE NOT viewportContains(e.rect, X.viewport, 8)
  overlap := EXISTS (a, b) IN X.visibleElements WHERE
               intersects(a.rect, b.rect) AND NOT K.allows(a.role, b.role)
  pageOverflow := X.document.scrollWidth > X.document.clientWidth
  missingEssential := NOT allReachable([
    marketSelector, activeChartIndicator, chartCanvas, paperBuy, paperSell, positionStatus
  ])
  missingDesktopRail := X.viewport.width >= 1024 AND
                        (NOT X.leftRail.reserved OR NOT X.rightRail.reserved)
  crowdedTabs := EXISTS adjacentTabs WHERE gap(adjacentTabs) < 8
  smallDefaultCanvas := X.viewport = (1366, 768) AND X.sidePanelsCollapsed AND
                        (X.chart.width < 0.70 * X.viewport.width OR
                         X.chart.height < 0.60 * X.viewport.height)

  RETURN clipped OR escaped OR overlap OR pageOverflow OR missingEssential OR
         missingDesktopRail OR crowdedTabs OR smallDefaultCanvas
END FUNCTION
```

```text
FUNCTION expectedBehavior(X)
  INPUT: X of type TerminalRenderSnapshot
  OUTPUT: boolean

  RETURN NOT isBugCondition(X)
         AND X.desktopHeader.height <= 88 WHEN X.viewport.width >= 1024
         AND X.expandedLeftRail.width <= 44
         AND X.expandedRightRail.width <= 44
         AND X.collapsedDock.height <= 40
         AND X.expandedDock.height <= 240
         AND priceAndTimeScalesVisible(X)
         AND allMenusAreStyledApplicationControls(X)
END FUNCTION
```

### Concrete Manifestations

- At 1024×768, the fixed symbol selector, full timeframe list, and toolbar compete in two flex rows; controls clip or require unmanaged horizontal movement while absolute overlays reduce chart clarity.
- The current drawing toolbar is 72px wide, exceeding the 44px rail contract, floats over the plot, and may hide labels or candles.
- The right sidebar is either a 300px content panel at wide breakpoints or absent; there is no permanently reserved compact right action rail.
- Nine bottom tabs fit by horizontal scrolling but lack a deterministic minimum inter-tab gap and can read as an unspaced string.
- Locally positioned popovers/context menus can be cut off by `overflow-hidden` ancestors.

## Expected Behavior and Preservation Requirements

### Unchanged Behaviors

- A user sees the same paper account, positions, pending orders, closed trades, P&L, order lines, trade markers, and risk/reward information before and after the shell migration.
- Closing a Pro Trading position appends one local closed trade and produces one authenticated Firestore journal entry through `useTradeBridge`.
- Symbol/timeframe changes still fetch historical Binance candles, subscribe to live candles, update the simulated mark price, and release obsolete data resources.
- Existing chart interactions and display settings continue to work.
- Advanced-feature initialization failures do not prevent baseline charting or paper-order access.

### Scope of Preservation

All non-workspace product routes and data are outside the advanced persistence namespace. A workspace migration may read existing chart/settings values but cannot mutate existing paper positions, pending orders, closed trades, account values, journal records, authentication state, or unrelated settings.

## Hypothesized Root Cause

1. **Competing flex and absolute layouts:** Controls use fixed minimum widths and absolute offsets without one shared geometry model.
2. **No containment boundary:** Popovers are descendants of `overflow-hidden` terminal regions, so z-index cannot prevent clipping.
3. **State and renderer coupling:** A singleton chart store contains chart handles, live candles, symbol, indicators, and drawings, making multi-chart ownership and cleanup ambiguous.
4. **Singleton stream lifecycle:** The current module-global WebSocket disconnects before every connect and cannot represent shared or multi-tile requirements.
5. **Boolean indicator model:** Indicator type toggles cannot represent multiple instances, independent settings, or panes.
6. **Global drawings:** Drawings are not isolated by user/symbol/timeframe and lack command history and validated serialization.
7. **Unversioned workspace persistence:** Current settings persistence has no schema migration, remote revision, conflict, or last-valid recovery model.

## Correctness Properties

Property 1: Bug Condition — Terminal Geometry Is Safe

_For any_ supported viewport and terminal state, if `isBugCondition` identifies clipping, overlap, viewport escape, page overflow, missing rails/essentials, crowded tabs, or inadequate default chart allocation, the fixed shell SHALL satisfy `expectedBehavior` after deterministic responsive reflow.

**Validates: Requirements 4.9, 8.7, 11.2–11.5, 11.9–11.13**

Property 2: Preservation — Paper Trading and Journal Behavior

_For any_ paper-order/position history where the layout bug condition does not alter trading semantics, the advanced workspace SHALL produce the same paper store transition as the original store and SHALL journal each newly appended closed trade exactly once under the authenticated user and deterministic `tradeId`.

**Validates: Requirements 1.1–1.5, 10.8–10.9**

Property 3: Drawing Isolation and Reversible Mutation

_For any_ valid drawing command sequence, each symbol-timeframe pair SHALL expose only its own drawings; undo SHALL apply the command inverse, redo SHALL reapply it, and a mutation after undo SHALL remove the unreachable redo branch.

**Validates: Requirements 2.1–2.11**

Property 4: Indicator Instance Independence

_For any_ accepted set of indicator instances within limits, adding, editing, moving, hiding, or removing one instance SHALL not change another instance's ID, parameters, source, style, visibility, or placement, and serialize/restore SHALL preserve all accepted fields.

**Validates: Requirements 3.1–3.11**

Property 5: Chart Layout and Linking

_For any_ valid 1-, 2-, or 4-tile session and any link configuration, exactly one visible tile SHALL be active; linked fields SHALL propagate only to linked tiles, unlinked fields SHALL remain independent, and hidden retained tiles SHALL restore their session state.

**Validates: Requirements 4.1–4.8, 4.11**

Property 6: Subscription Uniqueness and Cleanup

_For any_ set of active consumers, the number of physical Binance requirements SHALL equal the number of distinct normalized subscription keys, and removing the last consumer SHALL release its timers/listeners/socket requirement within 5 seconds.

**Validates: Requirements 4.10, 9.4–9.7**

Property 7: Watchlist and Scanner Determinism

_For any_ eligible market catalog, query, sort/filter specification, and watchlist under 100 entries, search/filter/sort results SHALL be deterministic, favorites SHALL be duplicate-free and ordered, and row activation SHALL affect only the configured active/linked tiles.

**Validates: Requirements 5.1–5.11**

Property 8: Order-Book Sequence Safety

_For any_ valid snapshot and diff sequence, the book SHALL contain sorted, aggregated, depth-limited levels derived only from contiguous updates for the active symbol; malformed, foreign, or gapped updates SHALL not mutate the visible current book and SHALL trigger resynchronization.

**Validates: Requirements 6.1–6.8**

Property 9: Versioned Layout Recovery

_For any_ valid local/remote layout histories, load SHALL replace the workspace only after validation, supported migrations SHALL preserve recognized data, and divergent descendants of one base revision SHALL retain both recoverable versions until explicit resolution.

**Validates: Requirements 7.1–7.12**

Property 10: Accessible Contextual Interaction

_For any_ input modality and valid interaction context, essential actions SHALL have programmatic names and visible focus, contextual shortcuts SHALL affect only their active target, and every shortcut/hover action SHALL have a visible keyboard/touch equivalent.

**Validates: Requirements 8.1–8.8**

Property 11: Truthful Live-Data Health

_For any_ live resource expected to update, no update/heartbeat for 10 seconds SHALL mark only that resource stale; a valid fresh update SHALL clear stale state, while disconnect/retry in one resource SHALL not disable unrelated resources.

**Validates: Requirements 5.8–5.10, 6.5–6.6, 9.1, 9.4–9.6**

Property 12: Authenticated Ownership and Safe Validation

_For any_ workspace request, ownership SHALL derive from Firebase Auth rather than payload identifiers; cross-user operations SHALL be denied, and invalid external/persisted fields SHALL be rejected or normalized without executing content or replacing last-valid state.

**Validates: Requirements 10.1–10.8**

Property 13: Paper-Only Market Interactions

_For any_ chart, order-book, quote, marker, line, scanner, or watchlist interaction, the interaction SHALL at most select a market or prefill an order draft; only explicit submission through the existing paper-order flow may call the simulated store, and no live-order request is possible.

**Validates: Requirements 1.2, 6.7, 10.5, 10.9, 11.6**

Property 14: Measured Responsiveness

_For any_ baseline supported load, at least 95% of valid market updates SHALL render within 1 second, at least 95% of non-network interactions SHALL complete within 200ms, and at least 95% of active-chart cold loads SHALL become usable within 3 seconds excluding declared upstream outages.

**Validates: Requirements 9.1–9.3, 11.8**

## Deterministic CSS Grid Shell

### Grid Contract

`ProTradingTerminal` owns the viewport (`100dvh`, fallback `100vh`) and uses nested CSS Grid rather than competing flex/absolute layout. All tracks that may contain a chart or scroller use `minmax(0, 1fr)` and all grid children use `min-width: 0; min-height: 0`.

```text
terminal rows:    header | workspace | dock | status
workspace cols:   leftRail | chartRegion | utilityPanel | rightRail
chartRegion:      1, 2, or 2x2 tile grid
```

| Profile | Terminal rows | Workspace columns | Tile arrangement | Panel behavior |
|---|---|---|---|---|
| 1920×1080 (`>=1600`) | `84px minmax(0,1fr) var(--dock,36px) 24px` | `40px minmax(0,1fr) var(--panel,0/320px) 40px` | 1; 2 columns; 2×2 | Utility panel may occupy 320px; rails remain 40px |
| 1366×768 (`1200–1599`) | `84px minmax(0,1fr) var(--dock,36px) 24px` | `40px minmax(0,1fr) var(--panel,0/288px) 40px` | 1; 2 columns; 2×2 | Default panel collapsed; user-opened panel occupies 288px |
| 1024×768 (`900–1199`) | `80px minmax(0,1fr) var(--dock,36px) 22px` | `36px minmax(0,1fr) 36px` | 1; 2 columns only if each tile >=420px; 4 tiles 2×2 | Utility content opens as a contained 320px overlay/drawer, not a grid track |
| Tablet portrait (`600–899`, test 768×1024) | `48px 44px minmax(0,1fr) var(--dock,40px)` | `minmax(0,1fr)` | 1; 2/4 tiles stack vertically with each tile >=320px high | Rails become labeled tool drawers; status merges into dock/header |
| Mobile (`320–599`, test 390×844) | `52px minmax(0,1fr) 40px 56px` | `minmax(0,1fr)` | Active tile shown; other retained tiles selected from layout sheet | No fixed rails/panel; essential tools and BUY/SELL are in bottom action bar/drawers |

Desktop header rows are exactly 44px and 40px (1024: 44px and 36px), never more than 88px total. Row one contains Home, market selector, live state, account summary, layout/save/fullscreen, and paper Trade. Row two contains a short priority timeframe set, chart style, indicators, and one `More` menu. Less-used and disabled controls move into `More`; they never consume overflow width. The mobile header is not governed by the compact-desktop 88px rule and uses one market/status row plus accessible drawers.

The default 1366×768 collapsed state yields approximately 1286×624 for the single chart region before borders (94% viewport width and 81% viewport height), exceeding the required 70%/60%. At 1024×768 it yields approximately 952×630. The chart adapter measures the actual tile content box rather than inferring dimensions.

### Rails, HUD, Dock, and Overlay Geometry

- Expanded desktop rails are fixed at 40px (36px at 1024); collapsed rails retain a 28px edge control so they are never missing. A rail is a grid track, never a plot overlay.
- Rail-triggered drawers are separate surfaces. At 1024 and below they portal over non-scale plot space with dismissal; they do not resize below tile minimums.
- Each tile reserves a HUD safe band: 8px inset, legend/OHLC row first, paper quote row second. Price-scale top margin is adjusted so early candles remain readable beneath the reserved band.
- SELL/BUY uses explicit `Paper SELL`/`Paper BUY` labels plus bid, ask, and spread. It opens an order draft/sheet and never executes directly.
- Collapsed dock is 36px desktop and 40px touch. Expanded height is `clamp(160px, 26dvh, 240px)` and cannot violate the single-chart minimum at 1366×768; if space is insufficient it becomes a modal sheet.
- Dock tabs use `display:flex`, `column-gap:8px`, 12px inline padding, and a visible active indicator. The tab strip is its own approved horizontal scroller with keyboard scroll buttons and edge fades; it cannot increase document width.
- Position/order overlays use a dedicated right-side safe lane offset from the price scale, collision-group stacking, opacity, and compact labels. Labels never cover OHLC or the last-price label.

## Scoped Stylesheet and Layering Contracts

`src/trading/ProTrading.jsx` (or the new terminal entry component) directly imports `./ProTradingTerminal.css`. The stylesheet is not appended to global `src/index.css`. Every selector is rooted at `[data-pro-terminal]` or uses a locally prefixed class.

Scoped reset:

```css
[data-pro-terminal], [data-pro-terminal] * { box-sizing: border-box; }
[data-pro-terminal] { width: 100%; height: 100dvh; min-width: 0; overflow: hidden; }
[data-pro-terminal] button,
[data-pro-terminal] input,
[data-pro-terminal] select { font: inherit; min-width: 0; }
[data-pro-terminal] button { border: 0; margin: 0; }
[data-pro-terminal] img,
[data-pro-terminal] canvas,
[data-pro-terminal] svg { max-width: 100%; }
```

Only approved internal surfaces (`tablist`, tables, watchlist/scanner, catalogs) may scroll. The terminal root and `body` must not acquire horizontal overflow. Native `<select size>` lists are not used for market menus; styled listboxes are portal surfaces.

Layer tokens are fixed: chart canvas `0`, chart primitives `10`, drawings `20`, order overlays `24`, tile HUD `30`, rails/header/dock `40`, drawers `60`, popovers `80`, modal/backdrop `100`, toast `120`. Creating arbitrary z-index values outside these tokens is prohibited. Portals render under a single `#pro-terminal-portal-root` attached to `document.body` and inherit theme variables through a portal theme class.

## Component Boundaries

- `ProTradingTerminal`: composition, feature gates, `useTradeBridge`, error boundaries, fullscreen, and shell geometry only.
- `TerminalHeader`: priority controls and overflow menu; no stream ownership.
- `WorkspaceGrid`: renders exactly 1/2/4 `ChartTile` instances and controls active-tile focus/link propagation.
- `ChartTile`: tile-level loading/error boundary, HUD safe zones, chart host, and overlay composition.
- `ChartAdapter`: creates/removes `lightweight-charts`, owns series/panes/primitives, maps coordinates, and exposes imperative chart operations.
- `DrawingRail`, `DrawingLayer`, `DrawingInspector`, `DrawingManager`: catalog, pointer state machine, rendering/hit testing, editing, and hidden-item management.
- `IndicatorCatalog`, `IndicatorInspector`, `IndicatorPaneHost`: schema-driven instance management and rendering.
- `ActionRail`/`UtilityDrawer`: watchlist, scanner, order book, layout manager, and paper-order entry access.
- `WatchlistPanel`, `ScannerPanel`, `OrderBookPanel`: validated selectors over manager state; no direct sockets.
- `TradingDock`: positions, orders, history, and account views backed only by `tradingStore`.
- `PortalLayer`, `Popover`, `ContextMenu`, `ModalSheet`: collision positioning, focus, dismissal, and viewport containment.
- `WorkspaceRepository`: local draft, Firebase layout CRUD, migration, conflict, and recovery copies.
- `SubscriptionManager`: normalized acquire/release API and channel-specific validators/reducers.

Feature-level error boundaries wrap drawings, indicators, scanner, order book, layout manager, and individual chart tiles. They do not wrap the entire terminal together.

## State Architecture

### Persisted State

`WorkspaceStore` contains only serializable, validated state:

- `schemaVersion`, layout ID/name/revision metadata, chart count, active tile ID, tile order.
- Per-tile symbol, timeframe, chart style, scale options, visible range preference, and indicator instances.
- Symbol/timeframe/crosshair link flags.
- Drawing references and pair-keyed drawing documents.
- Watchlist IDs/order and scanner preferences.
- Sidebar/drawer selection, dock state/active tab, theme-compatible workspace preferences, and autosave setting.

Local keys are namespaced and never overlap existing stores:

- `pro-trading-workspace:v1:{uid-or-anonymous}` — last-valid local draft.
- `pro-trading-layout-index:v1:{uid}` — local layout metadata/recovery index.
- `pro-trading-drawings:v1:{uid-or-anonymous}:{pairKey}` — validated drawings by pair.

Writes are debounced but deadline-bounded: drawings and local draft flush no later than 5 seconds after the first unsaved mutation; Firebase layout autosave flushes no later than 30 seconds while online. `beforeunload` performs a synchronous best-effort local draft write only.

### Ephemeral State

`RuntimeStore` is never serialized:

- chart/series/pane/primitive handles and `ResizeObserver`s;
- candles, ticker/depth buffers, current crosshair, pointer gesture, drag preview, selection box;
- active menu/modal, focus return element, hover, keyboard mode, fullscreen state;
- undo/redo stacks, in-flight requests, abort controllers, subscription leases;
- connection timestamps, retry attempts, stale/disconnected states, and transient errors;
- hidden tile runtime objects after their leases have been released.

The stores communicate through typed commands/selectors, not shared mutable chart objects. Paper data remains exclusively in `tradingStore`.

## Chart Adapter and Interaction Design

Each visible `ChartTile` owns one adapter instance. The adapter API is intentionally narrow:

```text
mount(container, tileConfig)
setHistory(candles)
updateCandle(candle)
setIndicators(instances, computedSeries)
setDrawings(drawings)
setOrderOverlays(paperPositions, paperOrders)
setCrosshairTime(exactTime | null)
setInteractionMode(cursor | pan | draw | measure)
fitContent(); autoScale(); reset(); screenshot(); destroy()
```

`setHistory` is used only on bootstrap/symbol/timeframe reset. Live updates call `series.update`, not `setData` for 5,000 points. `ResizeObserver` batches dimensions in `requestAnimationFrame`; zero-size tiles do not create a chart. Destroy unsubscribes crosshair/click handlers and removes every series/primitive.

The adapter retains discernible candles/wicks, volume histogram, subtle grid, crosshair, last-price line/label, OHLC legend, price/time scales, adaptive `barSpacing`, and original low-opacity watermark. Pointer wheel zoom, pressed drag/pan, price/time-axis drag, pinch, kinetic touch, double-click reset, auto-scale, and fullscreen map directly to supported engine options. Drawing mode temporarily resolves gesture conflicts: one visible mode indicator states `Drawing: Trend Line` (or similar), Escape/cancel returns to cursor mode, and touch page scrolling is disabled only inside an active chart gesture.

Crosshair linking publishes `{sourceTileId,time}` at animation-frame cadence. A target calls its exact time-index lookup; if absent, it clears the linked crosshair rather than interpolating a value. Tile activation is independent of symbol/timeframe changes.

## Drawing Model, History, Persistence, and Limits

A drawing is inert JSON:

```text
{id, type, pairKey, anchors[], text?, style, locked, hidden, createdAt, updatedAt, version}
anchor = {time: epochSeconds, price: finitePositiveNumber}
```

Supported types are trend line, horizontal line, vertical line, ray, rectangle, Fibonacci retracement, and text. A schema defines anchor count, movable/resizable fields, style ranges, and rendering primitive for each type. Text is plain text, normalized for control characters, and limited to 1,000 characters. HTML, URLs-as-actions, scripts, and executable expressions are never interpreted.

Pointer interaction is a state machine: `idle -> placing -> preview -> committed` and `idle -> selected -> moving/resizing -> committed`. Coordinate conversion is done by the adapter; a gesture commits only if all required finite time/price anchors exist. Locked drawings reject geometry/text mutations while allowing unlock, show/hide, and delete. Hidden drawings are omitted by the adapter but retained in `DrawingManager`.

Every committed mutation is a command with `apply` and `inverse` snapshots: add, move, resize, style, text, lock, hide/show, delete. Each pair has a session-only stack capped at 200 commands to bound memory; exceeding the cap drops the oldest command but never a drawing. Undo moves a command to redo; redo reapplies it; any new command after undo clears redo. Destructive clear-all requires confirmation and records one recoverable batch command when size permits.

Drawings are isolated by authenticated user and `pairKey`, locally persisted within 5 seconds, included by reference/version in layouts, and synchronized to UID-owned Firebase documents. A pair is capped at 500 drawings; the 501st add is rejected while editing/deleting existing drawings remains available. Invalid persisted drawings are quarantined individually and the last-valid pair document remains recoverable.

## Multiple Indicator Instances

Indicators are identified by stable instance IDs, never by type alone:

```text
{id, type, parameters, source, style, visible, placement, paneOrder, version}
```

A schema registry exposes only EMA, VWAP, RSI, MACD, Volume, ATR, Bollinger Bands, and Supertrend. Each schema declares defaults, allowed numeric ranges/steps, compatible source (`open/high/low/close/hl2/hlc3/ohlc4/volume` as applicable), overlay/pane support, lookback, and style fields. Inputs are parsed to finite values and validated atomically; a failed field keeps the complete last-valid instance config.

The reducer supports add/update/remove/reorder by ID. It enforces 20 instances per tile and 5 instances per type. Computation is pure and memoized by candle-series revision plus normalized config hash; expensive recalculation is scheduled off the interaction path (worker when profiling justifies it, otherwise chunked/memoized main-thread work). Output before lookback is `null` and renders as `Insufficient history`, never fabricated zeroes. Each pane has a minimum 80px height and collapses to an indicator summary when the tile cannot sustain the pane; placement is restored from layout state.

No generic expression parser, `eval`, dynamic function construction, remote plug-in loader, or arbitrary formula field exists.

## Market Data and Subscription Manager

Consumers acquire normalized requirements and receive a lease:

```text
acquire({channel, symbol, interval?, precision?, depth?}, consumerId) -> {subscribe, release}
key = channel + canonicalSymbol + normalizedParameters
```

The manager keeps one entry per key with ref count, subscribers, last valid payload, last-message/heartbeat time, status, retry state, abort controller, and socket/combined-stream membership. Duplicate acquisitions share processing. Release decrements the count; zero schedules immediate cleanup and guarantees completion within 5 seconds. Reacquisition during the grace window cancels cleanup without opening a duplicate.

Channels:

- `klines:{symbol}:{interval}`: REST bootstrap followed by validated live kline updates.
- `ticker24h`: batched/combined ticker stream for visible watchlist/scanner rows; non-visible rows are not subscribed individually.
- `depth:{symbol}`: active-symbol diff depth plus REST snapshot.
- `exchangeInfo`: cached eligible active spot USDT catalog with recognizable names.

All messages cross a validator for expected event type, canonical symbol, finite range, size, and timestamp before fan-out. A resource expected to be live becomes stale at 10 seconds without message/heartbeat and becomes current only after a new valid update. Reconnect uses bounded exponential backoff with jitter (1s, 2s, 4s, 8s, 16s, cap 30s), one scheduled retry per key, and resets after a stable connection. Offline browser state pauses retries; manual Retry resets the attempt counter. Last-valid data remains visibly labeled stale/disconnected.

Scanner sorting/filtering uses normalized immutable rows and stable secondary sort by symbol. The watchlist is an ordered set capped at 100. Activating a row dispatches `changeActiveTileSymbol`, which applies symbol linking centrally.

### Order-Book Sequencing

1. Open the active symbol's public diff-depth stream and buffer validated events.
2. Fetch a REST depth snapshot; reject it if symbol or numeric level validation fails.
3. Discard buffered events with final update ID `u <= lastUpdateId`.
4. The first applied event must bridge `U <= lastUpdateId + 1 <= u`; subsequent events must not leave a gap (`U <= localLastId + 1 <= u`). If a previous-update ID is supplied, it must equal the local last ID.
5. Apply absolute quantities; quantity zero deletes a level. Reject crossed/invalid books.
6. On malformed, foreign-symbol, or gapped input, mark non-current, stop publishing mutations, and restart from a fresh synchronized snapshot.
7. Aggregate by valid tick precision, sort bids descending and asks ascending, calculate spread, then cap each side to 10/25/50/100.

A symbol change releases the old lease, clears visible mismatched depth immediately, and starts the new synchronization. Clicking a level only prefills an order draft price.

## Explicit Paper-Order Flow

All entry points use one command: `openPaperOrderDraft({tileId, symbol, side?, price?})`. It validates that the tile is active/current, displays a `Paper trading` heading, and passes data to the existing order panel. The user reviews type, quantity, leverage, price, SL/TP, margin, and confirmation. Only the panel's explicit submit invokes `tradingStore.placeOrder`.

Quote buttons, order-book prices, chart context menus, order lines, markers, scanner rows, alerts, and drawings cannot submit. Keyboard shortcuts must open a prefilled draft rather than place an immediate order; this intentionally removes the current direct `Ctrl+B`/`Ctrl+S` execution hazard while preserving an equivalent visible paper-order workflow. No code path imports an authenticated Binance trading client, stores an exchange key, or calls a private/order endpoint.

## Portal Menus, Focus, and Accessibility

All menus, listboxes, context menus, dialogs, and touch sheets use `PortalLayer`. Positioning uses anchor `getBoundingClientRect`, measured surface size, 8px viewport padding, preferred-side flip, and final clamp on both axes. Surfaces use `position: fixed`; `ResizeObserver`, scroll, and viewport resize trigger repositioning. This prevents `overflow:hidden` clipping.

- Symbol search is an ARIA combobox/listbox with styled options, active-descendant management, type-ahead, loading/empty/error states, and no raw native expanded list.
- Menus use roving focus; dialogs trap focus; opening stores the trigger and closing restores focus when it still exists.
- Escape closes only the topmost surface or cancels the active chart mode. Pointer-down outside closes without replaying a click into underlying controls.
- Focus order follows header -> left tools -> active chart -> right tools/panel -> dock -> mobile actions. Active chart has a visible outline and accessible name.
- Live/stale/disconnected/save states use polite live regions and text/icon labels, never color alone.
- Touch targets are at least 44×44px in touch layouts; desktop compact controls may be smaller but expose focus rings and labels/tooltips.
- Shortcuts are registry-driven, documented beside visible controls, disabled in text inputs, and exclude browser/assistive-technology reserved combinations. Delete affects only selected unlocked drawing; undo/redo affect only drawing context.
- Contrast, 200% text zoom, reduced motion, forced-colors behavior, and screen-reader names/states are acceptance gates.

## Responsive, Performance, and Reliability Design

Secondary controls collapse by priority, never by accidental clipping. At 1024, full symbol search, active chart identity, chart, compact paper quote, rail triggers, dock summary, and status remain visible. Tablet uses tool/action drawers and stacked tiles. Mobile shows one active tile while preserving other tile state, a compact market header, position badge, chart, collapsed dock, and fixed bottom actions for Tools, Markets, Paper SELL, and Paper BUY. The document never scrolls horizontally; only approved inner regions scroll.

Performance controls:

- Maximum 5,000 candles per tile, 4 visible tiles, 20 indicators/tile, 500 drawings/pair, 100 watchlist entries.
- Live candle updates are O(1) adapter updates; scanner updates are batched at animation-frame cadence; React selectors are narrow and normalized.
- Geometry and crosshair events are frame-throttled. Drawing previews mutate adapter primitives without writing persistent state until commit.
- Hidden tiles release live leases while retaining serializable session config.
- Initial load prioritizes active chart history/stream; secondary tiles and utility panels initialize after the active chart is usable.
- Performance marks cover message receipt-to-paint, pointer action-to-paint, and terminal mount-to-active-chart-ready. CI reports distributions; acceptance uses the Requirement 9 percentiles.

## Firebase Ownership, Versioning, and Conflict Handling

UID-owned paths are derived only from Firebase Auth:

```text
users/{uid}/proTradingLayouts/{layoutId}
users/{uid}/proTradingDrawings/{pairKeyHash}
users/{uid}/proTradingPreferences/current
users/{uid}/trades/{deterministicProTradeId}   // journal idempotency only
```

Firestore rules must permit a user only when `request.auth.uid == uid`; client-provided `ownerId` is informational and cannot grant access. Emulator tests cover list/get/create/update/delete denial across two users. Public market data never passes through these collections.

Layout envelope:

```text
{schemaVersion: 1, layoutId, name, revision, parentRevision,
 createdAt, updatedAt, deviceId, payload, payloadHash}
```

Names are trimmed plain text, 1–80 characters, and unique per user under a normalized-name index/transaction. Payload validation has total-size and collection limits before any workspace replacement. A load follows parse -> schema validate -> migrate supported version -> domain validate -> stage adapters -> atomic store commit. Failure leaves current memory untouched.

Local state stores `baseRevision`, `localRevision`, dirty time, and last-valid copy. Remote writes use a transaction that succeeds only when remote revision equals `baseRevision`. If local and remote both descend from the base, neither is overwritten: save a recovery copy for both, show names/timestamps/device labels, and require `Keep local`, `Use cloud`, or `Duplicate both`. Resolution creates a new revision. No implicit last-write-wins is used.

Schema migrations are pure, sequential, idempotent functions. Unsupported future versions or corrupt payloads are read-only recovery candidates. Deletion requires confirmation and deletes only the selected layout document; the active in-memory workspace remains. Offline writes retain local dirty state, display `Saved locally · sync pending`, and retry after authentication/connectivity resumes.

## Error Recovery

- **Chart history/stream:** tile-local stale/error overlay with Retry; other tiles and paper state remain usable.
- **Drawings/indicators:** quarantine only invalid instances, preserve last-valid serialized slice, and offer Reset affected feature.
- **Watchlist/scanner/order book:** preserve last-valid values as explicitly stale, expose Retry, and avoid placeholder-as-live values.
- **Persistence:** never report success after write failure; retain memory, last-valid local draft, cloud copy, and actionable retry guidance.
- **Corrupt layout:** do not partially apply; offer last-valid local/cloud recovery or clean advanced-workspace reset.
- **Authentication change:** release old UID subscriptions/persistence handles before loading the new UID namespace; never copy private layout data across users.
- **Feature initialization:** error boundaries disable only the failed feature and expose a retry. Baseline single chart and paper-order flow stay available.
- **Logging:** use error codes and safe context (feature/channel/symbol/revision), redact tokens, payload text, credentials, and private layout bodies.

## Fix Implementation and Migration Rollout

### Stage 0 — Baseline Characterization

Capture current paper-store transitions, persisted keys, chart interactions, Binance lifecycle, and `useTradeBridge` mapping/exactly-once cases before changing composition. Add geometry probes for the observed 1024/1366/1920 defects.

### Stage 1 — Clean Single-Chart Shell (Release Gate)

Create the directly imported scoped stylesheet, deterministic grid, reserved 40/36px rails, two-row desktop header, portal menus, compact quote HUD, spaced dock tabs, and chart safe zones. Move existing chart, overlays, paper panel, sidebar content, and status into boundaries without changing their data sources. This stage must independently ship a clean, usable single-chart terminal and pass all required screenshots before advanced features are enabled.

### Stage 2 — Adapters and State Separation

Introduce `ChartAdapter`, `RuntimeStore`, versioned `WorkspaceStore`, and compatibility selectors from existing chart/settings stores. Keep `pro-trading-store` untouched. Introduce `SubscriptionManager` behind the existing initialization behavior, then remove singleton ownership only after parity tests pass.

### Stage 3 — Drawings and Indicator Instances

Deliver validated drawing schemas/commands/pair persistence and schema-driven indicator instances/panes behind separate feature flags. Baseline volume/current indicators remain available during migration.

### Stage 4 — Multi-Chart and Linking

Enable 2/4 tile configurations, active-tile routing, retained hidden state, exact-time crosshair linking, and lease-based data sharing after one-chart parity and cleanup instrumentation pass.

### Stage 5 — Market Utilities

Enable eligible-USDT catalog, watchlist/scanner, then synchronized order book. Each panel has independent loading/stale/error/retry states and cannot call paper execution directly.

### Stage 6 — Firebase Layouts and Conflict UI

Enable named layout CRUD, autosave, offline sync, migration, conflict resolution, and per-user drawings/preferences. Roll out to a small cohort, monitor recovery/error/performance metrics, then expand. Feature flags permit disabling each advanced slice without reverting the clean shell or paper trading.

Rollback disables advanced flags and loads the last-valid local single-chart workspace. It never rewrites or clears paper/journal state.

## Testing Strategy

### Unit Tests

- Geometry helpers, breakpoint priority/collapse rules, viewport-clamp positioning, and overlap allowlist.
- Workspace reducers: exactly one active tile, 1/2/4 layouts, link propagation, hidden-tile retention.
- Drawing schemas, coordinate validation, command inverse/redo truncation, lock/hide behavior, text/500 limits, and pair isolation.
- Indicator schemas, instance independence, source/range validation, 20/5 limits, lookback null output, and serialization.
- Market validators, key normalization, ref counts, stale timers, bounded backoff, ticker sort/filter, watchlist set/order/100 limit.
- Order-book snapshot bridging, contiguous updates, zero-quantity deletion, aggregation, sorting, depth caps, and gap recovery.
- Layout schema, migrations, normalized names, transactional-load staging, revision conflicts, and corrupt-state recovery.
- Paper-order draft command proving no `placeOrder` call before explicit submit.
- `useTradeBridge` baseline/reset/multi-append behavior and Firestore idempotency by `pro_${closedTrade.id}`.

### Property-Based Tests

Generate:

- viewport widths from 320–2560 and shell states; assert no document overflow, required containment, allowed-only intersections, rail/dock/header caps, and essential-control reachability;
- drawing command sequences; assert Property 3 and persistence round trips;
- indicator collections/config mutations; assert identity, limits, validation, and round trips;
- chart/link/layout transition sequences; assert exactly one active visible tile and correct propagation;
- subscription acquire/release/reconnect sequences; assert unique normalized physical requirements and cleanup deadlines;
- depth snapshots/deltas including malformed IDs, gaps, foreign symbols, and arbitrary valid levels; assert Property 8;
- local/remote revision graphs and schema versions; assert no silent conflict loss;
- malicious/oversized persisted strings and market messages; assert inert rejection/normalization and last-valid preservation.

### Integration Tests

- Active chart REST bootstrap -> WebSocket update -> chart paint -> simulated mark/P&L update.
- 1/2/4 tiles with independent and linked symbol/timeframe/crosshair behavior and lease cleanup.
- Create/edit/lock/hide/undo/redo drawings across two symbols and two timeframes, reload local, then sync/restore Firebase.
- Add duplicate indicator types with distinct settings/panes, save layout, restore, remove one.
- Watchlist/scanner loading/live/stale/failure/retry/unavailable-market behavior.
- Order-book snapshot/diff, precision/depth changes, disconnect/resync, symbol switch, and paper-price prefill only.
- Layout CRUD, offline draft, reconnect, conflict, migration, corrupt load, delete confirmation, and cross-user denial using Firebase emulators.
- Close/partial-close/reverse/SL/TP/liquidation flows and exactly one journal record per closed trade while Dashboard/History observe it.
- Feature-failure injection proving baseline chart and paper order remain available.

### Accessibility Tests

Run automated accessibility checks plus keyboard-only and screen-reader-oriented assertions for focus order, roles/names/states, live regions, validation messages, menu/dialog focus restoration, Escape/outside dismissal, text zoom, contrast, touch targets, and mode cancellation. Test 320px width in addition to the visual profiles.

### Visual and Geometry Regression Tests

Capture reviewable screenshots at:

- 1920×1080 desktop;
- 1366×768 desktop;
- 1024×768 compact desktop;
- 768×1024 tablet portrait (and 1024×768 tablet landscape through the compact-desktop case);
- 390×844 mobile.

For every profile, test default, menu-open-near-each-edge, rails expanded/collapsed, dock expanded/collapsed, paper order open, positions/order lines present, stale/error state, and maximum relevant control labels. Automated assertions accompany screenshots:

```text
document.scrollWidth == document.clientWidth
allRequiredRects within viewport by >= 0px; portal surfaces by >= 8px
no forbidden pair of visibleRects intersects
no text control has unapproved clipping
header <= 88px on desktop
rails <= 44px; dock collapsed <= 40px; expanded <= 240px
dock adjacent tab gap >= 8px
1366 default chart width >= 70vw and height >= 60vh
price scale, time scale, OHLC, last-price label, quote box remain visible
```

Screenshot review verifies discernible bodies/wicks, subtle watermark, original visual identity, non-color status cues, readable paper overlays, and no collisions among symbol options, timeframes, toolbars, rails, tabs, menus, labels, or order overlays.

### Performance and Reliability Tests

Under four charts × 5,000 candles × supported indicator limits, instrument at least 1,000 market updates and representative interactions. Report the percentage within 1s/200ms/3s targets rather than averages. Use fake timers for stale/retry/cleanup deadlines and browser performance marks for real rendering. Leak tests compare active sockets, leases, timers, observers, listeners, and chart instances before/after tile/workspace close.

## Requirements Traceability Matrix

| Requirement | Design coverage | Primary verification |
|---|---|---|
| 1. Preserve baseline | Preserved Existing Contracts; Explicit Paper-Order Flow; Error Recovery; Stage 0–1 | Store parity, chart parity, journal idempotency, adjacent-route regression |
| 2. Drawings | Drawing Model, History, Persistence, and Limits | Unit/PBT command sequences, pair isolation, local/Firebase restore, 500/1000 boundaries |
| 3. Indicators | Multiple Indicator Instances | Schema/limit unit tests, instance PBT, pane/layout restore, no-code security tests |
| 4. Multi-chart | Grid Shell; Component Boundaries; Chart Adapter; State Architecture | 1/2/4 integration, linking PBT, tile isolation, cleanup timing |
| 5. Watchlist/scanner | Market Data and Subscription Manager | Search/sort/filter/favorite PBT, stale/failure/retry integration |
| 6. Order book | Order-Book Sequencing; Explicit Paper-Order Flow | Snapshot/delta PBT, aggregation/depth, disconnect/resync, prefill-only integration |
| 7. Saved layouts | Persisted State; Firebase Ownership, Versioning, and Conflict Handling | CRUD/offline/conflict/migration/corrupt recovery and emulator tests |
| 8. Accessibility/mobile | Grid breakpoints; Portal Menus, Focus, and Accessibility | Keyboard/touch/screen-reader checks, 320px overflow test, tablet/mobile screenshots |
| 9. Performance/reliability | Subscription Manager; Responsive, Performance, and Reliability; Error Recovery | Timing distributions, stale/backoff/cleanup fake timers, leak/isolation tests |
| 10. Security/validation | Preserved Contracts; schema validation; Firebase ownership; Paper-Order Flow | Cross-user emulator, malicious input, redaction, endpoint allowlist, corrupt-state tests |
| 11. Professional terminal | Layout Bug Condition; Grid Shell; Scoped Stylesheet; chart/HUD/dock contracts; Stage 1 | Geometry assertions and screenshots at 1920/1366/1024/tablet/390 |
