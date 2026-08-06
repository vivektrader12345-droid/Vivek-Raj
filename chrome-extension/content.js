/**
 * TradingView chart-overlay capture.
 * Active positions remain local; exactly one completed trade is emitted after
 * the chart position/TP/SL overlay disappears on the same visible chart.
 */
(() => {
  'use strict';

  const VERSION = '2.0.0';
  if (window.__VMT_CONTENT_SCRIPT_VERSION__ === VERSION) return;
  window.__VMT_CONTENT_SCRIPT_VERSION__ = VERSION;

  const EVENT_SOURCE = 'vivek-marco-trader-extension';
  const CAPTURE_INTERVAL_MS = 1500;
  const CLOSE_CONFIRMATION_MISSES = 5;
  const CLOSE_CONFIRMATION_DURATION_MS = 7500;
  const CANVAS_HEARTBEAT_MAX_AGE_MS = 4000;
  const ACTIVE_STORAGE_KEY = 'activeChartTrade';
  const DOCUMENT_STARTED_AT = performance.timeOrigin || Date.now();
  const DOCUMENT_GENERATION = String(DOCUMENT_STARTED_AT);

  let isConnected = false;
  let started = false;
  let captureTimer = null;
  let observer = null;
  let observerTimer = null;
  let activeSnapshot = null;
  let missCount = 0;
  let firstMissAt = null;
  let closePending = false;
  let closureInFlight = false;
  let canvasItems = [];
  let canvasHeartbeatAt = 0;
  let lastDataHash = '';
  let pendingDataHash = '';
  let lastOpenStructuralHash = '';
  let lastOpenSyncAt = 0;
  let openSyncInFlight = false;
  let diagnostics = {
    contentReady: true,
    bridgeReady: false,
    chartDetected: false,
    overlayActive: false,
    pairName: null,
    chartSymbol: null,
    timeframe: null,
    side: null,
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    quantity: null,
    pnl: null,
    missingScans: 0,
    lastCaptureAt: null,
    lastCompletedAt: null,
    lastError: null,
  };

  const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  function parseNumber(value) {
    const text = cleanText(value);
    if (!text || /^(?:—|--|-|n\/a|null)$/i.test(text)) return null;
    const negativeByParentheses = /^\(.*\)$/.test(text);
    const match = text.replace(/,/g, '').match(/[+-]?\d*\.?\d+(?:e[+-]?\d+)?/i);
    if (!match) return null;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) return null;
    return negativeByParentheses ? -Math.abs(parsed) : parsed;
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function saveDiagnostics(patch = {}) {
    diagnostics = { ...diagnostics, ...patch };
    chrome.storage.local.set({ captureStatus: diagnostics });
  }

  function visibleRect(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) return null;
    return rect;
  }

  function getChartRect() {
    const canvases = Array.from(document.querySelectorAll('canvas'))
      .map((canvas) => ({ canvas, rect: visibleRect(canvas) }))
      .filter((item) => item.rect && item.rect.width > 100 && item.rect.height > 50);
    if (!canvases.length) return null;

    const main = canvases.sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0].rect;
    const related = canvases.filter(({ rect }) => {
      const overlap = Math.max(0, Math.min(main.bottom, rect.bottom) - Math.max(main.top, rect.top));
      return overlap >= Math.min(main.height, rect.height) * 0.5;
    });
    return related.reduce((union, { rect }) => ({
      left: Math.min(union.left, rect.left),
      top: Math.min(union.top, rect.top),
      right: Math.max(union.right, rect.right),
      bottom: Math.max(union.bottom, rect.bottom),
      width: Math.max(union.right, rect.right) - Math.min(union.left, rect.left),
      height: Math.max(union.bottom, rect.bottom) - Math.min(union.top, rect.top),
    }), { ...main });
  }

  function parseQualifiedSymbol(value) {
    const text = cleanText(value).toUpperCase();
    const qualified = text.match(/(?:^|\s)([A-Z0-9._-]{2,20}):([A-Z0-9._-]{2,30})(?:\s|$)/);
    if (qualified) return { exchange: qualified[1], symbol: qualified[2] };
    const plain = text.match(/^([A-Z][A-Z0-9._-]{1,29})$/);
    return plain ? { exchange: null, symbol: plain[1] } : null;
  }

  function getDomTextCandidates() {
    return Array.from(document.querySelectorAll('div, span, button'))
      .filter((element) => {
        const text = cleanText(element.textContent);
        if (!text || text.length > 180) return false;
        const hasTextChild = Array.from(element.children).some((child) => cleanText(child.textContent));
        return !hasTextChild && Boolean(visibleRect(element));
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const color = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
          ? style.backgroundColor
          : style.color;
        return { text: cleanText(element.textContent), left: rect.left, top: rect.top, width: rect.width, height: rect.height, color, timestamp: Date.now() };
      });
  }

  function currentVisualItems() {
    const now = Date.now();
    const recentCanvas = canvasItems.filter((item) => now - Number(item.timestamp || 0) <= CANVAS_HEARTBEAT_MAX_AGE_MS);
    return [...recentCanvas, ...getDomTextCandidates()];
  }

  function normalizeTimeframe(value) {
    const text = cleanText(value);
    if (/^\d+$/.test(text)) return `${text}m`;
    if (/^\d+(?:s|m|h|d|w|mo)$/i.test(text)) return text;
    return null;
  }

  function detectChartContext(items, chartRect) {
    const queryContext = parseQualifiedSymbol(new URLSearchParams(window.location.search).get('symbol')) || {};
    let pairName = null;
    let timeframe = null;
    let titleExchange = null;

    const pairSelectors = [
      '[data-name="legend-source-title"]',
      '[data-name="legend-series-item"]',
      '[data-name="legend-source-description"]',
    ];
    const texts = [
      ...Array.from(document.querySelectorAll(pairSelectors.join(','))).map((element) => cleanText(element.textContent)),
      ...items.filter((item) => item.top <= (chartRect?.top || 0) + 80).map((item) => item.text),
    ];
    const pairText = texts
      .filter((text) => text.includes('/') && /dollar|usd|usdt|euro|bitcoin|ethereum/i.test(text))
      .sort((a, b) => a.length - b.length)[0];
    if (pairText) {
      const parts = pairText.split('·').map(cleanText).filter(Boolean);
      pairName = parts[0] || pairText;
      timeframe = normalizeTimeframe(parts[1]);
      titleExchange = parts[2] || null;
    }

    const topButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((element) => ({ text: cleanText(element.textContent), rect: visibleRect(element), pressed: element.getAttribute('aria-pressed') }))
      .filter((item) => item.rect && item.rect.top < 110 && normalizeTimeframe(item.text));
    const selectedInterval = topButtons.find((item) => item.pressed === 'true') || topButtons[0];
    timeframe = normalizeTimeframe(selectedInterval?.text) || timeframe;

    if (!pairName && queryContext.symbol) pairName = queryContext.symbol;
    return {
      symbol: queryContext.symbol || null,
      exchange: queryContext.exchange || titleExchange || null,
      pairName,
      timeframe,
    };
  }

  function clusterByY(items, tolerance = 8) {
    const groups = [];
    [...items].sort((a, b) => a.top - b.top || a.left - b.left).forEach((item) => {
      const centerY = item.top + item.height / 2;
      const group = groups.find((candidate) => Math.abs(candidate.centerY - centerY) <= tolerance);
      if (group) {
        group.items.push(item);
        group.centerY = group.items.reduce((sum, current) => sum + current.top + current.height / 2, 0) / group.items.length;
      } else {
        groups.push({ centerY, items: [item] });
      }
    });
    return groups;
  }

  function parseRgb(value) {
    const text = cleanText(value);
    const rgb = text.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    const hex = text.match(/^#([0-9a-f]{6})$/i);
    if (hex) return [0, 2, 4].map((index) => parseInt(hex[1].slice(index, index + 2), 16));
    return null;
  }

  function colorDistance(first, second) {
    const a = parseRgb(first);
    const b = parseRgb(second);
    if (!a || !b) return 300;
    return Math.sqrt(a.reduce((sum, channel, index) => sum + Math.pow(channel - b[index], 2), 0));
  }

  function isPriceText(value) {
    const text = cleanText(value);
    return /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text) || /^\d{4,}(?:\.\d+)?$/.test(text);
  }

  function findPriceAtY(items, chartRect, y, preferredColor) {
    const axisStart = chartRect.right - Math.max(130, chartRect.width * 0.14);
    const candidates = items
      .filter((item) => item.left + item.width / 2 >= axisStart && isPriceText(item.text))
      .map((item) => ({
        item,
        price: parseNumber(item.text),
        score: Math.abs((item.top + item.height / 2) - y) + colorDistance(item.color, preferredColor) * 0.03,
      }))
      .filter((candidate) => candidate.price !== null && candidate.score < 35)
      .sort((a, b) => a.score - b.score);
    return candidates[0]?.price ?? null;
  }

  function findQuantity(middleGroup) {
    const markers = middleGroup.items.filter((item) => /^(?:TP|SL)$/i.test(item.text));
    const markerRight = markers.length ? Math.max(...markers.map((item) => item.left + item.width)) : -Infinity;
    const candidates = middleGroup.items
      .filter((item) => item.left >= markerRight - 2 && /^[+-]?\d+(?:\.\d+)?$/.test(item.text))
      .sort((a, b) => a.left - b.left);
    const item = candidates[0];
    return item ? { value: parseNumber(item.text), text: item.text, color: item.color } : null;
  }

  function findPnl(middleGroup) {
    const item = middleGroup.items.find((candidate) => /USD/i.test(candidate.text) && /[+-]?\d/.test(candidate.text));
    return item ? { value: parseNumber(item.text), color: item.color } : null;
  }

  function detectMarketPrice(items, context) {
    const combinedDom = cleanText(document.title);
    const titleMatch = context.symbol
      ? combinedDom.match(new RegExp(`${context.symbol}\\s+([\\d,.]+)`, 'i'))
      : null;
    if (titleMatch) return parseNumber(titleMatch[1]);

    for (const item of items) {
      const closeMatch = item.text.match(/(?:^|\s)C\s*([\d,.]+)/i);
      if (closeMatch) return parseNumber(closeMatch[1]);
    }
    return null;
  }

  function visiblePriceRange(items, chartRect) {
    const axisStart = chartRect.right - Math.max(130, chartRect.width * 0.14);
    const prices = items
      .filter((item) => item.left + item.width / 2 >= axisStart && isPriceText(item.text))
      .map((item) => parseNumber(item.text))
      .filter((price) => Number.isFinite(price));
    return prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null;
  }

  function detectOverlaySnapshot(items, chartRect, context) {
    const chartItems = items.filter((item) => {
      const centerX = item.left + item.width / 2;
      const centerY = item.top + item.height / 2;
      return centerX >= chartRect.left && centerX <= chartRect.right && centerY >= chartRect.top && centerY <= chartRect.bottom;
    });
    const groups = clusterByY(chartItems);
    const middle = groups.find((group) => {
      const texts = group.items.map((item) => item.text);
      return texts.some((text) => /^TP$/i.test(text)) && texts.some((text) => /^SL$/i.test(text));
    });
    const marketPrice = detectMarketPrice(items, context);
    const priceRange = visiblePriceRange(items, chartRect);
    if (!middle) return { snapshot: null, marketPrice, priceRange };

    const quantity = findQuantity(middle);
    const pnl = findPnl(middle);
    if (!quantity || !Number.isFinite(quantity.value) || quantity.value === 0) {
      return { snapshot: null, marketPrice, priceRange, incomplete: true };
    }

    const positionColor = quantity.color || pnl?.color || '';
    const entryPrice = findPriceAtY(items, chartRect, middle.centerY, positionColor);
    const lineGroups = groups
      .filter((group) => group !== middle && group.items.some((item) => /USD/i.test(item.text)))
      .map((group) => ({
        ...group,
        color: group.items.find((item) => /USD/i.test(item.text))?.color || '',
      }));
    const upper = lineGroups.filter((group) => group.centerY < middle.centerY - 10).sort((a, b) => b.centerY - a.centerY)[0];
    const lower = lineGroups.filter((group) => group.centerY > middle.centerY + 10).sort((a, b) => a.centerY - b.centerY)[0];
    const upperPrice = upper ? findPriceAtY(items, chartRect, upper.centerY, upper.color) : null;
    const lowerPrice = lower ? findPriceAtY(items, chartRect, lower.centerY, lower.color) : null;
    if (![entryPrice, upperPrice, lowerPrice].every(Number.isFinite)) {
      return { snapshot: null, marketPrice, priceRange, incomplete: true };
    }

    const side = quantity.value < 0 ? 'sell' : 'buy';
    const snapshot = {
      pair: context.pairName || context.symbol,
      symbol: context.symbol,
      exchange: context.exchange,
      timeframe: context.timeframe,
      side,
      type: side === 'sell' ? 'short' : 'long',
      signedQuantity: quantity.value,
      quantity: Math.abs(quantity.value),
      entryPrice,
      stopLoss: side === 'sell' ? upperPrice : lowerPrice,
      takeProfit: side === 'sell' ? lowerPrice : upperPrice,
      pnl: Number.isFinite(pnl?.value) ? pnl.value : null,
      currentPrice: marketPrice,
      positionColor,
      captureSource: 'tradingview_chart_overlay',
    };
    return { snapshot, marketPrice, priceRange };
  }

  function isUninterruptedScaleOrEdit(first, second, context, now) {
    if (!window.VMTExtensionCore.sameChartContext(first, context) || first.side !== second.side) return false;
    if (first.documentGeneration !== DOCUMENT_GENERATION) return false;
    const lastSeenAt = Date.parse(first.lastSeenAt || '');
    if (!Number.isFinite(lastSeenAt) || now - lastSeenAt > CAPTURE_INTERVAL_MS * 3) return false;
    const entryTolerance = Math.max(Math.abs(first.entryPrice || 0) * 0.00001, 0.0000001);
    return Math.abs(first.entryPrice - second.entryPrice) <= entryTolerance;
  }

  function makeActiveSnapshot(snapshot) {
    const firstSeenAt = new Date().toISOString();
    const identity = [snapshot.exchange, snapshot.symbol, snapshot.side, snapshot.entryPrice, snapshot.quantity, firstSeenAt].join('|');
    return {
      ...snapshot,
      tradeId: `tv_chart_${stableHash(identity)}`,
      firstSeenAt,
      lastSeenAt: firstSeenAt,
      observations: 1,
      documentGeneration: DOCUMENT_GENERATION,
    };
  }

  function persistActiveSnapshot() {
    try {
      if (activeSnapshot) sessionStorage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify(activeSnapshot));
      else sessionStorage.removeItem(ACTIVE_STORAGE_KEY);
    } catch {
      // In-memory state still works if the page blocks session storage.
    }
  }

  function loadActiveSnapshot() {
    try {
      const stored = sessionStorage.getItem(ACTIVE_STORAGE_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }

  function priceWithinRange(price, range) {
    if (!Number.isFinite(price) || !range) return false;
    const padding = Math.max((range.max - range.min) * 0.02, Math.abs(price) * 0.0001);
    return price >= range.min - padding && price <= range.max + padding;
  }

  function buildCompletedTrade(snapshot) {
    return window.VMTExtensionCore.buildSafeCompletedTrade(snapshot);
  }

  function buildOpenTrade(snapshot) {
    const entryDate = snapshot.firstSeenAt || new Date().toISOString();
    return {
      ...snapshot,
      entryDate,
      entryTimeSource: 'first_observed_on_chart',
      exitDate: null,
      exitPrice: null,
      date: entryDate.slice(0, 10),
      status: 'open',
      positionStatus: 'open',
      recordType: 'position',
      capturedAt: new Date().toISOString(),
    };
  }

  function syncActiveSnapshot(force = false, onComplete = () => {}) {
    if (!activeSnapshot) {
      onComplete({ synced: 0, failed: 1, error: 'No active chart trade detected. Keep Entry, SL and Target lines visible.' });
      return;
    }
    if (closureInFlight || openSyncInFlight) {
      onComplete({ synced: 0, failed: 1, error: 'A trade sync is already in progress.' });
      return;
    }
    const structuralHash = JSON.stringify([
      activeSnapshot.tradeId,
      activeSnapshot.symbol,
      activeSnapshot.side,
      activeSnapshot.entryPrice,
      activeSnapshot.stopLoss,
      activeSnapshot.takeProfit,
      activeSnapshot.quantity,
      activeSnapshot.timeframe,
    ]);
    const now = Date.now();
    const structureChanged = structuralHash !== lastOpenStructuralHash;
    if (!force && !structureChanged && now - lastOpenSyncAt < 5000) {
      onComplete({ synced: 0, failed: 0, skipped: true });
      return;
    }

    openSyncInFlight = true;
    const openTrade = buildOpenTrade(activeSnapshot);
    sendCapturedData({ positions: [openTrade], history: [], capturedAt: now }, true, (result) => {
      openSyncInFlight = false;
      if (Number(result.synced) > 0 && Number(result.failed) === 0) {
        lastOpenStructuralHash = structuralHash;
        lastOpenSyncAt = Date.now();
        activeSnapshot = { ...activeSnapshot, openSyncedAt: new Date(lastOpenSyncAt).toISOString() };
        persistActiveSnapshot();
        saveDiagnostics({ openTradeSynced: true, openTradeSyncedAt: lastOpenSyncAt });
      } else {
        lastOpenStructuralHash = '';
        saveDiagnostics({ openTradeSynced: false });
      }
      onComplete(result);
    });
  }

  function sendCapturedData(data, force = false, onComplete = () => {}) {
    if (!isConnected) return;
    const normalized = {
      positions: data.positions || [],
      orders: [],
      history: data.history || [],
      capturedAt: data.capturedAt || Date.now(),
      captureMethod: data.history?.length ? 'chart_overlay_close' : 'chart_overlay_open',
    };
    const hash = JSON.stringify([...normalized.positions, ...normalized.history]);
    if (hash === pendingDataHash || (!force && hash === lastDataHash)) return;
    pendingDataHash = hash;
    saveDiagnostics({ syncRequestedAt: Date.now(), lastError: null });

    chrome.runtime.sendMessage({
      type: 'TRADE_UPDATE',
      ...normalized,
      timestamp: normalized.capturedAt,
      source: normalized.captureMethod,
    }, (response) => {
      pendingDataHash = '';
      if (chrome.runtime.lastError) {
        const error = `Background sync unavailable: ${chrome.runtime.lastError.message}`;
        saveDiagnostics({ lastError: error });
        onComplete({ synced: 0, failed: 1, error });
        return;
      }
      if (!response) {
        const error = 'Background sync returned no acknowledgement.';
        saveDiagnostics({ lastError: error });
        onComplete({ synced: 0, failed: 1, error });
        return;
      }
      if (Number(response.failed) === 0 && Number(response.synced) > 0) lastDataHash = hash;
      else lastDataHash = '';
      saveDiagnostics({
        lastSyncResult: { synced: Number(response.synced) || 0, failed: Number(response.failed) || 0 },
        lastSyncAcknowledgedAt: Date.now(),
        lastError: response.error || (response.failed ? `${response.failed} Firestore write failed.` : null),
      });
      onComplete(response);
    });
  }

  function finalizeActiveSnapshot() {
    if (!activeSnapshot || closureInFlight) return;
    closureInFlight = true;
    const completed = buildCompletedTrade(activeSnapshot);

    sendCapturedData({ history: [completed], capturedAt: Date.now() }, true, (result) => {
      closureInFlight = false;
      if (Number(result.synced) > 0 && Number(result.failed) === 0) {
        activeSnapshot = null;
        missCount = 0;
        firstMissAt = null;
        closePending = false;
        persistActiveSnapshot();
        saveDiagnostics({
          overlayActive: false,
          closePending: false,
          lastCompletedAt: completed.exitDate,
          lastCompletedTradeId: completed.tradeId,
          missingScans: 0,
        });
      }
    });
  }

  function scanChart() {
    const now = Date.now();
    const chartRect = getChartRect();
    const items = currentVisualItems();
    const context = detectChartContext(items, chartRect);
    const canvasHealthy = now - canvasHeartbeatAt <= CANVAS_HEARTBEAT_MAX_AGE_MS;
    const healthy = document.visibilityState === 'visible' && Boolean(chartRect && context.symbol && (canvasHealthy || items.length));
    const detected = healthy ? detectOverlaySnapshot(items, chartRect, context) : { snapshot: null, marketPrice: null, priceRange: null };
    const snapshot = detected.snapshot;

    if (snapshot) {
      missCount = 0;
      firstMissAt = null;
      closePending = false;
      if (!activeSnapshot) {
        activeSnapshot = makeActiveSnapshot(snapshot);
      } else if (isUninterruptedScaleOrEdit(activeSnapshot, snapshot, context, now)) {
        // Preserve identity only for uninterrupted same-entry observations, edits, or scaling.
        activeSnapshot = {
          ...activeSnapshot,
          ...snapshot,
          firstSeenAt: activeSnapshot.firstSeenAt,
          tradeId: activeSnapshot.tradeId,
          documentGeneration: DOCUMENT_GENERATION,
          observations: Number(activeSnapshot.observations || 0) + 1,
          lastSeenAt: new Date().toISOString(),
        };
      } else {
        // A chart switch, direction change, reload-gap edit, or new entry is not
        // proof that the prior trade closed. Start a distinct local identity.
        if (activeSnapshot.openSyncedAt) {
          saveDiagnostics({ lastError: 'A distinct overlay appeared without an observed close. The prior trade was left open and a new trade identity was started.' });
        }
        activeSnapshot = makeActiveSnapshot(snapshot);
      }
      persistActiveSnapshot();
    } else if (healthy && activeSnapshot && !closureInFlight) {
      const sameContext = window.VMTExtensionCore.sameChartContext(activeSnapshot, context);
      const overlayPricesInView = [activeSnapshot.entryPrice, activeSnapshot.stopLoss, activeSnapshot.takeProfit]
        .every((price) => priceWithinRange(price, detected.priceRange));
      const reliableMissingScan = canvasHealthy && sameContext && overlayPricesInView && !detected.incomplete;

      if (reliableMissingScan) {
        if (firstMissAt === null) firstMissAt = now;
        missCount += 1;
        const closeConfirmed = window.VMTExtensionCore.canConfirmOverlayClose({
          canvasHealthy,
          incomplete: detected.incomplete,
          sameContext,
          observations: activeSnapshot.observations,
          missCount,
          firstMissAt,
          now,
          minimumMisses: CLOSE_CONFIRMATION_MISSES,
          minimumDurationMs: CLOSE_CONFIRMATION_DURATION_MS,
        });
        if (closeConfirmed) {
          if (activeSnapshot.openSyncedAt) {
            closePending = true;
            saveDiagnostics({
              closePending: true,
              closePendingSince: firstMissAt,
              lastError: 'Overlay disappearance detected. Confirm the close from the extension popup; exit price and P&L will remain unknown.',
            });
          } else {
            activeSnapshot = null;
            missCount = 0;
            firstMissAt = null;
            closePending = false;
            persistActiveSnapshot();
          }
        }
      } else {
        missCount = 0;
        firstMissAt = null;
      }
    } else {
      missCount = 0;
      firstMissAt = null;
    }

    const active = activeSnapshot;
    saveDiagnostics({
      contentReady: true,
      bridgeReady: canvasHealthy,
      chartDetected: Boolean(chartRect && context.symbol),
      overlayActive: Boolean(snapshot || active),
      pairName: snapshot?.pair || active?.pair || context.pairName,
      chartSymbol: context.symbol,
      timeframe: snapshot?.timeframe || active?.timeframe || context.timeframe,
      side: snapshot?.side || active?.side || null,
      entryPrice: snapshot?.entryPrice ?? active?.entryPrice ?? null,
      stopLoss: snapshot?.stopLoss ?? active?.stopLoss ?? null,
      takeProfit: snapshot?.takeProfit ?? active?.takeProfit ?? null,
      quantity: snapshot?.quantity ?? active?.quantity ?? null,
      pnl: snapshot?.pnl ?? active?.pnl ?? null,
      missingScans: missCount,
      closePending,
      lastCaptureAt: now,
      lastMethod: 'chart_overlay',
      lastError: detected.incomplete ? 'Position overlay found, but all three line prices are not readable yet.' : diagnostics.lastError,
    });

    window.postMessage({ source: EVENT_SOURCE, type: 'VMT_REQUEST_CANVAS_TEXT' }, window.location.origin);
    return diagnostics;
  }

  function scheduleScan(delay = 100) {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(scanChart, delay);
  }

  function startCapture() {
    if (started) {
      scanChart();
      return;
    }
    started = true;
    scanChart();
    captureTimer = setInterval(scanChart, CAPTURE_INTERVAL_MS);
    observer = new MutationObserver(() => scheduleScan(300));
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function stopCapture() {
    started = false;
    clearInterval(captureTimer);
    clearTimeout(observerTimer);
    observer?.disconnect();
    observer = null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== EVENT_SOURCE) return;
    if (event.data.type === 'VMT_BRIDGE_READY') {
      saveDiagnostics({ bridgeReady: true, lastError: null });
    } else if (event.data.type === 'VMT_CANVAS_TEXT') {
      const renderTimestamp = Number(event.data.timestamp);
      const currentDocumentRender = Number.isFinite(renderTimestamp)
        && renderTimestamp >= DOCUMENT_STARTED_AT
        && renderTimestamp <= Date.now() + 1000;
      canvasItems = currentDocumentRender && Array.isArray(event.data.items) ? event.data.items : [];
      if (currentDocumentRender) canvasHeartbeatAt = renderTimestamp;
      if (isConnected) scheduleScan(50);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'CONNECT') {
      isConnected = true;
      startCapture();
      sendResponse({ ok: true, captureStatus: diagnostics });
    } else if (message.type === 'DISCONNECT') {
      isConnected = false;
      stopCapture();
      sendResponse({ ok: true });
    } else if (message.type === 'SYNC_NOW') {
      isConnected = true;
      scanChart();
      syncActiveSnapshot(true, (result) => {
        sendResponse({
          ok: Number(result.synced) > 0 && Number(result.failed) === 0,
          syncResult: result,
          error: result.error || null,
          captureStatus: diagnostics,
        });
      });
      return true;
    } else if (message.type === 'CONFIRM_CLOSE') {
      if (!closePending || !activeSnapshot?.openSyncedAt) {
        sendResponse({ ok: false, error: 'No pending overlay close is ready for confirmation.' });
      } else {
        finalizeActiveSnapshot();
        sendResponse({ ok: true, pending: true });
      }
    } else if (message.type === 'REQUEST_CAPTURE') {
      isConnected = true;
      const captureStatus = scanChart();
      sendResponse({ ok: true, captureStatus });
    } else if (message.type === 'GET_CAPTURE_STATUS') {
      sendResponse({ ok: true, captureStatus: diagnostics });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.connected) return;
    isConnected = Boolean(changes.connected.newValue);
    if (isConnected) startCapture(); else stopCapture();
  });

  chrome.storage.local.get(['connected'], (data) => {
    isConnected = Boolean(data.connected);
    activeSnapshot = loadActiveSnapshot();
    if (isConnected) startCapture();
  });
})();
