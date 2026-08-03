/**
 * Background Service Worker - Chrome Extension
 * Receives trade data from content script and syncs to Firebase Firestore
 * Handles: deduplication, retry, error logging, auto-sync scheduling
 */

const FIREBASE_CONFIG = {
  projectId: "vivek-crypto-trader-b8d19",
};
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;

// State
let syncQueue = [];
let retryQueue = [];
let syncStatus = 'idle'; // idle, syncing, synced, error
let lastSyncTime = null;
let errorLog = [];

// ==================== FIREBASE AUTH ====================

async function getAuthToken() {
  const data = await chrome.storage.local.get(['authToken', 'userId']);
  return data.authToken || null;
}

async function getUserId() {
  const data = await chrome.storage.local.get(['userId']);
  return data.userId || null;
}

// ==================== FIRESTORE OPERATIONS ====================

function decodeTokenPayload(token) {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) throw new Error('missing payload');
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    throw new Error('Invalid Firebase Auth Token. Generate a fresh token in Journal Settings.');
  }
}

async function getValidatedAuthContext() {
  const data = await chrome.storage.local.get(['authToken', 'userId']);
  const token = data.authToken || null;
  const userId = data.userId || null;
  if (!userId) throw new Error('No User ID. Reconnect the extension.');
  if (!token) throw new Error('No Firebase Auth Token. Generate a fresh token in Journal Settings.');

  const payload = decodeTokenPayload(token);
  if (payload.exp && payload.exp * 1000 <= Date.now()) {
    throw new Error('Firebase Auth Token expired. Generate a fresh token and reconnect.');
  }
  const tokenUid = payload.user_id || payload.sub;
  if (tokenUid && tokenUid !== userId) {
    throw new Error('Auth Token belongs to a different User ID. Copy both values from the same logged-in account.');
  }
  return { token, userId };
}

async function saveTradeToFirestore(trade, authContext = null) {
  const { token, userId } = authContext || await getValidatedAuthContext();
  const docId = (trade.tradeId || `tv_${trade.symbol}_${Date.now()}`)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);

  const fields = {};
  for (const [key, value] of Object.entries(trade)) {
    if (value === null || value === undefined) {
      fields[key] = { nullValue: null };
    } else if (typeof value === 'number') {
      fields[key] = { doubleValue: value };
    } else if (typeof value === 'boolean') {
      fields[key] = { booleanValue: value };
    } else {
      fields[key] = { stringValue: String(value) };
    }
  }
  const now = new Date().toISOString();
  fields.source = { stringValue: 'tradingview_extension' };
  fields.syncedAt = { stringValue: now };
  fields.createdAt = { stringValue: trade.entryDate || trade.exitDate || trade.capturedAt || now };

  // PATCH is an upsert in the Firestore REST API, so one request handles create and update.
  const encodedUserId = encodeURIComponent(userId);
  const encodedDocId = encodeURIComponent(docId);
  const url = `${FIRESTORE_BASE}/users/${encodedUserId}/trades/${encodedDocId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    if (response.status === 401) throw new Error('401 - Auth token expired. Generate and paste a fresh token.');
    if (response.status === 403) throw new Error('403 - Firestore denied this UID/token. Reconnect with the same logged-in account.');
    throw new Error(`${response.status} - ${errBody.slice(0, 1000)}`);
  }

  return true;
}

function objectToFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      fields[key] = { nullValue: null };
    } else if (typeof value === 'number') {
      fields[key] = { doubleValue: value };
    } else if (typeof value === 'boolean') {
      fields[key] = { booleanValue: value };
    } else if (typeof value === 'string') {
      fields[key] = { stringValue: value };
    } else {
      fields[key] = { stringValue: String(value) };
    }
  }
  return fields;
}

// ==================== TRADE PROCESSING ====================

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function makeTradeId(record, recordType) {
  const externalId = record.tradeId || record.orderId || record.positionId || record.id;
  if (externalId) return `tv_${String(externalId)}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const identity = [
    recordType,
    record.exchange,
    record.symbol,
    record.side,
    record.entryPrice,
    record.limitPrice,
    record.quantity,
    record.entryTime,
  ].map((value) => value ?? '').join('|');
  return `tv_${stableHash(identity)}`;
}

function toDateOnly(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function processTradeData(rawData) {
  const groups = [
    ['position', rawData.positions || []],
    ['history', rawData.history || []],
  ];
  const trades = new Map();

  groups.forEach(([recordType, records]) => {
    records.forEach((record) => {
      if (!record?.symbol || record.symbol === 'Unknown') return;
      if (record.captureSource !== 'tradingview_chart_overlay') return;

      const tradeId = makeTradeId(record, recordType);
      const side = record.side === 'sell' ? 'sell' : record.side === 'buy' ? 'buy' : null;
      const type = record.type === 'short' || side === 'sell' ? 'short' : record.type === 'long' || side === 'buy' ? 'long' : null;
      if (!side || !type || !tradeId) return;

      const entryPrice = toFiniteNumber(record.entryPrice);
      const exitPrice = toFiniteNumber(record.exitPrice);
      const rawQuantity = toFiniteNumber(record.quantity);
      const quantity = rawQuantity === null ? null : Math.abs(rawQuantity);
      let pnl = toFiniteNumber(record.pnl);
      if (pnl === null && recordType === 'history' && entryPrice !== null && exitPrice !== null && quantity !== null) {
        pnl = Number(((type === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice) * quantity).toFixed(8));
      }

      const entryDate = record.entryDate || record.firstSeenAt || null;
      const exitDate = recordType === 'history' ? (record.exitDate || null) : null;
      const status = recordType === 'history' ? 'closed' : 'open';
      const result = status === 'closed' && pnl !== null ? (pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven') : null;
      const trade = {
        tradeId,
        symbol: record.symbol,
        pair: record.pair || record.symbol,
        exchange: record.exchange || 'TradingView Paper',
        timeframe: record.timeframe || null,
        side,
        type,
        entryPrice,
        exitPrice,
        quantity,
        signedQuantity: toFiniteNumber(record.signedQuantity) ?? (side === 'sell' && quantity !== null ? -quantity : quantity),
        leverage: toFiniteNumber(record.leverage),
        margin: toFiniteNumber(record.margin),
        stopLoss: toFiniteNumber(record.stopLoss),
        takeProfit: toFiniteNumber(record.takeProfit),
        riskRewardRatio: toFiniteNumber(record.riskRewardRatio),
        pnl,
        pnlPercent: toFiniteNumber(record.pnlPercent),
        fees: toFiniteNumber(record.fees),
        entryDate,
        exitDate,
        date: toDateOnly(exitDate || entryDate || record.capturedAt),
        duration: record.duration ?? null,
        durationMs: record.durationMs ?? null,
        status,
        positionStatus: status,
        result,
        recordType,
        closeReason: record.closeReason || null,
        exitPriceSource: record.exitPriceSource || null,
        positionColor: record.positionColor || null,
        entryTimeSource: record.entryTimeSource || null,
        captureSource: 'tradingview_chart_overlay',
        source: 'tradingview_extension',
        capturedAt: record.capturedAt || (rawData.timestamp ? new Date(rawData.timestamp).toISOString() : new Date().toISOString()),
      };
      trades.set(tradeId, trade);
    });
  });

  return Array.from(trades.values());
}

// ==================== SYNC ENGINE ====================

async function syncTrades(rawData) {
  const trades = processTradeData(rawData);
  if (trades.length === 0) {
    const error = 'No complete TradingView chart overlay record was received.';
    logError(error);
    return { synced: 0, failed: 1, error };
  }

  syncStatus = 'syncing';
  updateBadge('syncing');
  chrome.storage.local.set({
    syncStatus: 'syncing',
    syncTotal: trades.length,
    syncProgress: 0,
    failedCount: 0,
  });

  let authContext;
  try {
    authContext = await getValidatedAuthContext();
  } catch (err) {
    const error = err.message || String(err);
    syncStatus = 'error';
    lastSyncTime = new Date().toISOString();
    updateBadge('error');
    logError(error);
    chrome.storage.local.set({ lastSyncTime, syncStatus, syncedCount: 0, failedCount: trades.length });
    return { synced: 0, failed: trades.length, error };
  }

  let synced = 0;
  let failed = 0;
  let firstError = null;
  for (const trade of trades) {
    try {
      await saveTradeToFirestore(trade, authContext);
      synced += 1;
    } catch (err) {
      failed += 1;
      firstError ||= err.message || String(err);
      if (!retryQueue.some((queued) => queued.tradeId === trade.tradeId)) retryQueue.push(trade);
    }
    chrome.storage.local.set({ syncProgress: synced + failed, syncedCount: synced, failedCount: failed });
  }

  if (firstError) logError(`Firestore sync failed: ${firstError}`);
  lastSyncTime = new Date().toISOString();
  syncStatus = failed === 0 ? 'synced' : 'error';
  updateBadge(syncStatus);
  chrome.storage.local.set({ lastSyncTime, syncStatus, syncedCount: synced, failedCount: failed });
  return { synced, failed, error: firstError };
}

// Retry failed syncs
async function retryFailedSyncs() {
  if (retryQueue.length === 0) return;
  const toRetry = [...retryQueue];
  retryQueue = [];

  for (const trade of toRetry) {
    try {
      await saveTradeToFirestore(trade);
    } catch (err) {
      retryQueue.push(trade); // Re-add to retry queue
    }
  }
}

// ==================== BADGE & STATUS ====================

function updateBadge(status) {
  const colors = {
    idle: '#6b7280',
    syncing: '#eab308',
    synced: '#22c55e',
    error: '#ef4444',
  };
  const texts = {
    idle: '',
    syncing: '⟳',
    synced: '✓',
    error: '!',
  };
  chrome.action.setBadgeBackgroundColor({ color: colors[status] || '#6b7280' });
  chrome.action.setBadgeText({ text: texts[status] || '' });
}

function logError(message) {
  errorLog.push({ message, time: new Date().toISOString() });
  if (errorLog.length > 50) errorLog.shift();
  chrome.storage.local.set({ errorLog });
}

// ==================== MESSAGE HANDLING ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TRADE_UPDATE') {
    syncTrades(msg).then(result => {
      sendResponse(result);
    });
    return true; // Keep channel open for async response
  }

  if (msg.type === 'NETWORK_DATA') {
    // Deliberately ignored: chart overlays are the only authoritative capture source.
    sendResponse({ ignored: true });
    return false;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({
      syncStatus,
      lastSyncTime,
      errorLog: errorLog.slice(-10),
      retryCount: retryQueue.length,
    });
    return true;
  }

  if (msg.type === 'RETRY_SYNC') {
    retryFailedSyncs().then(() => sendResponse({ done: true }));
    return true;
  }
});

// ==================== ALARMS (periodic retry) ====================

chrome.alarms.create('retry-sync', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'retry-sync') {
    retryFailedSyncs();
  }
});

// Clear stale diagnostics from earlier extension builds after install/update.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    errorLog: [],
    captureStatus: {},
    syncStatus: 'idle',
    syncedCount: 0,
  });
});

// Initialize
updateBadge('idle');
console.log('[VMT Extension] Background service worker started');
