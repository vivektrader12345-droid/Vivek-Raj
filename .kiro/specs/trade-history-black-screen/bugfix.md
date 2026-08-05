# Bugfix Requirements Document

## Introduction

The authenticated Dashboard at `vijaycontractor.space` renders a seven-row Recent Trades preview, but navigating through `View All →` to `/history` can fail while rendering the complete Firestore-backed trade collection and leave the route black or trapped in the generic error fallback. The failure is caused by Trade History treating heterogeneous persisted trade fields as guaranteed strings even though supported writers and schema-free Firestore rules permit nullable or legacy values. The fix must make `/history` render production-relevant trade shapes safely without changing navigation, valid trade behavior, synchronization, or unrelated error handling.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an authenticated user has at least seven recent renderable trades followed by a trade with a valid `pair` and a missing, null, or unsupported `type`, and clicks `View All →` in Dashboard Recent Trades THEN the system navigates to `/history` and throws a render-time `TypeError` while calling `trade.type.toUpperCase()`, so the Trade History screen is not usable.

1.2 WHEN `/history` receives heterogeneous Firestore trade records whose display or search fields are absent, null, or non-string, or whose numeric/date values are not canonical THEN the system directly applies string, arithmetic, date, and sorting operations without a route-level normalized view model, allowing one record to abort rendering of the complete history collection.

1.3 WHEN the Trade History render exception reaches the existing generic error boundary THEN the system replaces the route content with a generic fallback or appears black, and retrying immediately re-renders the same invalid record and fails again instead of making Trade History available.

### Expected Behavior (Correct)

2.1 WHEN an authenticated user has at least seven recent renderable trades followed by a trade with a valid `pair` and a missing, null, or unsupported `type`, and clicks `View All →` in Dashboard Recent Trades THEN the system SHALL navigate to `/history`, keep the application shell visible, render the complete history safely, and show a stable fallback label for the unsupported direction without throwing.

2.2 WHEN `/history` receives heterogeneous Firestore trade records whose display or search fields are absent, null, or non-string, or whose numeric/date values are not canonical THEN the system SHALL derive a safe route view model for searching, filtering, sorting, totaling, table rendering, detail rendering, and CSV export so that malformed optional fields cannot abort the route and valid records remain usable.

2.3 WHEN a Trade History data-shape issue is encountered THEN the system SHALL handle it within the Trade History data/render path without activating the generic application error boundary; if an unrelated render exception does reach a boundary, the deployed application SHALL show the visible fallback rather than an unlabelled black screen.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN all trade records use the canonical manual-entry shape THEN the system SHALL CONTINUE TO render the same Trade History rows, direction badges, values, totals, details, and actions.

3.2 WHEN users search, filter by type/result/strategy/month/year/week/day/session/date range, or sort valid trades THEN the system SHALL CONTINUE TO return the same records in the same order and compute the same P&L totals.

3.3 WHEN users navigate from Dashboard Recent Trades, the sidebar, Add Trade, Edit Trade, or browser history THEN the system SHALL CONTINUE TO use the existing `/history`, `/add-trade`, and `/edit-trade/:id` routes within the authenticated Layout.

3.4 WHEN Firestore supplies canonical manual, CSV-imported, Pro Trading, or TradingView extension records THEN the system SHALL CONTINUE TO synchronize them through `TradeContext` without mutating persisted documents merely to render Trade History.

3.5 WHEN users import/export CSV, view a trade, edit a trade, delete one trade, or clear all trades with canonical data THEN the system SHALL CONTINUE TO receive the existing results and confirmations.

3.6 WHEN an unrelated descendant render error occurs THEN the system SHALL CONTINUE TO expose a visible error-boundary fallback and log diagnostic information rather than silently removing the application UI.
