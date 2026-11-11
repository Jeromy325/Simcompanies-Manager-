// Background sync timers: the one shared table (service worker, game-page content script and dashboard).
// Stored setting scmSyncTimers {v:1, timers:{<id>:{enabled, every?, at?}}}. With nothing stored every timer
// runs exactly as before this setting existed. No chrome.* here.
// - interval timers: `every` in the timer's unit, never below `min` (today's default for anything that calls a
//   server: slower and off are allowed, faster is not) and never above `max`.
// - daily timers: `at` is a local clock time 'HH:MM'. at:null (the default) keeps the old fixed-period schedule
//   that is described in `defaultText`.
// - toggle timers (kind 'toggle'): on/off only, no interval or time ({enabled}).
// accountingWalk is listed here but its setting lives in scmAccountingWalkSchedule (see `source`); the service
// worker reads and writes that key for it.
(function (root) {
  'use strict';
  const UNIT_MS = { sec: 1000, min: 60000, day: 86400000 };
  const TIMERS = [
    { id: 'orderBook', label: 'Game market prices (order books)', group: 'Service worker', kind: 'interval', unit: 'min', default: 5, min: 5, max: 30, hitsServer: true, server: 'game', alarmName: 'scm-order-book-refresh',
      description: 'Reads one product\'s game order book when the shared game-request slot is free (at most one game request every 5 minutes for all background jobs). This is the price the Manager shows first. When off, these game prices stop updating.' },
    { id: 'liveMarket', label: 'SimcoTools backup prices and VWAP', group: 'Service worker', kind: 'interval', unit: 'min', default: 5, min: 5, max: 720, hitsServer: true, server: 'SimcoTools', alarmName: 'scm-live-market-refresh',
      description: "One SimcoTools request per run (1 per 5 min, shared with the dashboard): VWAP when due, else one product's backup price, oldest first, so each renews about every 5 min x products. Used only when no game order book from the last 6 h exists." },
    { id: 'criticalGuard', label: 'Lost data check', group: 'Service worker', kind: 'interval', unit: 'min', default: 10, min: 10, max: 120, hitsServer: true, server: 'game', alarmName: 'scm-critical-data-guard',
      description: 'Checks that saved contracts and VWAP are still there; a missing one is read again in the shared game-request slot (one background game request every 5 min). When off, lost contracts or VWAP stay missing until the next Sync.' },
    { id: 'prodEventsWatch', label: 'Production events check', group: 'Service worker', kind: 'interval', unit: 'min', default: 15, min: 15, max: 120, hitsServer: false, server: null, alarmName: 'scm-production-events-watch',
      description: 'Asks open game tabs to read production speed events from the page. No server request. When off, events are only picked up while you have the game page open.' },
    { id: 'prodEventsDaily', label: 'Production events daily scan', group: 'Service worker', kind: 'daily', unit: null, default: null, defaultText: 'every 12 h', min: null, max: null, hitsServer: false, server: null, alarmName: 'scm-production-events-daily',
      description: 'A once-a-day scan of open game tabs for production speed events. No server request. When off, only the 15-minute check and the open game page pick up events.' },
    { id: 'gameConstants', label: 'Game constants refresh', group: 'Service worker', kind: 'interval', unit: 'min', default: 360, min: 360, max: 1440, hitsServer: true, server: 'game', alarmName: 'scm-game-constants',
      description: 'Reads the game\'s building, recipe and resource constants, one read per free slot of the shared game-request lane (1 per 5 min). When off, they only refresh after a Sync, so a game update to recipes or buildings shows up late.' },
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
      description: 'While the game tab is visible, refreshes the Manager card on the game page from saved data; your warehouse is re-read from the game about every 15 min in the shared slot (1 game request per 5 min). When off, the card updates only after a game action.' },
    { id: 'listingsRefresh', label: 'My listings and contracts refresh', group: 'Game page', kind: 'interval', unit: 'sec', default: 15, min: 15, max: 300, hitsServer: true, server: 'game',
      description: 'While the game tab is visible and the listings card is open, re-reads your exchange listings and outgoing contracts about every 15 min each in the shared slot (1 game request per 5 min). When off, the card updates only after a game action.' },
    { id: 'dashLiveMarket', label: 'Dashboard market refresh', group: 'Dashboard', kind: 'interval', unit: 'min', default: 5, min: 5, max: 60, hitsServer: true, server: 'SimcoTools',
      description: "While the dashboard Market or Warehouse tab is open, refreshes prices for the realm and the product you look at, within the shared SimcoTools limit (1 request per 5 min). When off, those prices update only when you press Refresh." },
    { id: 'syncMarketCrawl', label: 'Market prices during Sync', group: 'Sync', kind: 'toggle', unit: null, default: null, defaultText: 'on', min: null, max: null, hitsServer: true, server: 'game',
      description: "After each Sync, opens the game market page of each product you stock or produce, so the game loads its order book and the Manager keeps the exact game price. Adds about 1-3 s per product (max 6 s). When off, only pages you open update prices." },
    // 2.5.458 switches (toggle, on for existing installs, off on a fresh install like every hitsServer timer).
    { id: 'accountingOnOpen', label: 'Accounting re-read when the Manager opens', group: 'Dashboard', kind: 'toggle', unit: null, default: null, defaultText: 'on', min: null, max: null, hitsServer: true, server: 'game',
      description: 'When the Manager opens and your statements are over 5 min old, re-reads them from the game one at a time in the shared game-request slot (one request every 5 min). When off, statements update from Sync and the Accounting pages you open.' },
    { id: 'abundanceOnLoad', label: 'Mine abundance read when the game page loads', group: 'Game page', kind: 'toggle', unit: null, default: null, defaultText: 'on', min: null, max: null, hitsServer: true, server: 'game',
      description: 'When the game page loads your buildings, reads the abundance of each mine, oil rig or quarry whose value is over 1 h old, one per shared game-request slot. When off, abundance updates from Sync and the mine pages you open.' },
    { id: 'marketTicker', label: 'Game market ticker (about hourly)', group: 'Service worker', kind: 'toggle', unit: null, default: null, defaultText: 'on', min: null, max: null, hitsServer: true, server: 'game',
      description: "About once an hour reads the game's market ticker (lowest price of each product) in the shared game-request slot, when no game page loaded it in the last hour. When off, the ticker updates only from game pages you open." },
    { id: 'afterSyncExtras', label: 'After Sync: research, government orders, abundance', group: 'Sync', kind: 'toggle', unit: null, default: null, defaultText: 'on', min: null, max: null, hitsServer: true, server: 'game',
      description: 'Right after each Sync, reads research, government orders and your tier, and mine abundance. When off, Sync ends without them; they update from the game pages you open.' }
  ];
  const byId = Object.create(null);
  for (const t of TIMERS) { Object.freeze(t); byId[t.id] = t; }
  const IDS = TIMERS.map(t => t.id);
  const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function defaultEntry(t) {
    const e = { enabled: t.defaultEnabled !== false };
    if (t.kind === 'interval') e.every = t.default; else if (t.kind !== 'toggle') e.at = null;
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
    else if (t.kind !== 'toggle' && 'at' in raw) e.at = normalizeAt(raw.at);
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
  // Fresh install (2.5.458): every timer that contacts a server starts off; the player turns them on one by one.
  // Timers with no server request keep their defaults.
  function freshInstall() { const out = defaults(); for (const t of TIMERS) if (t.hitsServer) out[t.id] = { ...out[t.id], enabled: false }; return out; }
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

  // Shared game-request lane (pure; the service worker keeps the state in chrome.storage.session scmGameLane).
  // The game's API guide: GET only, at most one request every 5 minutes. Every UNATTENDED (timer / alarm / card poll)
  // Manager read of www.simcompanies.com/api/ takes a slot: at most one per GAP_MS across all realms and all jobs.
  // A user-initiated read (Sync, Refresh press, opening a product, the dashboard refresh button) is not in the lane but
  // moves lastAt, so the next unattended read waits 5 min after it.
  // Jobs (key = job or job:realm): prio 1 = your stock (warehouse), 2 = order books, 3 = contracts / own orders /
  // lost-data check, 4 = market ticker (once an hour), 5 = everything else. everyMs = the job's own minimum spacing
  // (per key). wantTtlMs = how long a refused job keeps its place in the queue without asking again (card polls ask
  // every 10-15 s; alarm jobs are run again by the lane alarm). A want older than STARVE_MS goes before the wants
  // that are younger (priority order among the starved), so lower jobs are never starved by an always-due higher one.
  const LANE_MIN = 60000;
  const LANE = Object.freeze({
    KEY: 'scmGameLane', ALARM: 'scm-game-lane', GAP_MS: 5 * LANE_MIN, STARVE_MS: 10 * LANE_MIN, STARVE_LONG_MS: 30 * LANE_MIN,
    JOBS: Object.freeze({
      warehouse: Object.freeze({ prio: 1, everyMs: 15 * LANE_MIN, wantTtlMs: LANE_MIN, label: 'Warehouse (your stock)' }),
      // Only while no auth-data was ever captured for the realm (the warehouse read needs its company id); the game's
      // own pages capture it for free, so this is rare. Same priority as the warehouse, ties go to the older want.
      authData: Object.freeze({ prio: 1, everyMs: 15 * LANE_MIN, wantTtlMs: LANE_MIN, label: 'Company auth-data' }),
      orderBook: Object.freeze({ prio: 2, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Game order book' }),
      contractBook: Object.freeze({ prio: 2, everyMs: 5 * LANE_MIN, wantTtlMs: LANE_MIN, label: 'Order book for an incoming contract' }),
      contracts: Object.freeze({ prio: 3, everyMs: 15 * LANE_MIN, wantTtlMs: LANE_MIN, label: 'Outgoing contracts' }),
      marketOrders: Object.freeze({ prio: 3, everyMs: 15 * LANE_MIN, wantTtlMs: LANE_MIN, label: 'Your exchange listings' }),
      lostData: Object.freeze({ prio: 3, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Lost data check' }),
      ticker: Object.freeze({ prio: 4, everyMs: 60 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Market ticker' }),
      gameConstants: Object.freeze({ prio: 5, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Game constants' }),
      abundance: Object.freeze({ prio: 5, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Abundance' }),
      // Retries of the after-Sync week sales ledger (capped at 3, 5/10/20 min apart; its own alarm asks again).
      // Dashboard-open Accounting re-read (accountingOnOpen): one statement per slot, same priority as the other accounting job.
      accounting: Object.freeze({ prio: 5, everyMs: 5 * LANE_MIN, wantTtlMs: LANE_MIN, label: 'Accounting statement' }),
      accountingWeek: Object.freeze({ prio: 5, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, label: 'Week sales ledger retry' }),
      other: Object.freeze({ prio: 5, everyMs: 5 * LANE_MIN, wantTtlMs: LANE_MIN, label: 'Other' })
    })
  });
  const laneNum = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  function laneBase(key) { return String(key || '').split(':')[0]; }
  function laneSpec(key) { return LANE.JOBS[laneBase(key)] || LANE.JOBS.other; }
  function laneKeyOk(key) { return typeof key === 'string' && /^[A-Za-z]+(?::[01])?$/.test(key); }
  // Stored value (any shape) -> {v:1, lastAt, lastJob, jobs:{key:lastTakenAt}, wants:{key:{since, at}}}. A time in
  // the future (clock moved back) is pulled back to now, so a bad stamp can never close the lane for long.
  function laneState(raw, now = Date.now()) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const cap = v => Math.min(laneNum(v), now);
    const out = { v: 1, lastAt: cap(src.lastAt), lastJob: typeof src.lastJob === 'string' ? src.lastJob.slice(0, 40) : null, jobs: {}, wants: {} };
    for (const [k, v] of Object.entries(src.jobs && typeof src.jobs === 'object' ? src.jobs : {})) { const t = cap(v); if (laneKeyOk(k) && t && now - t < 86400000) out.jobs[k] = t; }
    for (const [k, w] of Object.entries(src.wants && typeof src.wants === 'object' ? src.wants : {})) {
      const at = cap(w && w.at), since = Math.min(cap(w && w.since) || at, at);
      if (laneKeyOk(k) && at && now - at <= laneSpec(k).wantTtlMs) out.wants[k] = { since, at };
    }
    return out;
  }
  function laneNextSlotAt(raw, now = Date.now()) { const st = laneState(raw, now); return st.lastAt ? st.lastAt + LANE.GAP_MS : now; }
  // Who gets the free slot: among the starved wants if there are any, else among all: the lowest prio, then the
  // oldest, then the key. So a job waiting 10 min goes before a higher job that has not waited that long; a want
  // older than STARVE_LONG_MS (30 min) goes first whatever its priority (oldest first), so every job gets a turn.
  function laneWinner(wants, now = Date.now()) {
    const list = Object.entries(wants || {}).map(([k, w]) => ({ k, since: laneNum(w && w.since), prio: laneSpec(k).prio }));
    if (!list.length) return null;
    // A waiting priority-1 job (your warehouse, the company auth-data it needs) always goes first: those have their
    // own 15 min spacing, so they never hold the lane for more than two slots in three.
    const top = list.filter(x => x.prio === 1);
    if (top.length) { top.sort((a, b) => a.since - b.since || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)); return top[0].k; }
    const long = list.filter(x => now - x.since >= LANE.STARVE_LONG_MS);
    if (long.length) { long.sort((a, b) => a.since - b.since || a.prio - b.prio || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)); return long[0].k; }
    const starved = list.filter(x => now - x.since >= LANE.STARVE_MS);
    const pool = starved.length ? starved : list;
    pool.sort((a, b) => a.prio - b.prio || a.since - b.since || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    return pool[0].k;
  }
  // One decision for job `key` at `now`. take:true -> the caller may send ONE request now (state has the slot stamped).
  // take:false -> reason 'job-gap' (this job's own spacing; no want kept), 'gap' (5 min since the last game request
  // not over; want kept), 'yield' (slot free, another job is first; want kept). nextAt = when to ask again.
  // peek:true decides without stamping the slot (a want is still recorded).
  function laneDecide(raw, key, now = Date.now(), { peek = false } = {}) {
    const st = laneState(raw, now);
    if (!laneKeyOk(key)) return { take: false, reason: 'bad-key', nextAt: now + LANE.GAP_MS, state: st };
    const spec = laneSpec(key), own = st.jobs[key] || 0;
    if (own && now - own < spec.everyMs) return { take: false, reason: 'job-gap', nextAt: own + spec.everyMs, state: st };
    const prev = st.wants[key];
    st.wants[key] = { since: prev ? prev.since : now, at: now };
    if (st.lastAt && now - st.lastAt < LANE.GAP_MS) return { take: false, reason: 'gap', nextAt: st.lastAt + LANE.GAP_MS, state: st };
    const winner = laneWinner(st.wants, now);
    if (winner !== key) return { take: false, reason: 'yield', winner, nextAt: now, state: st };
    if (peek) return { take: true, peek: true, nextAt: now, state: st };
    delete st.wants[key];
    st.lastAt = now; st.lastJob = key; st.jobs[key] = now;
    return { take: true, nextAt: now + LANE.GAP_MS, state: st };
  }
  // A user-initiated game request went out: the lane waits GAP_MS after it.
  function laneNote(raw, now = Date.now(), job = 'user') {
    const st = laneState(raw, now);
    if (now >= st.lastAt) { st.lastAt = now; st.lastJob = String(job || 'user').slice(0, 40); }
    return st;
  }

  root.SCM_TIMERS_CORE = { KEY: 'scmSyncTimers', TIMERS, byId, IDS, UNIT_MS, defaults, freshInstall, SWITCHED_OFF_TEXT: 'Not read: switched off (Background timers)', normalize, normalizeAt, merge, toStored, isDefault, clamp, intervalMs, intervalMinutes, nextDailyAt, clockOf, timerForAlarm,
    LANE, laneBase, laneSpec, laneKeyOk, laneState, laneNextSlotAt, laneWinner, laneDecide, laneNote };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SCM_TIMERS_CORE;
})(typeof globalThis !== 'undefined' ? globalThis : self);
