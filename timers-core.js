// Background sync timers: the one shared table (service worker, game-page content script and dashboard).
// Stored setting scmSyncTimers {v:1, timers:{<id>:{enabled, every?, at?}}}. With nothing stored every timer
// runs exactly as before this setting existed. No chrome.* here.
// - interval timers: `every` in the timer's unit, never below `min` (today's default for anything that calls a
//   server: slower and off are allowed, faster is not) and never above `max`.
// - daily timers: `at` is a local clock time 'HH:MM'. at:null (the default) keeps the old fixed-period schedule
//   that is described in `defaultText`.
// accountingWalk is listed here but its setting lives in scmAccountingWalkSchedule (see `source`); the service
// worker reads and writes that key for it.
(function (root) {
  'use strict';
  const UNIT_MS = { sec: 1000, min: 60000, day: 86400000 };
  const TIMERS = [
    { id: 'orderBook', label: 'Game market prices (order books)', group: 'Service worker', kind: 'interval', unit: 'min', default: 1, min: 1, max: 30, hitsServer: true, server: 'game', alarmName: 'scm-order-book-refresh',
      description: 'Reads the game\'s own lowest exchange offers, one product per run in turn. This is the price the Manager shows first and matches the game market page. When off, these game prices stop updating.' },
    { id: 'liveMarket', label: 'SimcoTools backup prices and VWAP', group: 'Service worker', kind: 'interval', unit: 'min', default: 60, min: 60, max: 720, hitsServer: true, server: 'SimcoTools', alarmName: 'scm-live-market-refresh',
      description: 'Reads VWAP and backup prices for both realms from SimcoTools. A backup price is used only when no game order book from the last 6 h exists for a product. When off, VWAP and backup prices go stale.' },
    { id: 'criticalGuard', label: 'Lost data check', group: 'Service worker', kind: 'interval', unit: 'min', default: 10, min: 10, max: 120, hitsServer: true, server: 'game', alarmName: 'scm-critical-data-guard',
      description: 'Checks that saved contracts and VWAP are still there and reads them again from the game only if they went missing. When off, lost contracts or VWAP stay missing until the next Sync.' },
    { id: 'prodEventsWatch', label: 'Production events check', group: 'Service worker', kind: 'interval', unit: 'min', default: 15, min: 15, max: 120, hitsServer: false, server: null, alarmName: 'scm-production-events-watch',
      description: 'Asks open game tabs to read production speed events from the page. No server request. When off, events are only picked up while you have the game page open.' },
    { id: 'prodEventsDaily', label: 'Production events daily scan', group: 'Service worker', kind: 'daily', unit: null, default: null, defaultText: 'every 12 h', min: null, max: null, hitsServer: false, server: null, alarmName: 'scm-production-events-daily',
      description: 'A once-a-day scan of open game tabs for production speed events. No server request. When off, only the 15-minute check and the open game page pick up events.' },
    { id: 'gameConstants', label: 'Game constants refresh', group: 'Service worker', kind: 'interval', unit: 'min', default: 360, min: 360, max: 1440, hitsServer: true, server: 'game', alarmName: 'scm-game-constants',
      description: 'Reads the game\'s building, recipe and resource constants. When off, they only refresh after a Sync, so a game update to recipes or buildings shows up late.' },
    { id: 'resourceImages', label: 'Resource image check', group: 'Service worker', kind: 'interval', unit: 'day', default: 7, min: 7, max: 30, hitsServer: true, server: 'game', alarmName: 'scm-resource-image-validation',
      description: 'Checks the saved product images against the game\'s image files. When off, a product image the game changed keeps its old picture.' },
    { id: 'storagePrune', label: 'Old history clean-up', group: 'Service worker', kind: 'daily', unit: null, default: null, defaultText: 'every 24 h', min: null, max: null, hitsServer: false, server: null, alarmName: 'scm-storage-prune',
      description: 'Removes history older than 90 days from the browser storage. No server request. When off, stored history keeps growing (it is still cleaned when the browser starts).' },
    { id: 'accountingWalk', label: 'Daily Accounting walk', group: 'Service worker', kind: 'daily', unit: null, default: null, defaultText: 'off', min: null, max: null, hitsServer: true, server: 'game', alarmName: 'scm-accounting-walk-daily', source: 'scmAccountingWalkSchedule', defaultEnabled: false,
      description: 'Once a day, after the game finishes the day\'s statements, opens the Accounting pages in the game tab to save the last 7 days. The time must be 5 min to 4 h after the game finishes statements. When off, past days are only saved by Sync.' },
    { id: 'prodEventsCapture', label: 'Production events page read', group: 'Game page', kind: 'interval', unit: 'sec', default: 15, min: 15, max: 120, hitsServer: false, server: null,
      description: 'While the game tab is visible, reads production speed events shown on the page. No server request. When off, events are only read by the background checks.' },
    { id: 'warehouseCostCapture', label: 'Warehouse cost page read', group: 'Game page', kind: 'interval', unit: 'sec', default: 10, min: 10, max: 120, hitsServer: false, server: null,
      description: 'While a warehouse product page is visible, reads its sourcing cost from the page. No server request. When off, the cost is only read when you open or return to the page.' },
    { id: 'overlayRefresh', label: 'Game page card refresh', group: 'Game page', kind: 'interval', unit: 'sec', default: 10, min: 10, max: 120, hitsServer: true, server: 'game',
      description: 'While the game tab is visible, refreshes the Manager card on the game page; this re-reads your warehouse from the game at most every 30 s. When off, the card updates only when you return to the tab or after a game action.' },
    { id: 'listingsRefresh', label: 'My listings and contracts refresh', group: 'Game page', kind: 'interval', unit: 'sec', default: 15, min: 15, max: 300, hitsServer: true, server: 'game',
      description: 'While the game tab is visible and the listings card is open, reads your exchange listings and outgoing contracts from the game. When off, the card updates only when you return to the tab or after a game action.' },
    { id: 'dashLiveMarket', label: 'Dashboard market refresh', group: 'Dashboard', kind: 'interval', unit: 'min', default: 5, min: 5, max: 60, hitsServer: true, server: 'SimcoTools',
      description: 'While the dashboard Market or Warehouse tab is open, refreshes market prices for the realm and the product you are looking at. When off, those prices update only when you press Refresh.' }
  ];
  const byId = Object.create(null);
  for (const t of TIMERS) { Object.freeze(t); byId[t.id] = t; }
  const IDS = TIMERS.map(t => t.id);
  const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function defaultEntry(t) {
    const e = { enabled: t.defaultEnabled !== false };
    if (t.kind === 'interval') e.every = t.default; else e.at = null;
    return e;
  }
  function defaults() { const out = {}; for (const t of TIMERS) out[t.id] = defaultEntry(t); return out; }
  // Interval value in the timer's unit: whole numbers, floor..max. Anything unreadable gives the default.
  function clamp(id, value) {
    const t = byId[id]; if (!t || t.kind !== 'interval') return null;
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return t.default;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return t.default;
    return Math.min(t.max, Math.max(t.min, n));
  }
  // 'HH:MM' (also 'H:MM') → 'HH:MM', or null when not a valid clock time.
  function normalizeAt(v) {
    if (typeof v !== 'string') return null;
    const m = v.trim().match(/^(\d{1,2}):(\d{2})$/); if (!m) return null;
    const s = `${m[1].padStart(2, '0')}:${m[2]}`;
    return HHMM.test(s) ? s : null;
  }
  function normalizeEntry(id, raw) {
    const t = byId[id]; const e = defaultEntry(t);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return e;
    if (typeof raw.enabled === 'boolean') e.enabled = raw.enabled;
    if (t.kind === 'interval') { if ('every' in raw) e.every = clamp(id, raw.every); }
    else if ('at' in raw) e.at = normalizeAt(raw.at);
    return e;
  }
  // Stored value (any shape) → full config with every id. Unknown ids and bad entries are dropped / defaulted.
  function normalize(stored) {
    const src = stored && typeof stored === 'object' && stored.v === 1 && stored.timers && typeof stored.timers === 'object' ? stored.timers : {};
    const out = {};
    for (const id of IDS) out[id] = normalizeEntry(id, Object.prototype.hasOwnProperty.call(src, id) ? src[id] : null);
    return out;
  }
  // Apply a partial patch {<id>:{enabled?, every?, at?}} on a full config; returns a new full config.
  function merge(config, patch) {
    const cur = normalize({ v: 1, timers: config || {} });
    if (!patch || typeof patch !== 'object') return cur;
    for (const id of IDS) {
      const p = patch[id]; if (!p || typeof p !== 'object') continue;
      cur[id] = normalizeEntry(id, { ...cur[id], ...p });
    }
    return cur;
  }
  function toStored(config) { return { v: 1, timers: normalize({ v: 1, timers: config || {} }) }; }
  function isDefault(id, entry) {
    const d = defaultEntry(byId[id]); const e = normalizeEntry(id, entry);
    return e.enabled === d.enabled && e.every === d.every && e.at === d.at;
  }
  // Interval in ms for an interval timer (config entry or default).
  function intervalMs(id, entry) {
    const t = byId[id]; if (!t || t.kind !== 'interval') return null;
    return clamp(id, entry && entry.every) * UNIT_MS[t.unit];
  }
  function intervalMinutes(id, entry) { const ms = intervalMs(id, entry); return ms == null ? null : ms / 60000; }
  // Next local time at 'HH:MM' strictly after `now` (a time already passed today rolls to tomorrow).
  function nextDailyAt(at, now = Date.now()) {
    const s = normalizeAt(at); if (!s) return null;
    const [h, m] = s.split(':').map(Number);
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) { d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0); }
    return d.getTime();
  }
  // Local 'HH:MM' of a timestamp.
  function clockOf(ms) {
    const d = new Date(Number(ms)); if (!Number.isFinite(d.getTime())) return null;
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function timerForAlarm(name) { for (const t of TIMERS) if (t.alarmName && t.alarmName === name) return t.id; return null; }

  root.SCM_TIMERS_CORE = { KEY: 'scmSyncTimers', TIMERS, byId, IDS, UNIT_MS, defaults, normalize, normalizeAt, merge, toStored, isDefault, clamp, intervalMs, intervalMinutes, nextDailyAt, clockOf, timerForAlarm };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SCM_TIMERS_CORE;
})(typeof globalThis !== 'undefined' ? globalThis : self);
