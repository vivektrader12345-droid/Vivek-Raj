# Pro Trading Advanced Charting Workspace — Requirements

## 1. Introduction

Upgrade the existing authenticated React Pro Trading section into a safe, no-code advanced charting workspace for market analysis and paper trading. The upgrade adds drawing tools, configurable built-in indicators, 1/2/4-chart layouts, a Binance USDT watchlist and scanner, Binance market depth, and per-user saved chart layouts while preventing live exchange execution and arbitrary code execution.

### Current baseline

The existing Pro Trading experience includes a Binance WebSocket crypto chart, symbol and timeframe selection, fullscreen mode, simulated order entry, a right sidebar, chart indicators, trade markers, order lines, a risk/reward tool, and a Firestore journal bridge. The upgrade shall extend this baseline without regressing paper trading, journal and Dashboard data, manual trades, authentication, or Settings.

## 2. Glossary

- **Active chart:** The single chart tile that receives chart-specific toolbar, watchlist, scanner, order-book, and paper-order actions.
- **Chart tile:** One independently configurable chart in a multi-chart workspace.
- **Drawing:** A user annotation anchored to chart time and/or price coordinates.
- **Indicator instance:** One independently configured occurrence of a supported built-in indicator.
- **Linked charts:** Chart tiles configured to share symbol, timeframe, and/or crosshair state.
- **USDT market:** An eligible Binance spot trading pair whose quote asset is USDT.
- **Watchlist:** A user-curated, ordered set of USDT markets.
- **Scanner:** A sortable and filterable view of eligible USDT markets and live metrics.
- **Order book:** Aggregated Binance bid and ask price levels and quantities.
- **Saved layout:** A named, versioned snapshot of restorable workspace configuration.
- **Local fallback:** Device-local storage used when per-user Firebase synchronization is unavailable.
- **Stale data:** Live data for which no update or heartbeat has been received for 10 seconds while the workspace is expected to be connected.
- **Paper order:** A simulated order that never submits an order to an exchange.

## 3. Assumptions

1. Binance public spot market-data streams remain the authoritative source for chart, scanner, and order-book data in this scope.
2. Eligible scanner and watchlist instruments are active Binance spot USDT markets; delisted, suspended, or unsupported markets may be removed or marked unavailable.
3. Authentication is required for Firebase synchronization; local fallback remains available when the authenticated user is offline or Firebase is temporarily unavailable.
4. The client environment supports WebSocket connections, persistent local storage, pointer or touch input, and a currently supported browser.
5. Existing paper-trading and journal data models remain compatible unless migrated without data loss.
6. Performance measurements use a documented test device, a stable broadband connection, up to four visible charts, 5,000 candles per chart, and the supported feature limits below.

## 4. User-Story Requirements

### Requirement 1: Preserve the existing product baseline

**User story:** As an existing user, I want advanced charting to preserve my current workflows so that the upgrade does not disrupt paper trading or journaling.

#### Acceptance criteria

1.1 WHEN the advanced workspace opens, THE SYSTEM SHALL retain Binance chart streaming, symbol and timeframe selection, fullscreen, simulated order entry, the right sidebar, trade markers, order lines, the risk/reward tool, and existing indicator behavior.

1.2 WHEN a user creates, modifies, or closes a paper position, THE SYSTEM SHALL preserve the current simulated execution and position-management behavior and SHALL NOT submit an exchange order.

1.3 WHEN a Pro Trading paper position closes, THE SYSTEM SHALL continue to bridge the completed trade to that authenticated user's Firestore journal exactly once.

1.4 WHILE advanced charting features are enabled, THE SYSTEM SHALL preserve journal and Dashboard data, manual trade entry, Trade History, authentication, and Settings behavior.

1.5 IF an advanced feature fails to initialize, THE SYSTEM SHALL keep unaffected baseline features available and identify the unavailable feature with a recoverable error state.

### Requirement 2: Drawing tools

**User story:** As a trader, I want editable and persistent annotations so that I can maintain technical analysis for each market and timeframe.

#### Acceptance criteria

2.1 WHEN the drawing catalog is opened, THE SYSTEM SHALL offer trend line, horizontal line, vertical line, ray, rectangle, Fibonacci retracement, and text tools.

2.2 WHEN a user completes a valid drawing gesture, THE SYSTEM SHALL anchor the drawing to applicable time and price coordinates and display it on the active chart.

2.3 WHEN a drawing is selected, THE SYSTEM SHALL allow applicable move, resize or anchor editing, style editing, lock/unlock, hide/show, and delete actions.

2.4 WHILE a drawing is locked, THE SYSTEM SHALL prevent moving, resizing, and anchor or text editing while retaining unlock, hide/show, and delete controls.

2.5 WHILE a drawing is hidden, THE SYSTEM SHALL omit it from the chart and keep it available in a drawing-management view for show or delete actions.

2.6 WHEN a drawing is created, changed, moved, styled, locked, hidden, shown, or deleted, THE SYSTEM SHALL add that mutation to drawing undo history.

2.7 WHEN undo or redo is requested, THE SYSTEM SHALL reverse or reapply the most recent eligible drawing mutation; IF a new mutation follows an undo, THE SYSTEM SHALL discard unreachable redo history.

2.8 WHEN a user returns to a previously visited symbol-timeframe pair, THE SYSTEM SHALL restore that pair's drawings and SHALL NOT display drawings belonging exclusively to another pair.

2.9 WHEN drawing state changes, THE SYSTEM SHALL persist it per user, symbol, and timeframe locally within 5 seconds and include it in Firebase synchronization when available.

2.10 IF drawing coordinates, style values, or text are invalid, unsupported, or exceed 1,000 text characters, THE SYSTEM SHALL reject or normalize the invalid input, preserve the last valid state, and explain the correction.

2.11 IF a symbol-timeframe pair reaches 500 drawings, THE SYSTEM SHALL preserve existing drawing operations, prevent another drawing from being added, and communicate the limit.

### Requirement 3: Safe no-code custom indicators

**User story:** As a trader, I want to configure multiple built-in indicators without coding so that I can create useful studies safely.

#### Acceptance criteria

3.1 WHEN the indicator catalog opens, THE SYSTEM SHALL offer EMA, VWAP, RSI, MACD, Volume, ATR, Bollinger Bands, and Supertrend.

3.2 WHEN a supported indicator is added, THE SYSTEM SHALL create a new independently configurable instance without replacing another instance of the same or a different type.

3.3 WHEN an indicator instance is configured, THE SYSTEM SHALL provide its applicable parameters, supported price or volume source, visual style, and visibility controls.

3.4 WHEN an indicator supports chart or pane placement, THE SYSTEM SHALL allow its supported overlay or separate-pane placement and restore that placement with the workspace.

3.5 WHEN a user removes an indicator instance, THE SYSTEM SHALL remove only that instance and preserve all other instances.

3.6 WHILE multiple instances of one indicator type exist, THE SYSTEM SHALL retain distinct parameters, sources, styles, visibility, and placement for every instance.

3.7 IF a parameter is missing, non-finite, outside its documented allowed range, or incompatible with the selected source, THE SYSTEM SHALL block the invalid configuration, identify the affected field, and retain the last valid configuration.

3.8 IF adding an instance would exceed 20 indicators on one chart or 5 instances of one indicator type on that chart, THE SYSTEM SHALL reject the addition and explain the applicable limit.

3.9 IF candle history is insufficient for an indicator lookback, THE SYSTEM SHALL show an insufficient-data state for the affected output without fabricating values or failing the chart.

3.10 WHEN indicator configuration changes, THE SYSTEM SHALL persist and restore the instance type, parameters, source, style, visibility, and placement as workspace state.

3.11 WHEN indicator input is accepted, THE SYSTEM SHALL restrict it to validated values exposed by supported no-code controls and SHALL NOT accept or execute Pine Script, JavaScript, executable formulas, plug-ins, or other arbitrary code.

### Requirement 4: One-, two-, and four-chart workspace

**User story:** As a trader, I want multiple configurable charts so that I can compare markets and timeframes in one workspace.

#### Acceptance criteria

4.1 WHEN a chart layout is selected, THE SYSTEM SHALL support exactly 1, 2, or 4 visible chart tiles.

4.2 WHILE the workspace is open, THE SYSTEM SHALL visibly identify exactly one active chart and direct chart-specific actions to it.

4.3 WHEN a chart tile receives pointer, touch, or keyboard focus, THE SYSTEM SHALL make that tile the active chart without changing its market configuration.

4.4 WHILE symbol linking is disabled, THE SYSTEM SHALL retain independent symbols per tile; WHEN symbol linking is enabled and a linked symbol changes, THE SYSTEM SHALL apply it to all symbol-linked tiles.

4.5 WHILE timeframe linking is disabled, THE SYSTEM SHALL retain independent timeframes per tile; WHEN timeframe linking is enabled and a linked timeframe changes, THE SYSTEM SHALL apply it to all timeframe-linked tiles.

4.6 WHILE crosshair linking is enabled, THE SYSTEM SHALL show the corresponding time position on linked charts that contain that time; IF a linked chart lacks that time, THE SYSTEM SHALL omit its linked crosshair rather than infer a value.

4.7 WHILE crosshair linking is disabled, THE SYSTEM SHALL keep each chart's crosshair independent.

4.8 WHEN the user changes between 1-, 2-, and 4-chart layouts, THE SYSTEM SHALL preserve retained tile state and restore temporarily hidden tile state during the workspace session.

4.9 WHILE the viewport is too narrow for a practical multi-column arrangement, THE SYSTEM SHALL reflow or stack chart tiles without hiding essential chart controls or causing horizontal page overflow.

4.10 WHEN a tile's symbol or timeframe changes, a tile is removed or hidden, or the workspace closes, THE SYSTEM SHALL release obsolete WebSocket subscriptions within 5 seconds and SHALL NOT retain duplicate subscriptions for the same active requirement.

4.11 IF one chart cannot load or update, THE SYSTEM SHALL show an error and retry action in that tile without making other tiles unusable.

### Requirement 5: Binance USDT watchlist and scanner

**User story:** As a trader, I want to find and monitor Binance USDT markets so that I can move quickly between opportunities.

#### Acceptance criteria

5.1 WHEN symbol search is used, THE SYSTEM SHALL search eligible Binance USDT markets by symbol and recognizable asset name and present matching results.

5.2 WHEN a user favorites or unfavorites a market, THE SYSTEM SHALL add it to or remove it from the user's watchlist without creating duplicate entries.

5.3 WHEN a user reorders watchlist entries, THE SYSTEM SHALL preserve the new order locally and synchronize it per user when Firebase is available.

5.4 IF a watchlist would exceed 100 entries, THE SYSTEM SHALL reject the additional entry and explain the limit.

5.5 WHILE live data is available, THE SYSTEM SHALL display each visible watchlist or scanner market's latest price, 24-hour percentage change, and 24-hour quote volume.

5.6 WHEN scanner sort or filter criteria change, THE SYSTEM SHALL apply supported symbol, price, percentage-change, and volume criteria and clearly identify the active criteria.

5.7 WHEN a watchlist or scanner row is activated, THE SYSTEM SHALL change only the active chart's symbol unless symbol linking is enabled, in which case THE SYSTEM SHALL apply the configured linking behavior.

5.8 WHILE watchlist or scanner data is loading, THE SYSTEM SHALL show a loading state without presenting placeholder values as live data.

5.9 IF watchlist or scanner retrieval fails, THE SYSTEM SHALL preserve the last valid data when available, identify the error, and provide a retry action.

5.10 IF live watchlist or scanner data becomes stale, THE SYSTEM SHALL visibly mark affected data as stale and SHALL NOT represent it as current until a fresh update arrives.

5.11 IF a saved or favorited market becomes unavailable, THE SYSTEM SHALL mark or remove it without changing the active chart to another market without user action.

### Requirement 6: Binance market depth and order book

**User story:** As a trader, I want current bid and ask depth so that I can inspect liquidity before placing a paper order.

#### Acceptance criteria

6.1 WHEN the order book is available for the active chart's symbol, THE SYSTEM SHALL display ordered bid and ask price levels, quantity at each level, and the current spread.

6.2 WHEN a user changes supported aggregation precision, THE SYSTEM SHALL regroup bid and ask quantities by that valid price increment and visibly identify the selected precision.

6.3 WHEN a user selects a supported depth of 10, 25, 50, or 100 levels per side, THE SYSTEM SHALL display no more than that number of valid bid and ask levels.

6.4 WHEN the active chart symbol changes, THE SYSTEM SHALL stop the obsolete order-book subscription, clear mismatched depth, and load depth for the new active symbol.

6.5 IF the order-book stream disconnects, THE SYSTEM SHALL mark the data disconnected or stale, preserve the last valid snapshot only as non-current context, and attempt reconnection.

6.6 WHEN order-book streaming resumes with a valid synchronized snapshot, THE SYSTEM SHALL replace stale state, resume ordered updates, and mark the data current.

6.7 WHEN a user activates an order-book price, THE SYSTEM SHALL offer to prefill the paper order price for the active chart and SHALL NOT submit, confirm, or auto-execute any order.

6.8 IF an order-book update is malformed, out of sequence, or belongs to another symbol, THE SYSTEM SHALL reject it and recover from a valid synchronized state rather than display a corrupted book.

### Requirement 7: Per-user saved chart layouts

**User story:** As an authenticated user, I want named layouts synchronized across sessions so that I can restore my workspace safely.

#### Acceptance criteria

7.1 WHEN a user creates a named layout, THE SYSTEM SHALL validate a unique name of 1–80 characters and save the current chart count, tile state, active tile, link settings, indicators, drawing references, sidebar state, watchlist preferences, and supported workspace settings.

7.2 WHEN a user lists saved layouts, THE SYSTEM SHALL show only layouts owned by that authenticated user, including each layout's name and last-modified time.

7.3 WHEN a user renames, duplicates, or deletes a layout, THE SYSTEM SHALL perform only the requested operation after validation and SHALL NOT silently overwrite another named layout.

7.4 WHEN a layout is loaded, THE SYSTEM SHALL validate its contents and replace the workspace only after a restorable state is available; IF loading fails, THE SYSTEM SHALL retain the current workspace.

7.5 WHEN autosave is enabled and workspace state changes, THE SYSTEM SHALL save a recoverable local draft within 5 seconds and synchronize the current layout to Firebase within 30 seconds when connectivity is available.

7.6 WHILE Firebase is unavailable, THE SYSTEM SHALL keep the workspace usable through local fallback, identify pending synchronization, and retry without discarding newer local changes.

7.7 WHEN connectivity returns, THE SYSTEM SHALL synchronize pending valid changes under the authenticated user's identity.

7.8 IF local and Firebase copies both changed since their common version, THE SYSTEM SHALL preserve both recoverable versions, identify the conflict and modification times, and require an explicit choice before replacing either version.

7.9 WHEN a saved layout is written, THE SYSTEM SHALL include a schema version; WHEN an older supported version is loaded, THE SYSTEM SHALL migrate it without losing recognized settings and save the migrated result as a newer version.

7.10 IF a layout version is unsupported or its content is corrupt, THE SYSTEM SHALL leave the current workspace intact, explain the issue, and offer the last valid local or synchronized recovery copy when available.

7.11 WHEN a saved layout is deleted, THE SYSTEM SHALL require explicit confirmation and preserve the active in-memory workspace until the user loads or creates another layout.

7.12 IF a save or synchronization operation fails, THE SYSTEM SHALL retain the last valid saved copy and the recoverable local draft and provide retry guidance.

### Requirement 8: Accessibility, keyboard, and mobile use

**User story:** As a user with varied input methods and viewport sizes, I want the workspace to remain operable and understandable.

#### Acceptance criteria

8.1 WHILE using only a keyboard, THE SYSTEM SHALL provide a visible focus order for chart activation, symbol and timeframe controls, drawings, indicators, layouts, watchlist, scanner, order book, and paper-order controls.

8.2 WHEN a supported keyboard shortcut is available, THE SYSTEM SHALL expose its meaning, avoid overriding browser or assistive-technology shortcuts, and provide an equivalent visible control.

8.3 WHEN undo, redo, delete, escape/cancel, or active-chart navigation is invoked by a documented keyboard command, THE SYSTEM SHALL apply it only to the current valid context.

8.4 WHILE a screen reader is used, THE SYSTEM SHALL provide programmatic names, roles, states, validation messages, and status changes for interactive controls and live-data states.

8.5 WHILE content is displayed, THE SYSTEM SHALL meet WCAG 2.1 AA contrast, focus visibility, text scaling, and non-color-only status requirements.

8.6 WHILE using touch input, THE SYSTEM SHALL support chart activation, scrolling, selection, and essential drawing and configuration actions without requiring hover or a precision mouse.

8.7 WHEN the viewport width is 320 CSS pixels or greater, THE SYSTEM SHALL keep essential market selection, active-chart identification, chart viewing, and paper-order access usable without page-level horizontal scrolling.

8.8 IF a gesture conflicts with chart pan, zoom, drawing, or page scroll, THE SYSTEM SHALL visibly indicate the active mode and provide a cancel or mode-exit action.

### Requirement 9: Performance and reliability

**User story:** As a trader, I want a responsive and trustworthy workspace so that live analysis is not disrupted by avoidable lag or stale state.

#### Acceptance criteria

9.1 WHEN a valid market-data message arrives under the baseline test conditions, THE SYSTEM SHALL reflect its applicable price, scanner, or order-book state within 1 second for at least 95% of measured updates.

9.2 WHILE up to four charts each display up to 5,000 candles and supported indicator limits, THE SYSTEM SHALL keep at least 95% of measured non-network user interactions responsive within 200 milliseconds.

9.3 WHEN the workspace first opens under the baseline test conditions, THE SYSTEM SHALL make the active chart usable within 3 seconds for at least 95% of measured loads, excluding declared upstream outages.

9.4 WHILE live streams are healthy, THE SYSTEM SHALL prevent duplicate processing of identical subscriptions and SHALL isolate chart, scanner, and order-book failures so one failure does not disable unrelated features.

9.5 IF a live stream disconnects unexpectedly, THE SYSTEM SHALL expose connection status, attempt reconnection with bounded backoff, and avoid unbounded retry loops or duplicate subscriptions.

9.6 IF data has received no update or heartbeat for 10 seconds while expected to be live, THE SYSTEM SHALL mark it stale; WHEN a valid fresh update is received, THE SYSTEM SHALL clear the stale state.

9.7 WHEN the workspace, a tile, or a live-data panel is closed, THE SYSTEM SHALL release its unused timers, listeners, and live subscriptions within 5 seconds.

9.8 IF local or remote persistence is unavailable, THE SYSTEM SHALL continue unsaved in-memory analysis where safe, identify what is not saved, and avoid reporting a successful save.

### Requirement 10: Security, validation, and error handling

**User story:** As a user, I want my workspace data isolated and invalid input contained so that analysis and account data remain safe.

#### Acceptance criteria

10.1 WHEN layout, drawing, indicator, watchlist, or preference data is stored or retrieved from Firebase, THE SYSTEM SHALL enforce authenticated per-user ownership independently of client-provided identifiers.

10.2 IF a user attempts to read, modify, or delete another user's saved chart data, THE SYSTEM SHALL deny the operation without disclosing that user's content.

10.3 WHEN external market data or persisted workspace data enters the system, THE SYSTEM SHALL validate expected symbol, type, range, sequence, size, and schema before using it.

10.4 IF text, names, styles, parameters, prices, quantities, filters, or persisted fields contain unsupported content, THE SYSTEM SHALL reject or safely normalize them without executing markup, script, URLs, or commands.

10.5 WHEN public Binance market data is requested, THE SYSTEM SHALL use only the access needed for public market data and SHALL NOT request, store, or expose exchange API keys or trading credentials.

10.6 WHEN an error is displayed or recorded, THE SYSTEM SHALL provide actionable context without exposing authentication tokens, credentials, private layout content, or internal stack details to other users.

10.7 IF a destructive user action affects drawings, indicators, watchlists, or layouts, THE SYSTEM SHALL require an explicit action and provide confirmation or an available recovery mechanism appropriate to the impact.

10.8 IF invalid or corrupt advanced workspace state is encountered, THE SYSTEM SHALL isolate the invalid portion, preserve the last valid baseline and paper-trading state, and offer reset or recovery without deleting journal data.

10.9 WHEN any market-data control, order-book price, chart line, or drawing interacts with paper order entry, THE SYSTEM SHALL require the existing explicit paper-order submission flow and SHALL NOT trigger live or automatic execution.

### Requirement 11: Professional single-chart terminal presentation

**User story:** As a trader, I want an original, space-efficient single-chart terminal presentation so that I can analyze markets and manage paper trades without visual obstruction or loss of essential controls.

#### Acceptance criteria

11.1 WHEN the professional single-chart terminal presentation is provided, THE SYSTEM SHALL use an original design inspired by professional terminal usability and SHALL NOT create a pixel-identical reproduction of TradingView or another copyrighted or proprietary terminal.

11.2 WHEN the workspace is rendered at 1024×768, 1366×768, or 1920×1080 CSS pixels, THE SYSTEM SHALL prevent control text, menus, tabs, icons, toolbars, chart labels, and order overlays from overlapping, clipping, rendering outside the viewport, or causing page-level horizontal scrolling.

11.3 WHEN the default single-chart view is rendered at 1366×768 CSS pixels with the bottom dock and sidebars collapsed, THE SYSTEM SHALL allocate at least 70% of the viewport width and 60% of the viewport height to the chart canvas and SHALL keep the price and time scales visible.

11.4 WHILE the compact desktop header is displayed, THE SYSTEM SHALL limit it to no more than 88 CSS pixels in total height across no more than two rows, provide overflow handling for controls that do not fit, and display unsupported controls as visibly disabled without allowing them to crowd supported controls.

11.5 WHILE compact desktop mode is active, THE SYSTEM SHALL provide fixed, independently collapsible left drawing and right action rails, limit each expanded rail to no more than 44 CSS pixels in width, and prevent either rail from obscuring the price scale, time scale, or critical symbol and OHLC labels.

11.6 WHEN the single-chart view is displayed, THE SYSTEM SHALL anchor a SELL/BUY quote box in the chart's upper-left area, show bid, ask, and spread values, clearly identify its actions as paper trading, avoid covering symbol, OHLC, and current-price labels, and open the existing paper-order flow rather than directly sending a live order.

11.7 WHEN candlestick data is available, THE SYSTEM SHALL display discernible candle bodies and wicks, volume, a grid, a crosshair, a last-price line and label, current OHLC values, professional price and time scales, adaptive candle spacing, and a subtle original watermark.

11.8 WHEN the user performs wheel zoom, pointer drag or pan, price-axis drag, time-axis drag, double-click reset, auto-scale, or fullscreen actions, THE SYSTEM SHALL keep each interaction usable and responsive within the performance target defined by Requirement 9.2.

11.9 WHEN the bottom dock is collapsed, THE SYSTEM SHALL limit it to no more than 40 CSS pixels in height; WHEN it is expanded, THE SYSTEM SHALL limit it to no more than 240 CSS pixels in height, display properly spaced tabs with a visible active state, expose positions, orders, history, and account views, and preserve the applicable minimum chart dimensions defined by Requirement 11.3.

11.10 WHEN a popover or context menu opens, THE SYSTEM SHALL keep it within the viewport and present styled application controls rather than a raw unstyled option list; WHEN Escape is pressed or an outside click occurs, THE SYSTEM SHALL close it without activating an unintended action.

11.11 WHILE the viewport narrows, THE SYSTEM SHALL progressively collapse secondary controls into accessible menus while keeping market selection, chart viewing, BUY/SELL paper-order access, and current position status usable.

11.12 WHILE paper positions or paper-order lines are displayed on the chart, THE SYSTEM SHALL make them visually distinguishable from market data and from each other and SHALL prevent them from obscuring interpretation of candle bodies, wicks, price labels, or current OHLC values.

11.13 WHEN visual regression acceptance is performed, THE SYSTEM SHALL produce reviewable screenshots at 1024×768, 1366×768, and 1920×1080 desktop viewports and at a 390×844 mobile viewport and SHALL pass explicit checks for viewport overflow, page-level horizontal scrolling, clipping, and overlap among controls, chart labels, menus, rails, docks, and order overlays.

## 5. Explicitly Out of Scope

- Live exchange order execution, account trading permissions, deposits, withdrawals, or exchange API-key management.
- Pine Script, JavaScript, custom scripting, arbitrary formulas that execute code, plug-ins, or uploaded executables.
- Market-data or trading integration for non-Binance exchanges.
- Chrome extension development or integration.
- Automated strategy execution, bots, signal-triggered orders, copy trading, or unattended paper/live execution.
- Pixel-identical reproduction of TradingView or another proprietary terminal.

## 6. Measurable Success Criteria

1. All acceptance criteria above pass on supported desktop and mobile viewport test profiles, including keyboard-only coverage for essential workflows.
2. Regression tests confirm no loss of current paper trading, journal bridge, Dashboard, manual trade, authentication, Settings, trade markers, order lines, risk/reward, fullscreen, symbol, or timeframe behavior.
3. A user can create, edit, persist, and restore every required drawing type for at least two symbols and two timeframes without cross-pair leakage.
4. A user can configure multiple supported indicator instances, save them in a layout, and restore their parameters, source, style, visibility, and pane placement with no arbitrary-code execution path.
5. One-, two-, and four-chart tests verify independent and linked symbol, timeframe, and crosshair behavior and verify obsolete subscriptions are released within 5 seconds.
6. Watchlist, scanner, and order-book tests verify loading, live, stale, disconnected, retry, and malformed-data states; activating an order-book price never executes an order.
7. Layout CRUD, duplicate, autosave, offline fallback, synchronization, migration, conflict, corrupt-state, and recovery tests preserve at least one last-valid copy and prevent cross-user access.
8. Under the baseline test conditions, at least 95% of live updates render within 1 second, at least 95% of measured local interactions respond within 200 milliseconds, and at least 95% of initial active-chart loads become usable within 3 seconds.
9. Security tests demonstrate that no exchange credentials are requested, no arbitrary code is accepted or run, no live exchange order can be emitted, and one user cannot access another user's saved workspace data.
10. Visual-regression acceptance captures and reviews screenshots at 1024×768, 1366×768, 1920×1080, and 390×844 CSS pixels and verifies no page-level horizontal scrolling, viewport escape, clipping, or overlap involving controls, menus, tabs, icons, toolbars, chart labels, rails, docks, or order overlays.
11. Chart-interaction checks verify wheel zoom, pointer pan, price-axis drag, time-axis drag, double-click reset, auto-scale, fullscreen, crosshair, and BUY/SELL paper-order entry remain usable, visually unobstructed, and responsive within the Requirement 9.2 target.