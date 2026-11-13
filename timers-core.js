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
      description: "Every 5 min, one SimcoTools request for the due job: prices every 15 min, government orders hourly, phases, events and company history as a backup to the game pages, building and resource data daily. SimcoTools allows 2 requests per second (burst 25); it never waits for the game. When SimcoTools is down, the Manager retries after 1, 2, 5, 10, then every 15 min." },
    { id: 'criticalGuard', label: 'Lost data check', group: 'Service worker', kind: 'interval', unit: 'min', default: 10, min: 10, max: 120, hitsServer: true, server: 'game', alarmName: 'scm-critical-data-guard',
      description: 'Checks that saved contracts and VWAP are still there; a missing one is read again in the shared game-request slot (one background game request every 5 min). When off, lost contracts or VWAP stay missing until the next Sync.' },
    { id: 'gameConstants', label: 'Game constants refresh', group: 'Service worker', kind: 'interval', unit: 'min', default: 360, min: 360, max: 1440, hitsServer: true, server: 'game', alarmName: 'scm-game-constants',
      description: 'Reads the game\'s building, recipe and resource constants, one read per free slot of the shared game-request lane (1 per 5 min). When off, they only refresh after a Sync, so a game update to recipes or buildings shows up late.' },
    { id: 'resourceImages', label: 'Resource image check', group: 'Service worker', kind: 'interval', unit: 'day', default: 7, min: 7, max: 30, hitsServer: true, server: 'game', alarmName: 'scm-resource-image-validation',
      description: 'Checks the saved product images against the game\'s image files. When off, a product image the game changed keeps its old picture.' },
    { id: 'storagePrune', label: 'Old history clean-up', group: 'Service worker', kind: 'daily', unit: null, default: null, defaultText: 'every 24 h', min: null, max: null, hitsServer: false, server: null, alarmName: 'scm-storage-prune',
      description: 'Removes history older than 90 days from the browser storage. No server request. When off, stored history keeps growing (it is still cleaned when the browser starts).' },
    { id: 'accountingWalk', label: 'Daily Accounting walk', group: 'Service worker', kind: 'daily', unit: null, default: null, defaultText: 'off', min: null, max: null, hitsServer: true, server: 'game', alarmName: 'scm-accounting-walk-daily', source: 'scmAccountingWalkSchedule', defaultEnabled: false,
      description: 'Once a day, after the game finishes the day\'s statements, opens the Accounting pages in the game tab to save the last 7 days. The time must be 5 min to 4 h after the game finishes statements. When off, past days are only saved by Sync.' },
    { id: 'warehouseCostCapture', label: 'Warehouse cost page read', group: 'Game page', kind: 'interval', unit: 'sec', default: 10, min: 10, max: 120, hitsServer: false, server: null,
      description: 'While a warehouse product page is visible, reads its sourcing cost from the page. No server request. When off, the cost is only read when you open or return to the page.' },
    { id: 'overlayRefresh', label: 'Game page card refresh', group: 'Game page', kind: 'interval', unit: 'sec', default: 10, min: 10, max: 120, hitsServer: true, server: 'game',
      description: 'While the game tab is visible, refreshes the Manager card on the game page from saved data; your warehouse is re-read from the game about every 15 min in the shared slot (1 game request per 5 min). When off, the card updates only after a game action.' },
    { id: 'listingsRefresh', label: 'My listings and contracts refresh', group: 'Game page', kind: 'interval', unit: 'sec', default: 15, min: 15, max: 300, hitsServer: true, server: 'game',
      description: 'While the game tab is visible and the listings card is open, re-reads your exchange listings and outgoing contracts about every 15 min each in the shared slot (1 game request per 5 min). When off, the card updates only after a game action.' },
    { id: 'dashLiveMarket', label: 'Dashboard market refresh', group: 'Dashboard', kind: 'interval', unit: 'min', default: 5, min: 5, max: 60, hitsServer: true, server: 'SimcoTools',
      description: "While the dashboard Market or Warehouse tab is open, refreshes prices for the realm and the product you look at, through SimcoTools (2 requests per second, burst 25; when it is down, retried after 1, 2, 5, 10, then every 15 min). When off, they update only when you press Refresh." },
    { id: 'syncMarketCrawl', label: 'Market prices during Sync', group: 'Sync', kind: 'toggle', unit: null, default: null, defaultText: 'on', min: null, max: null, hitsServer: true, server: 'game',
      description: "After each Sync, opens the game market page of each product you stock or produce, so the game loads its order book and the Manager keeps the exact game price. Adds about 1-3 s per product (max 6 s). When off, only pages you open update prices." },
    // 2.5.458 switches (toggle, on for existing installs, off on a fresh install like every hitsServer timer).
    { id: 'accountingOnOpen', label: 'Accounting re-read when the Manager opens', group: 'Dashboard', kind: 'toggle', unit: null, default: null, defaultText: 'on', min: null, max: null, hitsServer: true, server: 'game',
      description: 'When the Manager opens and your statements are over 5 min old, re-reads them from the game one at a time in the shared game-request slot (one request every 5 min). When off, statements update from Sync and the Accounting pages you open.' },
    { id: 'abundanceOnLoad', label: 'Mine abundance read when the game page loads', group: 'Game page', kind: 'toggle', unit: null, default: null, defaultText: 'on', min: null, max: null, hitsServer: true, server: 'game',
      description: 'When the game page loads your buildings, reads the abundance of each mine, oil rig or quarry whose value is over 1 h old, one per shared game-request slot. When off, abundance updates from Sync and the mine pages you open.' },
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
  // Jobs (key = job or job:realm): prio 1 = warehouse after Collect (always first), 2 = exchange listings,
  // 3 = contracts, 4 = warehouse / auth-data, 5 = accounting, 6 = everything else. everyMs = the job's own minimum spacing
  // (per key). wantTtlMs = how long a refused job keeps its place in the queue without asking again (card polls ask
  // every 10-15 s; alarm jobs are run again by the lane alarm). A want older than STARVE_MS goes before the wants
  // that are younger (priority order among the starved), so lower jobs are never starved by an always-due higher one.
  const LANE_MIN = 60000;
  const LANE = Object.freeze({
    KEY: 'scmGameLane', ALARM: 'scm-game-lane', GAP_MS: 5 * LANE_MIN, STARVE_MS: 10 * LANE_MIN, STARVE_LONG_MS: 30 * LANE_MIN,
    JOBS: Object.freeze({
      // Priority 1 = the warehouse read right after a Collect (always first, no spacing of its own).
      collectWarehouse: Object.freeze({ prio: 1, everyMs: 0, wantTtlMs: 15 * LANE_MIN, label: 'Warehouse after Collect' }),
      marketOrders: Object.freeze({ prio: 2, everyMs: 15 * LANE_MIN, wantTtlMs: 20 * LANE_MIN, label: 'Your exchange listings' }),
      // A listings read held back after a game action: its retry asks the lane (key listings:<realm>) and the lane alarm runs it.
      listings: Object.freeze({ prio: 2, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Your exchange listings (after a game action)' }),
      contracts: Object.freeze({ prio: 3, everyMs: 15 * LANE_MIN, wantTtlMs: 20 * LANE_MIN, label: 'Outgoing contracts' }),
      warehouse: Object.freeze({ prio: 4, everyMs: 15 * LANE_MIN, wantTtlMs: 20 * LANE_MIN, label: 'Warehouse (your stock)' }),
      // Only while no auth-data was ever captured for the realm (the warehouse read needs its company id).
      authData: Object.freeze({ prio: 4, everyMs: 15 * LANE_MIN, wantTtlMs: 20 * LANE_MIN, label: 'Company auth-data' }),
      // Dashboard-open Accounting re-read: one statement per slot; week sales ledger retries (capped at 3).
      accounting: Object.freeze({ prio: 5, everyMs: 5 * LANE_MIN, wantTtlMs: 20 * LANE_MIN, label: 'Accounting statement' }),
      accountingWeek: Object.freeze({ prio: 5, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, label: 'Week sales ledger retry' }),
      orderBook: Object.freeze({ prio: 6, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Game order book' }),
      contractBook: Object.freeze({ prio: 6, everyMs: 5 * LANE_MIN, wantTtlMs: LANE_MIN, label: 'Order book for an incoming contract' }),
      lostData: Object.freeze({ prio: 6, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Lost data check' }),
      // No job enqueues ticker since 2.5.466 (the active read is gone); kept so a want an older version stored still has its label until start-up drops it.
      ticker: Object.freeze({ prio: 6, everyMs: 60 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Market ticker' }),
      gameConstants: Object.freeze({ prio: 6, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Game constants' }),
      abundance: Object.freeze({ prio: 6, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, runner: true, label: 'Abundance' }),
      // key executive:<realm>:<id> (one executive record per key).
      executive: Object.freeze({ prio: 6, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, label: 'Executive record' }),
      syncMissing: Object.freeze({ prio: 6, everyMs: 5 * LANE_MIN, wantTtlMs: 11 * LANE_MIN, label: 'Data a Sync page did not load' }),
      other: Object.freeze({ prio: 6, everyMs: 5 * LANE_MIN, wantTtlMs: LANE_MIN, label: 'Other' })
    })
  });
  const laneNum = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  function laneBase(key) { return String(key || '').split(':')[0]; }
  function laneSpec(key) { return LANE.JOBS[laneBase(key)] || LANE.JOBS.other; }
  function laneKeyOk(key) { return typeof key === 'string' && key.length <= 60 && /^[A-Za-z]+(?::[01])?(?::\d{1,12})?$/.test(key); }
  // Failure backoff per key: 1st failure 5 min, 2nd 10 min, 3rd and later 15 min.
  const LANE_BACKOFF_MS = Object.freeze([5 * LANE_MIN, 10 * LANE_MIN, 15 * LANE_MIN]);
  function laneBackoffUntil(st, key) { const f = st && st.fails && st.fails[key]; return f ? f.at + LANE_BACKOFF_MS[Math.min(f.n - 1, 2)] : 0; }
  // Stored value (any shape) -> {v:1, lastAt, lastJob, lastSince, lastResult, jobs:{key:lastTakenAt}, wants:{key:{since, at}},
  // fails:{key:{n, at}}}. A time in the future (clock moved back) is pulled back to now, so a bad stamp can never close the lane for long.
  function laneState(raw, now = Date.now()) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const cap = v => Math.min(laneNum(v), now);
    const out = { v: 1, lastAt: cap(src.lastAt), lastJob: typeof src.lastJob === 'string' ? src.lastJob.slice(0, 40) : null, lastSince: cap(src.lastSince), lastResult: null, jobs: {}, wants: {}, fails: {} };
    const lr = src.lastResult;
    if (lr && typeof lr === 'object' && laneKeyOk(lr.key) && cap(lr.at)) out.lastResult = { key: lr.key, ok: !!lr.ok, status: Math.max(0, Math.round(Number(lr.status)) || 0), at: cap(lr.at) };
    for (const [k, v] of Object.entries(src.jobs && typeof src.jobs === 'object' ? src.jobs : {})) { const t = cap(v); if (laneKeyOk(k) && t && now - t < 86400000) out.jobs[k] = t; }
    for (const [k, f] of Object.entries(src.fails && typeof src.fails === 'object' ? src.fails : {})) {
      const at = cap(f && f.at), n = Math.min(99, Math.round(Number(f && f.n)) || 0);
      if (laneKeyOk(k) && at && n >= 1 && now - at < 86400000) out.fails[k] = { n, at };
    }
    // a key that failed keeps its queued retry through its backoff
    for (const [k, w] of Object.entries(src.wants && typeof src.wants === 'object' ? src.wants : {})) {
      const at = cap(w && w.at), since = Math.min(cap(w && w.since) || at, at);
      if (laneKeyOk(k) && at && now - at <= (out.fails[k] ? Math.max(laneSpec(k).wantTtlMs, LANE_BACKOFF_MS[2]) : laneSpec(k).wantTtlMs)) out.wants[k] = { since, at };
    }
    return out;
  }
  function laneNextSlotAt(raw, now = Date.now()) { const st = laneState(raw, now); return st.lastAt ? st.lastAt + LANE.GAP_MS : now; }
  // Who gets the free slot: among the starved wants if there are any, else among all: the lowest prio, then the
  // oldest, then the key. So a job waiting 10 min goes before a higher job that has not waited that long; a want
  // older than STARVE_LONG_MS (30 min) goes first whatever its priority (oldest first), so every job gets a turn.
  // lastAt (when the last slot went out): after your stock (prio 1, at most one slot in three), a want that already
  // lost a slot goes first (oldest first), then the wants made while this slot was busy (oldest first); so no job waits more than one slot after the slot frees (2.5.464: the held
  // listings read lost every slot to the order-book alarm and the contracts poll for 7+ min).
  function laneWinner(wants, now = Date.now(), lastAt = 0) {
    const list = Object.entries(wants || {}).map(([k, w]) => ({ k, since: laneNum(w && w.since), prio: laneSpec(k).prio }));
    if (!list.length) return null;
    const last = laneNum(lastAt);
    const byAge = (a, b) => a.since - b.since || a.prio - b.prio || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
    // A waiting priority-1 job (the warehouse read after a Collect) always goes first.
    const top = list.filter(x => x.prio === 1);
    if (top.length) { top.sort((a, b) => a.since - b.since || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)); return top[0].k; }
    // 2. a want that already lost a slot (made before the last slot went out): next, oldest first.
    const lost = last ? list.filter(x => x.since < last) : [];
    if (lost.length) { lost.sort(byAge); return lost[0].k; }
    // 3. a want made while this slot was still busy (it waited for it): oldest first, before one asking only now.
    const waited = last ? list.filter(x => x.since < last + LANE.GAP_MS) : [];
    if (waited.length) { waited.sort(byAge); return waited[0].k; }
    const long = list.filter(x => now - x.since >= LANE.STARVE_LONG_MS);
    if (long.length) { long.sort((a, b) => a.since - b.since || a.prio - b.prio || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)); return long[0].k; }
    const starved = list.filter(x => now - x.since >= LANE.STARVE_MS);
    const pool = starved.length ? starved : list;
    pool.sort((a, b) => a.prio - b.prio || a.since - b.since || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    return pool[0].k;
  }
  // One decision for job `key` at `now`. take:true -> the caller may send ONE request now (state has the slot stamped).
  // take:false -> reason 'job-gap' (this job's own spacing; no want kept), 'fail-backoff' (this key failed lately; want
  // kept, nextAt = end of its 5/10/15 min backoff; other keys are not affected), 'gap' (5 min since the last game request
  // not over; want kept), 'yield' (slot free, another job is first; want kept). nextAt = when to ask again.
  // peek:true decides without stamping the slot (a want is still recorded).
  function laneDecide(raw, key, now = Date.now(), { peek = false } = {}) {
    const st = laneState(raw, now);
    if (!laneKeyOk(key)) return { take: false, reason: 'bad-key', nextAt: now + LANE.GAP_MS, state: st };
    const spec = laneSpec(key), own = st.jobs[key] || 0;
    if (own && now - own < spec.everyMs) return { take: false, reason: 'job-gap', nextAt: own + spec.everyMs, state: st };
    const prev = st.wants[key];
    st.wants[key] = { since: prev ? prev.since : now, at: now };
    const until = laneBackoffUntil(st, key);
    if (until > now) return { take: false, reason: 'fail-backoff', nextAt: until, state: st };
    if (st.lastAt && now - st.lastAt < LANE.GAP_MS) return { take: false, reason: 'gap', nextAt: st.lastAt + LANE.GAP_MS, state: st };
    const eligible = {};
    for (const [k, w] of Object.entries(st.wants)) if (laneBackoffUntil(st, k) <= now) eligible[k] = w;
    const winner = laneWinner(eligible, now, st.lastAt);
    if (winner !== key) return { take: false, reason: 'yield', winner, nextAt: now, state: st };
    if (peek) return { take: true, peek: true, nextAt: now, state: st };
    st.lastSince = st.wants[key].since;
    delete st.wants[key];
    st.lastAt = now; st.lastJob = key; st.jobs[key] = now;
    return { take: true, nextAt: now + LANE.GAP_MS, state: st };
  }
  // The outcome of a lane request: {ok, status}. Failure (403 / 503 / 429 / network): the key backs off (see
  // laneBackoffUntil) and its want is queued again with its original since; success clears the key's failures.
  function laneResult(raw, key, res, now = Date.now()) {
    const st = laneState(raw, now);
    if (!laneKeyOk(key)) return st;
    const ok = !!(res && res.ok), status = Math.max(0, Math.round(Number(res && res.status)) || 0);
    st.lastResult = { key, ok, status, at: now };
    if (ok) { delete st.fails[key]; return st; }
    const prev = st.fails[key];
    st.fails[key] = { n: Math.min(99, (prev ? prev.n : 0) + 1), at: now };
    const was = st.wants[key] ? st.wants[key].since : 0, taken = st.lastJob === key ? st.lastSince : 0;
    const since = Math.min(...[was, taken].filter(Boolean), now);
    delete st.jobs[key];
    st.wants[key] = { since, at: now };
    return st;
  }
  // A user-initiated game request went out: the lane waits GAP_MS after it.
  function laneNote(raw, now = Date.now(), job = 'user') {
    const st = laneState(raw, now);
    if (now >= st.lastAt) { st.lastAt = now; st.lastJob = String(job || 'user').slice(0, 40); }
    return st;
  }

  // SimcoTools channel (pure; state in chrome.storage.session scmSimcoChannel). Independent of the game lane: no 5 min
  // rule. Token bucket 2 per second, burst 25; a network failure marks it unreachable (one probe at 1, 2, 5, 10, 15,
  // 15 ... min, one log line per outage); a 429 opens a cooldown (Retry-After, else 60 s). Wants: lowest prio, then oldest.
  const SIMCO = Object.freeze({
    KEY: 'scmSimcoChannel', RATE_PER_S: 2, BURST: 25, PROBE_MS: Object.freeze([60e3, 120e3, 300e3, 600e3, 900e3]), COOLDOWN_DEFAULT_MS: 60e3, COOLDOWN_MAX_MS: 3600e3, PROBE_GRACE_MS: 60e3, WANT_TTL_MS: 30 * LANE_MIN,
    JOBS: Object.freeze({
      refresh: Object.freeze({ prio: 1, label: 'Market Refresh' }),
      prices: Object.freeze({ prio: 2, label: 'All current prices' }),
      vwap: Object.freeze({ prio: 3, label: 'Prices for products you hold' }),
      snapshot: Object.freeze({ prio: 4, label: 'Product snapshot' }),
      candles: Object.freeze({ prio: 4, label: 'Price history' }),
      followed: Object.freeze({ prio: 4, label: 'Followed products' }),
      public: Object.freeze({ prio: 5, label: 'Public data' }),
      other: Object.freeze({ prio: 5, label: 'Other' })
    })
  });
  function simcoSpec(key) { return SIMCO.JOBS[laneBase(key)] || SIMCO.JOBS.other; }
  function simcoRefill(st, now) {
    const el = Math.max(0, now - st.tokensAt);
    st.tokens = Math.min(SIMCO.BURST, st.tokens + el * SIMCO.RATE_PER_S / 1000); st.tokensAt = now;
  }
  function simcoState(raw, now = Date.now()) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const cap = v => Math.min(laneNum(v), now), last = SIMCO.PROBE_MS.length - 1;
    const tk = Number(src.tokens);
    const out = { v: 1, tokens: Number.isFinite(tk) && tk >= 0 ? Math.min(SIMCO.BURST, tk) : SIMCO.BURST, tokensAt: cap(src.tokensAt) || now,
      lastAt: cap(src.lastAt), lastJob: typeof src.lastJob === 'string' ? src.lastJob.slice(0, 40) : null, lastResult: null,
      unreachableSince: cap(src.unreachableSince), probeStep: Math.min(last, Math.max(0, Math.round(Number(src.probeStep)) || 0)), nextProbeAt: 0,
      cooldownUntil: 0, loggedOutage: false, wants: {} };
    const lr = src.lastResult;
    if (lr && typeof lr === 'object' && cap(lr.at)) out.lastResult = { key: typeof lr.key === 'string' ? lr.key.slice(0, 60) : '', ok: !!lr.ok, status: Math.max(0, Math.round(Number(lr.status)) || 0), at: cap(lr.at) };
    if (out.unreachableSince) {
      out.loggedOutage = !!src.loggedOutage;
      out.nextProbeAt = Math.min(laneNum(src.nextProbeAt) || out.unreachableSince + SIMCO.PROBE_MS[out.probeStep], now + SIMCO.PROBE_MS[last]);
    } else out.probeStep = 0;
    const cu = laneNum(src.cooldownUntil); out.cooldownUntil = cu > now ? Math.min(cu, now + SIMCO.COOLDOWN_MAX_MS) : 0;
    for (const [k, w] of Object.entries(src.wants && typeof src.wants === 'object' ? src.wants : {})) {
      const at = cap(w && w.at), since = Math.min(cap(w && w.since) || at, at);
      if (laneKeyOk(k) && at && now - at <= SIMCO.WANT_TTL_MS) out.wants[k] = { since, at, reason: typeof (w && w.reason) === 'string' ? w.reason.slice(0, 40) : 'waiting' };
    }
    simcoRefill(out, now);
    return out;
  }
  function simcoOrder(wants) {
    return Object.entries(wants || {}).map(([k, w]) => ({ k, since: laneNum(w && w.since), prio: simcoSpec(k).prio, flying: !!w && w.reason === 'in flight' }))
      .sort((a, b) => a.prio - b.prio || a.since - b.since || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  }
  // take:true -> send ONE request now (a token is spent; the want stays queued, marked 'in flight', until simcoResult).
  // take:false -> reason 'bad-key' | 'cooldown' | 'unreachable' | 'rate' (no token) | 'yield' (the tokens left are
  // needed by higher wants). nextAt = when to ask again. peek:true decides without spending anything.
  // canRun(key): the want has a queue runner (worker side); during an outage a want nobody serves cannot hold the probe.
  function simcoTake(raw, key, now = Date.now(), { peek = false, canRun = null } = {}) {
    const st = simcoState(raw, now);
    if (!laneKeyOk(key)) return { take: false, reason: 'bad-key', nextAt: now + 60e3, state: st };
    const prev = st.wants[key];
    if (prev && prev.reason === 'in flight') prev.at = now;
    else st.wants[key] = { since: prev ? prev.since : now, at: now, reason: 'waiting' };
    if (st.cooldownUntil > now) return { take: false, reason: 'cooldown', nextAt: st.cooldownUntil, state: st };
    const rateWait = () => now + Math.ceil((1 - st.tokens) * 1000 / SIMCO.RATE_PER_S);
    const order = simcoOrder(st.wants).filter(x => !x.flying || x.k === key);
    const ahead = Math.max(0, order.findIndex(x => x.k === key));
    if (st.unreachableSince) {
      // The probe: the first want that can be served (the caller itself always counts), so a stale or runner-less want
      // ahead cannot hold it. Once the probe is PROBE_GRACE_MS overdue, any caller probes (no outage stays stuck).
      const eligible = typeof canRun === 'function' ? order.filter(x => x.k === key || canRun(x.k)) : order;
      const first = eligible.length > 0 && eligible[0].k === key;
      if (now < st.nextProbeAt || (!first && now < st.nextProbeAt + SIMCO.PROBE_GRACE_MS)) return { take: false, reason: 'unreachable', nextAt: Math.max(now, st.nextProbeAt), state: st };
    } else {
      if (st.tokens < 1) return { take: false, reason: 'rate', nextAt: rateWait(), state: st };
      if (st.tokens < ahead + 1) return { take: false, reason: 'yield', nextAt: now + Math.ceil((ahead + 1 - st.tokens) * 1000 / SIMCO.RATE_PER_S), state: st };
    }
    if (st.tokens < 1) return { take: false, reason: 'rate', nextAt: rateWait(), state: st };
    if (peek) return { take: true, peek: true, nextAt: now, state: st };
    st.tokens -= 1; st.lastAt = now; st.lastJob = key; st.wants[key].reason = 'in flight';
    if (st.unreachableSince) st.nextProbeAt = now + SIMCO.PROBE_MS[st.probeStep];
    return { take: true, nextAt: now, state: st };
  }
  // The outcome of a request: {ok, status, network, retryAfterMs}. Returns {state, logOutage, recovered}.
  function simcoResult(raw, key, res, now = Date.now()) {
    const st = simcoState(raw, now), r = res || {};
    const ok = !!r.ok, status = Math.max(0, Math.round(Number(r.status)) || 0);
    const network = !ok && (r.network === true || status === 0);
    const w = st.wants[key], since = w ? w.since : now;
    st.lastResult = { key: String(key || '').slice(0, 60), ok, status, at: now };
    let logOutage = false, recovered = false;
    const last = SIMCO.PROBE_MS.length - 1;
    if (network) {
      if (!st.unreachableSince) { st.unreachableSince = now; st.probeStep = 0; logOutage = true; st.loggedOutage = true; }
      else st.probeStep = Math.min(last, st.probeStep + 1);
      st.nextProbeAt = now + SIMCO.PROBE_MS[st.probeStep];
      if (laneKeyOk(key)) st.wants[key] = { since, at: now, reason: 'waiting' };
      return { state: st, logOutage, recovered };
    }
    if (st.unreachableSince) { recovered = true; st.unreachableSince = 0; st.probeStep = 0; st.nextProbeAt = 0; st.loggedOutage = false; }
    if (status === 429) {
      const ra = Number(r.retryAfterMs);
      st.cooldownUntil = now + Math.min(SIMCO.COOLDOWN_MAX_MS, ra > 0 ? ra : SIMCO.COOLDOWN_DEFAULT_MS);
      if (laneKeyOk(key)) st.wants[key] = { since, at: now, reason: 'waiting' };
    } else delete st.wants[key];
    return { state: st, logOutage, recovered };
  }
  // What the UI and the worker show: both channels, each queue in the exact order the channel would serve it.
  function channelSnapshot(laneRaw, simcoRaw, now = Date.now()) {
    const ls = laneState(laneRaw, now), ss = simcoState(simcoRaw, now);
    const elig = {}, backed = [];
    for (const [k, w] of Object.entries(ls.wants)) { if (laneBackoffUntil(ls, k) > now) backed.push(k); else elig[k] = w; }
    const gq = [], item = (k, reason) => ({ key: k, label: laneSpec(k).label, since: ls.wants[k].since, prio: laneSpec(k).prio, reason });
    const reasonOf = k => ls.fails[k] ? `retry after failure (${ls.fails[k].n})` : 'waiting for slot';
    for (let k = laneWinner(elig, now, ls.lastAt); k; k = laneWinner(elig, now, ls.lastAt)) { gq.push(item(k, reasonOf(k))); delete elig[k]; }
    backed.sort((a, b) => laneBackoffUntil(ls, a) - laneBackoffUntil(ls, b) || (a < b ? -1 : 1));
    for (const k of backed) gq.push(item(k, reasonOf(k)));
    const sq = simcoOrder(ss.wants).map(x => ({ key: x.k, label: simcoSpec(x.k).label, since: x.since, prio: x.prio,
      reason: ss.cooldownUntil > now ? 'cooling down after 429' : ss.unreachableSince ? 'waiting for SimcoTools to answer' : x.flying ? 'in flight' : 'waiting' }));
    let sNext = now;
    if (ss.cooldownUntil > now) sNext = ss.cooldownUntil;
    else if (ss.unreachableSince) sNext = Math.max(now, ss.nextProbeAt);
    else if (ss.tokens < 1) sNext = now + Math.ceil((1 - ss.tokens) * 1000 / SIMCO.RATE_PER_S);
    return {
      at: now,
      game: { lastAt: ls.lastAt || null, lastJob: ls.lastJob, lastResult: ls.lastResult, nextAt: Math.max(now, ls.lastAt ? ls.lastAt + LANE.GAP_MS : now), paused: null, queue: gq },
      simco: { lastAt: ss.lastAt || null, lastJob: ss.lastJob, lastResult: ss.lastResult, nextAt: sNext, unreachableSince: ss.unreachableSince || null,
        nextProbeAt: ss.unreachableSince ? ss.nextProbeAt : null, cooldownUntil: ss.cooldownUntil || null, tokens: Math.floor(ss.tokens * 100) / 100, queue: sq }
    };
  }

  root.SCM_TIMERS_CORE = { KEY: 'scmSyncTimers', TIMERS, byId, IDS, UNIT_MS, defaults, freshInstall, SWITCHED_OFF_TEXT: 'Not read: switched off (Background timers)', normalize, normalizeAt, merge, toStored, isDefault, clamp, intervalMs, intervalMinutes, nextDailyAt, clockOf, timerForAlarm,
    LANE, laneBase, laneSpec, laneKeyOk, laneState, laneNextSlotAt, laneWinner, laneDecide, laneNote, laneResult, laneBackoffUntil, LANE_BACKOFF_MS,
    SIMCO, simcoSpec, simcoState, simcoTake, simcoResult, channelSnapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SCM_TIMERS_CORE;
})(typeof globalThis !== 'undefined' ? globalThis : self);
