/* Local persistence and silent record upload. The UI never shows sync state.
   Completion records are written locally first, then uploaded in the background with retries. */
globalThis.RehabStore = (() => {
  "use strict";
  const PLAN_A = "five-stage-v1", PLAN_B = "lower-limb-joints-v1";
  const PROGRAMS = [PLAN_A, PLAN_B];
  const validId = value => typeof value === "string" && /^[\w-]{8,100}$/.test(value);
  const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const keyOf = (program, id) => `${program}:${id}`;

  function create(options = {}) {
    const storage = options.storage;
    const isolated = Boolean(options.isolated);
    const fetcher = options.fetch || globalThis.fetch?.bind(globalThis);
    const now = options.now || (() => Date.now());
    const uuid = options.uuid || (() => globalThis.crypto.randomUUID());
    const timeoutMs = options.timeoutMs || 10000;
    const ns = isolated ? "rehab:test:v3" : "rehab:v3";
    const listeners = new Set();
    let flushing = null, serial = 0;

    const read = (name, fallback = null) => { try { const raw = storage.getItem(name); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; } };
    const write = (name, value) => { try { storage.setItem(name, JSON.stringify(value)); return true; } catch { return false; } };
    const remove = name => { try { storage.removeItem(name); } catch { /* storage unavailable */ } };
    const keys = prefix => {
      const found = [];
      try { for (let i = 0; i < storage.length; i++) { const name = storage.key(i); if (name && name.startsWith(prefix)) found.push(name); } } catch { /* storage unavailable */ }
      return found.sort();
    };
    const emit = () => { for (const listener of listeners) { try { listener(); } catch { /* listener errors stay local */ } } };

    // Preferences shared by both plans on this device.
    function prefs() {
      const value = read(`${ns}:prefs`, {}) || {};
      return { groupRest: [60, 90, 120, 150].includes(value.groupRest) ? value.groupRest : 60, sound: value.sound !== false };
    }
    function setPrefs(patch) { return write(`${ns}:prefs`, { ...prefs(), ...patch }); }

    // One resumable session per plan.
    const progress = program => read(`${ns}:progress:${program}`);
    const saveProgress = (program, snapshot) => snapshot ? write(`${ns}:progress:${program}`, snapshot) : (remove(`${ns}:progress:${program}`), true);
    const clearProgress = program => saveProgress(program, null);

    // Records: last known server state plus local changes still waiting in the outbox.
    const cache = () => read(`${ns}:records`, {}) || {};
    const saveCache = value => write(`${ns}:records`, value);
    const outbox = () => keys(`${ns}:out:`).map(name => ({ name, op: read(name) })).filter(entry => entry.op && entry.op.type);
    function enqueue(op) {
      if (isolated) return true; // Test modes never talk to the API.
      const sequence = String(now()).padStart(15, "0") + String(serial++).padStart(4, "0");
      return write(`${ns}:out:${sequence}-${op.id}`, { ...op, createdAt: now() });
    }
    function cleanRecord(value, program, source) {
      if (!value || !validId(value.id) || !validDate(value.date) || !PROGRAMS.includes(program)) return null;
      const finishedAt = typeof value.finishedAt === "string" ? value.finishedAt : null;
      if (source !== "manual" && !finishedAt) return null;
      return { version: 1, id: value.id, program, date: value.date, finishedAt: source === "manual" ? null : finishedAt, source, timeZone: typeof value.timeZone === "string" ? value.timeZone : null };
    }
    function applyLocal(op, records) {
      if (op.type === "put" && op.record) {
        const k = keyOf(op.record.program, op.record.id);
        if (!records[k]) records[k] = { ...op.record, revoked: false, pending: true };
      } else if (op.type === "revoke") {
        const k = keyOf(op.program, op.recordId);
        if (records[k]) records[k] = { ...records[k], revoked: true };
      }
    }
    function list(program) {
      return Object.values(cache()).filter(record => !record.revoked && (!program || record.program === program))
        .sort((a, b) => a.date.localeCompare(b.date) || String(a.finishedAt || "").localeCompare(String(b.finishedAt || "")) || a.id.localeCompare(b.id));
    }
    function change(op) {
      const records = cache();
      applyLocal(op, records);
      const saved = saveCache(records) && enqueue(op);
      emit(); schedule();
      return saved;
    }
    function complete(record) {
      const clean = cleanRecord(record, record?.program, "training");
      if (!clean) return false;
      return change({ id: `put-${clean.id}`, type: "put", record: clean });
    }
    function addManual(program, date, today) {
      if (!PROGRAMS.includes(program) || !validDate(date) || date > today) return false;
      let timeZone = null;
      try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { timeZone = null; }
      const record = { version: 1, id: `manual-${uuid()}`, program, date, finishedAt: null, source: "manual", timeZone };
      return change({ id: `put-${record.id}`, type: "put", record });
    }
    function revoke(program, recordId) {
      if (!PROGRAMS.includes(program) || !validId(recordId)) return false;
      return change({ id: `revoke-${recordId}`, type: "revoke", program, recordId });
    }

    async function request(method, path, body) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetcher(path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: controller?.signal });
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        return { status: response.status, data };
      } finally { if (timer) clearTimeout(timer); }
    }

    // Server records replace the cache; pending local changes are laid back on top.
    async function refresh() {
      if (isolated || !fetcher) return false;
      try {
        const { status, data } = await request("GET", "/api/records");
        if (status !== 200 || !data?.ok || !Array.isArray(data.records)) return false;
        const records = {};
        for (const record of data.records) if (PROGRAMS.includes(record.program) && validId(record.id)) records[keyOf(record.program, record.id)] = { ...record, version: 1 };
        for (const { op } of outbox()) applyLocal(op, records);
        saveCache(records);
        importLegacyV1(records);
        emit();
        return true;
      } catch { return false; }
    }
    async function flushOnce() {
      if (isolated || !fetcher) return;
      for (const { name, op } of outbox()) {
        let response;
        try {
          response = op.type === "put"
            ? await request("POST", "/api/records", { record: op.record })
            : await request("POST", "/api/records/revoke", { program: op.program, id: op.recordId });
        } catch { return; } // Offline: keep everything for the next attempt.
        const { status, data } = response;
        if (status >= 500 || status === 0) return;
        if (status === 200 && data?.ok) {
          remove(name);
          if (data.record) {
            const records = cache();
            records[keyOf(data.record.program, data.record.id)] = { ...data.record, version: 1 };
            for (const entry of outbox()) applyLocal(entry.op, records);
            saveCache(records);
          }
          continue;
        }
        if (op.type === "put" && status === 409) { remove(name); continue; } // Same id already stored with other content.
        if (op.type === "revoke" && status === 404 && !outbox().some(entry => entry.op.type === "put" && entry.op.record?.id === op.recordId)) { remove(name); continue; }
        // Other client errors stay queued without blocking later operations.
      }
      emit();
    }
    function flush() {
      if (!flushing) flushing = flushOnce().finally(() => { flushing = null; });
      return flushing;
    }
    let scheduled = false;
    function schedule() {
      if (isolated || scheduled) return;
      scheduled = true;
      Promise.resolve().then(() => { scheduled = false; flush(); });
    }

    // One-time carry-over from the previous cloud version: queued completions, manual records and revocations.
    function migrateV2() {
      if (isolated) return;
      const done = read(`${ns}:migrated`, {}) || {};
      if (done.v2) return;
      const records = cache();
      for (const name of keys("rehab-timer:v2:record:")) {
        const value = read(name);
        const record = value && cleanRecord(value, value.program, ["training", "manual", "legacy"].includes(value.source) ? value.source : "training");
        if (record) records[keyOf(record.program, record.id)] = { ...record, revoked: Boolean(value.revoked) };
      }
      saveCache(records);
      for (const name of keys("rehab-timer:v2:op:")) {
        const op = read(name);
        if (!op || !PROGRAMS.includes(op.program) || op.conflict && op.type !== "complete") continue;
        if (op.type === "complete" || op.type === "manual") {
          const record = cleanRecord(op.payload?.record, op.program, op.type === "manual" ? "manual" : "training");
          if (record) change({ id: `put-${record.id}`, type: "put", record });
        } else if (op.type === "revoke" && validId(op.payload?.recordId)) {
          change({ id: `revoke-${op.payload.recordId}`, type: "revoke", program: op.program, recordId: op.payload.recordId });
        }
      }
      write(`${ns}:migrated`, { ...done, v2: true });
    }
    // One-time silent import of the original local-only history. Raw keys only, never test prefixes.
    // A `false` date override keeps that date's old sessions out; a `true` one adds a manual record
    // only when the date has no record at all for that plan.
    function importLegacyV1(serverRecords) {
      if (isolated) return;
      const done = read(`${ns}:migrated`, {}) || {};
      if (done.v1) return;
      const sources = [["rehab-timer:v1", PLAN_A], ["rehab-timer:v1:joint", PLAN_B]];
      for (const [prefix, program] of sources) {
        const hidden = new Set(), added = new Set();
        for (const name of keys(`${prefix}:date:`)) {
          const date = name.slice(`${prefix}:date:`.length), value = read(name);
          if (validDate(date) && value === false) hidden.add(date);
        }
        const known = () => new Set(Object.values({ ...serverRecords, ...cache() }).filter(r => r.program === program && !r.revoked).map(r => r.date));
        for (const name of keys(`${prefix}:done:`)) {
          const value = read(name);
          if (!value || value.version !== 1 || name !== `${prefix}:done:${value.id}`) continue;
          const record = cleanRecord(value, program, "legacy");
          if (!record || hidden.has(record.date) || serverRecords[keyOf(program, record.id)]) continue;
          change({ id: `put-${record.id}`, type: "put", record }); added.add(record.date);
        }
        for (const name of keys(`${prefix}:date:`)) {
          const date = name.slice(`${prefix}:date:`.length);
          if (!validDate(date) || read(name) !== true || known().has(date) || added.has(date)) continue;
          const id = `legacy-manual-${program === PLAN_A ? "a" : "b"}-${date}`;
          change({ id: `put-${id}`, type: "put", record: { version: 1, id, program, date, finishedAt: null, source: "manual", timeZone: null } });
        }
      }
      write(`${ns}:migrated`, { ...done, v1: true });
    }

    function init() {
      migrateV2();
      return refresh().then(() => flush());
    }
    return Object.freeze({
      ns, isolated, prefs, setPrefs, progress, saveProgress, clearProgress, list, complete, addManual, revoke,
      refresh, flush, init, pending: () => outbox().length,
      onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    });
  }
  return Object.freeze({ create });
})();
