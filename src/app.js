/* Page controller. RehabCore decides what may happen; this file draws it and drives the clock. */
(() => {
  "use strict";
  const Core = globalThis.RehabCore, Sound = globalThis.RehabAudio, Store = globalThis.RehabStore;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const debugMs = Math.max(0, Number(params.get("debugMs")) || 0);
  const testMode = params.get("test") === "1";
  const fileMode = location.protocol === "file:";
  const isolated = fileMode || testMode || debugMs > 0;
  const unit = debugMs > 0 ? debugMs : 1000; // milliseconds per training second (wall clock only)
  const clips = globalThis.RehabVoice?.clips || {};
  const voiceVersion = globalThis.RehabVoice?.version || "0";
  // The small AAC copy is tried first; the WAV is the exact fallback.
  const VOICE_URLS = [globalThis.RehabVoice?.compact && `audio/${RehabVoice.compact.file}?v=${voiceVersion}`, `audio/voice.wav?v=${voiceVersion}`].filter(Boolean);
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

  function memoryStorage() {
    const data = new Map();
    return { get length() { return data.size; }, key: i => [...data.keys()][i] ?? null, getItem: k => data.has(k) ? data.get(k) : null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
  }
  let storage;
  try { storage = globalThis.localStorage; storage.getItem("rehab:probe"); } catch { storage = memoryStorage(); }
  const store = Store.create({ storage, isolated });
  const media = $("player");
  const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

  const ui = {
    screen: "home", plan: Core.PLAN_A, session: null,
    voice: debugMs ? "off" : "loading", forceSilent: debugMs > 0, voiceStart: 0, voiceBytes: 0, voiceTotal: 0, voiceDrawn: 0, voiceTimer: 0,
    clock: { kind: null, t0: 0 }, expectingPause: false, lastMediaTime: 0, lastProgressAt: 0, lastSaveAt: 0,
    tracks: new Map(), playingUrl: null, loop: null, lockUntil: 0, wakeLock: null,
    elapsedStart: null, elapsedMs: null, lastCompletion: null, sheetFrom: null,
    prepConfirm: false, month: null, selected: null, revokeArmed: null, manualArmed: null, manualOpen: false,
    holdNotice: "", lastSegmentKey: ""
  };

  // ---------- small helpers ----------
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
  const show = (el, visible) => { if (el.hasAttribute("hidden") === visible) el.toggleAttribute("hidden", !visible); }; // SVG has no .hidden property
  const useArt = (svg, art) => { const use = svg.querySelector("use"); const ref = `#art-${art}`; if (use.getAttribute("href") !== ref) use.setAttribute("href", ref); };
  // Illustrated items show their picture; the rest keep the line-art symbol.
  function setArt(svg, img, item) {
    if (item.image) {
      show(svg, false);
      if (img.getAttribute("src") !== item.image) { img.setAttribute("src", item.image); img.alt = `${item.name}示意图`; }
      show(img, true);
    } else { show(img, false); show(svg, true); useArt(svg, item.art); }
  }
  const artHtml = item => item.image ? `<img src="${item.image}" alt="" loading="lazy" decoding="async">` : `<svg aria-hidden="true"><use href="#art-${item.art}"/></svg>`;
  const planName = id => Core.PLANS[id].name;
  const today = () => new Date();
  const todayKey = () => Core.localDate(today());
  const dateLabel = key => { const [y, m, d] = key.split("-").map(Number); const date = new Date(y, m - 1, d, 12); return `${m} 月 ${d} 日 周${WEEKDAYS[date.getDay()]}`; };
  const clockText = seconds => seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : String(Math.max(1, Math.ceil(seconds - 1e-6)));
  // The numbers a new session of this plan would use: the plan's own, with the user's adjustments on top.
  const configFor = planId => Core.normalize(planId, store.planSettings(planId));
  const minutes = planId => Math.round(Core.doseSeconds(planId, configFor(planId)) / 60);
  const locked = () => performance.now() < ui.lockUntil;
  const lockTaps = () => { ui.lockUntil = performance.now() + 700; };
  function note(el, message) { setText(el, message || ""); show(el, Boolean(message)); }

  // ---------- voice file ----------
  const SLOW_VOICE_MS = 4000; // after this long, offer to start without sound
  function loadVoice() {
    if (debugMs) return;
    if (!Sound.supported()) { ui.voice = "off"; return; }
    ui.voice = "loading"; ui.voiceStart = performance.now(); ui.voiceBytes = 0; ui.voiceTotal = 0;
    clearTimeout(ui.voiceTimer); ui.voiceTimer = setTimeout(refresh, SLOW_VOICE_MS + 100);
    const onProgress = (bytes, total) => {
      ui.voiceBytes = bytes; ui.voiceTotal = total;
      if (performance.now() - ui.voiceDrawn > 400) { ui.voiceDrawn = performance.now(); refresh(); }
    };
    Sound.load(VOICE_URLS, { onProgress, samples: globalThis.RehabVoice?.samples }).then(() => { ui.voice = "ready"; refresh(); }).catch(() => { ui.voice = "off"; refresh(); });
  }
  // What the page tells the user about the voice file, and the one action that helps.
  function voiceStatus() {
    if (debugMs) return { message: "", action: null };
    if (ui.voice === "loading" && !ui.forceSilent) {
      if (performance.now() - ui.voiceStart < SLOW_VOICE_MS) return { message: "", action: null };
      const size = ui.voiceTotal > 0 && ui.voiceBytes <= ui.voiceTotal ? `${Math.round(ui.voiceBytes / ui.voiceTotal * 100)}%` : `${(ui.voiceBytes / 1048576).toFixed(1)} MB`;
      return { message: `声音正在下载（${size}），网络慢时要等一会儿。`, action: ["不等了，静音开始", () => { ui.forceSilent = true; refresh(); }] };
    }
    if (ui.voice === "off") {
      return { message: "声音没有加载成功，这次会静音计时。", action: Sound.supported() ? ["重新下载声音", () => { ui.forceSilent = false; loadVoice(); refresh(); }] : null };
    }
    return { message: ui.forceSilent ? "这次静音计时。" : "", action: null };
  }
  function renderVoiceAction(id, action) {
    const el = $(id);
    show(el, Boolean(action));
    if (!action) return;
    setText(el, action[0]);
    el.onclick = action[1];
  }

  // ---------- audio tracks ----------
  const audioMode = () => (!ui.forceSilent && ui.voice === "ready" && Sound.supported()) ? "media" : "wall";
  const MAX_CACHED_TRACKS = 6, MAX_CACHED_BYTES = 200 * 1048576; // long tracks are tens of MB each
  function prepare(track) {
    if (!track || audioMode() !== "media") return null;
    const key = track.key;
    let entry = ui.tracks.get(key);
    if (!entry) {
      entry = { key, result: null, failed: false };
      entry.promise = Sound.render(track, clips).then(result => { entry.result = result; trimTracks(); refresh(); return result; }).catch(() => { entry.failed = true; refresh(); });
      ui.tracks.set(key, entry);
      trimTracks();
    }
    return entry;
  }
  // Keep the newest tracks within a count and memory budget, never dropping the one that is playing.
  function trimTracks() {
    const bytes = () => [...ui.tracks.values()].reduce((sum, entry) => sum + (entry.result?.bytes || 0), 0);
    while (ui.tracks.size > MAX_CACHED_TRACKS || bytes() > MAX_CACHED_BYTES) {
      const oldest = [...ui.tracks.entries()].find(([, entry]) => entry.result && entry.result.url !== ui.playingUrl);
      if (!oldest) break;
      URL.revokeObjectURL(oldest[1].result.url);
      ui.tracks.delete(oldest[0]);
    }
  }
  // Ready means the next tap can call play() synchronously inside the gesture.
  function trackReady(track) {
    if (!track) return true;
    if (audioMode() !== "media") return ui.voice !== "loading" || ui.forceSilent;
    const entry = prepare(track);
    if (entry?.failed) { ui.forceSilent = true; return true; }
    return Boolean(entry?.result);
  }
  function startClock(track) {
    if (audioMode() === "media") {
      const entry = prepare(track);
      if (!entry?.result) return false;
      ui.expectingPause = false;
      media.muted = !store.prefs().sound;
      media.src = entry.result.url;
      ui.playingUrl = entry.result.url;
      ui.clock.kind = "media";
      const playing = media.play(); // Must stay synchronous with the tap.
      if (playing?.catch) playing.catch(() => interrupt("声音没有播放。请检查静音开关和音量，然后点继续。", true));
    } else {
      ui.clock.kind = "wall"; ui.clock.t0 = performance.now();
    }
    ui.lastMediaTime = 0; ui.lastProgressAt = performance.now();
    requestWakeLock(); startLoop();
    return true;
  }
  function playOnce(track) {
    // Spoken cues for manual sets and the final message: no clock depends on them.
    if (audioMode() !== "media" || !track) return;
    const entry = prepare(track);
    if (!entry?.result) return;
    ui.expectingPause = false; ui.clock.kind = null;
    media.muted = !store.prefs().sound; media.src = entry.result.url; ui.playingUrl = entry.result.url;
    media.play()?.catch?.(() => {});
  }
  function stopClock() {
    if (ui.clock.kind === "media") { ui.expectingPause = true; media.pause(); }
    ui.clock.kind = null; stopLoop(); releaseWakeLock();
  }
  const clockTime = () => ui.clock.kind === "media" ? media.currentTime : ui.clock.kind === "wall" ? (performance.now() - ui.clock.t0) / unit : 0;

  function startLoop() { if (!ui.loop) ui.loop = setInterval(tick, debugMs ? Math.min(50, debugMs / 2) : 100); }
  function stopLoop() { if (ui.loop) { clearInterval(ui.loop); ui.loop = null; } }

  async function requestWakeLock() {
    try { if (navigator.wakeLock && !ui.wakeLock && !document.hidden) { ui.wakeLock = await navigator.wakeLock.request("screen"); ui.wakeLock.addEventListener?.("release", () => { ui.wakeLock = null; }); } } catch { ui.wakeLock = null; }
  }
  function releaseWakeLock() { try { ui.wakeLock?.release(); } catch { /* already released */ } ui.wakeLock = null; }

  // ---------- session lifecycle ----------
  function save(force = false) {
    const s = ui.session;
    if (!s) return;
    if (!force && performance.now() - ui.lastSaveAt < 3000) return;
    ui.lastSaveAt = performance.now();
    store.saveProgress(s.plan, s.snapshot());
  }
  function tick() {
    const s = ui.session;
    if (!s || s.state !== "running") { stopLoop(); return; }
    const t = clockTime();
    if (ui.clock.kind === "media" && !document.hidden && !media.paused) {
      if (t > ui.lastMediaTime + 0.001) { ui.lastMediaTime = t; ui.lastProgressAt = performance.now(); }
      else if (performance.now() - ui.lastProgressAt > 4000) { interrupt("声音卡住了，已暂停。点继续，这一次从头开始。"); return; }
    }
    const result = s.advance(t, new Date());
    if (result === "item-done") { releaseWakeLock(); stopLoop(); ui.clock.kind = null; lockTaps(); save(true); go("between"); return; }
    if (result === "finished") { releaseWakeLock(); stopLoop(); ui.clock.kind = null; finishSession(); return; }
    save();
    renderRun(t);
  }
  function interrupt(message, offerSilent = false) {
    const s = ui.session;
    if (!s || s.state !== "running") return;
    const t = clockTime();
    stopClock();
    s.pause(t);
    ui.holdNotice = message || "";
    ui.offerSilent = offerSilent;
    save(true); go("hold");
  }
  function beginPrimary(track) {
    // Shared by start / continue / next item: play first, then update the screen.
    const s = ui.session;
    if (!trackReady(track)) return false;
    s.begin();
    if (s.state === "manual") { playOnce(track); save(true); go("hold"); return true; }
    if (!startClock(track)) return false;
    ui.holdNotice = ""; ui.offerSilent = false; ui.lastSegmentKey = "";
    save(true); go("run");
    return true;
  }
  function finishSession() {
    const s = ui.session;
    if (!s?.completion) return;
    store.complete(s.completion);
    store.clearProgress(s.plan);
    ui.lastCompletion = s.completion;
    ui.elapsedMs = ui.elapsedStart ? Date.now() - ui.elapsedStart : null;
    ui.session = null; ui.elapsedStart = null;
    go("done");
  }
  function endSession(keep) {
    const s = ui.session;
    closeSheet();
    if (s) {
      if (s.state === "running") { const t = clockTime(); stopClock(); s.pause(t); }
      if (keep) store.saveProgress(s.plan, s.snapshot()); else store.clearProgress(s.plan);
    }
    stopClock();
    try { media.pause(); } catch { /* nothing playing */ }
    ui.session = null; ui.elapsedStart = null;
    go("home");
  }
  function restoreSession(plan) {
    const snapshot = store.progress(plan);
    const session = snapshot && Core.Session.restore(snapshot);
    if (!session) { if (snapshot) store.clearProgress(plan); return null; }
    return session;
  }

  // ---------- navigation ----------
  const SCREENS = ["home", "prep", "run", "hold", "between", "done", "records"];
  function go(screen) {
    ui.screen = screen;
    $("app").dataset.screen = screen;
    for (const name of SCREENS) show($(name), name === screen);
    show($("tabbar"), screen === "home" || screen === "records");
    $("tabTrain").toggleAttribute("aria-current", screen === "home");
    if (screen === "home") $("tabTrain").setAttribute("aria-current", "page");
    if (screen === "records") $("tabRecords").setAttribute("aria-current", "page"); else $("tabRecords").removeAttribute("aria-current");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", screen === "run" || screen === "hold" ? "#062033" : "#eef6f5");
    refresh();
    const focus = { prep: "prepStart", hold: "holdPrimary", between: "betweenStart", done: "doneOk", run: "runPause" }[screen];
    if (focus) requestAnimationFrame(() => $(focus)?.focus({ preventScroll: true }));
    window.scrollTo(0, 0);
  }
  function refresh() {
    syncSoundButtons();
    if (ui.screen === "home") renderHome();
    else if (ui.screen === "prep") renderPrep();
    else if (ui.screen === "run") renderRun(clockTime());
    else if (ui.screen === "hold") renderHold();
    else if (ui.screen === "between") renderBetween();
    else if (ui.screen === "done") renderDone();
    else if (ui.screen === "records") renderRecords();
  }

  // ---------- home ----------
  function weekStrip(el) {
    const keys = Core.weekDates(today()), now = todayKey(), records = store.list();
    const byDate = new Map();
    for (const r of records) { if (!byDate.has(r.date)) byDate.set(r.date, new Set()); byDate.get(r.date).add(r.program); }
    el.replaceChildren(...keys.map((key, i) => {
      const cell = document.createElement("span");
      const dot = document.createElement("i");
      const plans = byDate.get(key), hasA = plans?.has(Core.PLAN_A), hasB = plans?.has(Core.PLAN_B);
      if (plans) dot.classList.add("on", hasA && hasB ? "both" : hasA ? "a" : "b");
      if (key === now) dot.classList.add("today");
      const names = [hasA && "左腿抗阻", hasB && "双腿关节"].filter(Boolean).join("、");
      cell.append("一二三四五六日"[i], dot);
      cell.setAttribute("aria-label", `${dateLabel(key)}${plans ? ` 已练 ${names}` : ""}`);
      return cell;
    }));
    return records.filter(r => keys.includes(r.date)).length;
  }
  function renderHome() {
    setText($("homeDate"), dateLabel(todayKey()));
    const count = weekStrip($("homeWeek"));
    setText($("homeWeekCount"), count ? `本周已练 ${count} 次` : "本周还没有练");
    $("planCards").replaceChildren(...Core.PLAN_IDS.map(planCard));
  }
  function planCard(planId) {
    const plan = Core.PLANS[planId], session = restoreSession(planId);
    const card = document.createElement("article");
    card.className = "plan-card";
    const top = document.createElement("div"); top.className = "top";
    const name = document.createElement("span"); name.className = "name"; name.textContent = plan.name;
    const meta = document.createElement("span"); meta.className = "meta";
    meta.textContent = `约 ${minutes(planId)} 分钟${plan.items.some(i => i.type === "manual") ? " + 1 项不计时" : ""}`;
    top.append(name, meta);
    const pics = document.createElement("div"); pics.className = "pics"; pics.setAttribute("aria-hidden", "true");
    for (const item of plan.items) pics.insertAdjacentHTML("beforeend", `<span${item.image ? ' class="photo"' : ""}>${artHtml(item)}</span>`);
    const foot = document.createElement("div"); foot.className = "card-foot";
    const actions = document.createElement("div"); actions.className = "card-actions";
    if (session) {
      const line = document.createElement("p"); line.className = "resume-line";
      line.append("上次练到 ");
      const b = document.createElement("b"); b.textContent = session.state === "between" ? `第 ${session.item + 1} 项开始前` : Core.describePlace(planId, session.item, session.at, session.config);
      line.append(b);
      card.append(top, pics, line);
      const restart = button("从头开始", "link-button", () => openPrep(planId));
      const resume = button("继续", "cta", () => resumePlan(planId));
      actions.append(restart, resume);
      foot.append(document.createElement("span"), actions);
    } else {
      const last = store.list(planId).at(-1);
      const info = document.createElement("span"); info.className = "muted";
      info.textContent = last ? `上次 ${dateLabel(last.date).replace(/ 周.$/, "")}` : "还没有记录";
      actions.append(button("开始", "cta alt", () => openPrep(planId)));
      foot.append(info, actions);
      card.append(top, pics);
    }
    card.append(foot);
    return card;
  }
  function button(label, className, onClick) {
    const el = document.createElement("button");
    el.type = "button"; el.className = className; el.textContent = label;
    el.addEventListener("click", onClick);
    return el;
  }
  function resumePlan(planId) {
    if (ui.session && ui.session.plan !== planId) { save(true); ui.session = null; }
    const session = ui.session?.plan === planId ? ui.session : restoreSession(planId);
    if (!session) { openPrep(planId); return; }
    ui.session = session; ui.plan = planId; ui.elapsedStart = null; ui.holdNotice = "";
    go(session.state === "between" ? "between" : "hold");
  }

  // ---------- prep ----------
  function openPrep(planId) { ui.plan = planId; ui.prepConfirm = false; go("prep"); }

  // Training settings: one stepper per adjustable number, saved per plan on this device.
  const PARAM_HINTS = {
    [Core.PLAN_A]: "组数和次数用于前四项；第 5 项（踮脚、拉伸）用最后四行。项间休息选“不休息”时，每项结束后等你点击再开始下一项。",
    [Core.PLAN_B]: "组数也用于第 5 项（不计时）；次数、保持和休息用于前四项。项间休息选“不休息”时，每项结束后等你点击再开始下一项。"
  };
  function buildParams() {
    ui.paramsPlan = ui.plan;
    $("paramRows").replaceChildren(...Core.fieldKeys(ui.plan).map(key => {
      const field = Core.FIELDS[key];
      const row = document.createElement("div"); row.className = "param-row"; row.dataset.key = key;
      const label = document.createElement("span"); label.className = "param-label"; label.id = `param-${key}`; label.textContent = field.label;
      const stepper = document.createElement("div"); stepper.className = "stepper"; stepper.setAttribute("role", "group"); stepper.setAttribute("aria-labelledby", label.id);
      const minus = button("−", "", () => stepParam(key, -1)); minus.setAttribute("aria-label", `减少${field.label}`);
      const value = document.createElement("output");
      const plus = button("+", "", () => stepParam(key, 1)); plus.setAttribute("aria-label", `增加${field.label}`);
      stepper.append(minus, value, plus);
      row.append(label, stepper);
      return row;
    }));
    setText($("paramsHint"), PARAM_HINTS[ui.plan]);
  }
  function syncParams() {
    if (ui.paramsPlan !== ui.plan) buildParams();
    const cfg = configFor(ui.plan), changed = Core.changedKeys(ui.plan, cfg);
    let capped = false;
    for (const row of $("paramRows").children) {
      const key = row.dataset.key, all = Core.FIELDS[key].values, choices = Core.choices(ui.plan, cfg, key), at = choices.indexOf(cfg[key]);
      const [minus, output, plus] = row.querySelector(".stepper").children;
      setText(output, Core.FIELDS[key].format(cfg[key]));
      minus.disabled = at <= 0;
      plus.disabled = at >= choices.length - 1;
      if (plus.disabled && all.indexOf(cfg[key]) < all.length - 1) capped = true;
      row.classList.toggle("changed", changed.includes(key));
    }
    setText($("paramsSummary"), `${cfg.sets} 组 × ${cfg.reps} 次 · 保持 ${cfg.hold} 秒 · ${changed.length ? "已调整" : "默认"}`);
    show($("paramsReset"), changed.length > 0);
    note($("paramsCap"), capped ? `单项最长 ${Core.MAX_ITEM_SECONDS / 60} 分钟，再增加会超过，所以不能继续调大。` : "");
    return cfg;
  }
  function saveConfig(cfg) {
    const overrides = {};
    for (const key of Core.changedKeys(ui.plan, cfg)) overrides[key] = cfg[key];
    store.setPlanSettings(ui.plan, overrides);
    ui.prepConfirm = false;
    settlePrep(); refresh();
  }
  function stepParam(key, direction) {
    const cfg = configFor(ui.plan), choices = Core.choices(ui.plan, cfg, key);
    const next = choices[choices.indexOf(cfg[key]) + direction];
    if (next !== undefined) saveConfig({ ...cfg, [key]: next });
  }
  // Voice tracks are rendered only once the user stops tapping, so rapid steps do not queue renders.
  function settlePrep() {
    ui.prepSettling = true;
    clearTimeout(ui.prepTimer);
    ui.prepTimer = setTimeout(() => { ui.prepSettling = false; if (ui.screen === "prep") refresh(); }, 400);
  }
  function prepTrack() { return Core.buildTrack(Core.compile(ui.plan, 0, configFor(ui.plan)), 0, "start"); }
  function renderPrep() {
    const plan = Core.PLANS[ui.plan];
    const cfg = syncParams();
    setText($("prepTitle"), plan.name);
    setText($("prepMeta"), `${plan.items.length} 项 · 约 ${minutes(ui.plan)} 分钟${plan.items.some(i => i.type === "manual") ? "，另有 1 项不计时" : ""}`);
    const tools = [...new Set(plan.items.flatMap(item => item.tools))];
    $("prepTools").replaceChildren(...(tools.length ? tools : ["不需要额外器材"]).map(text => { const c = document.createElement("span"); c.className = tools.length ? "chip tool" : "chip"; c.textContent = text; return c; }));
    $("prepItems").replaceChildren(...Core.itemsFor(ui.plan, cfg).map(item => {
      const li = document.createElement("li");
      li.insertAdjacentHTML("beforeend", artHtml(item));
      const text = document.createElement("div");
      const b = document.createElement("b"); b.textContent = item.name;
      const dose = document.createElement("small"); const restNote = item.type === "hold" && item.reps > 1 ? `每次间休息 ${item.rest} 秒` : item.type === "rounds" && item.rounds > 1 ? `每轮之间休息 ${item.roundRest} 秒` : ""; dose.textContent = `${Core.itemDose(item)}${restNote ? `，${restNote}` : ""}`;
      text.append(b, dose);
      if (item.equipment) { const extra = document.createElement("small"); extra.textContent = `器材：${item.equipment}`; text.append(extra); }
      li.append(text);
      return li;
    }));
    const progress = restoreSession(ui.plan);
    let message = "";
    if (progress) message = `这套计划上次练到${progress.state === "between" ? `第 ${progress.item + 1} 项开始前` : Core.describePlace(ui.plan, progress.item, progress.at, progress.config)}。从这里开始会从头练，那次进度会被放弃。`;
    const voice = voiceStatus();
    message = [message, voice.message].filter(Boolean).join("\n");
    note($("prepNotice"), message);
    renderVoiceAction("prepVoiceAction", voice.action);
    const ready = !ui.prepSettling && trackReady(prepTrack());
    if (!ui.prepSettling) trackReady(Core.testTrack());
    const start = $("prepStart");
    start.disabled = !ready;
    start.classList.toggle("confirm", ui.prepConfirm);
    setText(start, !ready ? "正在准备声音…" : ui.prepConfirm ? "确认从头开始" : "开始训练");
    $("prepTest").disabled = ui.prepSettling || audioMode() !== "media" || !trackReady(Core.testTrack());
  }
  function startNew() {
    if (locked()) return;
    const progress = restoreSession(ui.plan);
    if (progress && !ui.prepConfirm) { ui.prepConfirm = true; renderPrep(); return; }
    if (ui.session) { save(true); ui.session = null; }
    const session = new Core.Session({ plan: ui.plan, config: configFor(ui.plan), id: uuid() });
    ui.session = session;
    if (!beginPrimary(session.pendingTrack())) { ui.session = null; renderPrep(); return; }
    ui.elapsedStart = Date.now(); ui.elapsedMs = null; ui.prepConfirm = false; lockTaps();
  }

  // ---------- running ----------
  const els = {};
  function dots(el, total, done, current) {
    const key = `${total}:${done}:${current}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.replaceChildren(...Array.from({ length: total }, (_, i) => { const d = document.createElement("i"); if (i < done) d.className = "d"; else if (i === current) d.className = "c"; return d; }));
  }
  // One row of dots per set (or a single row of rounds); rows other than the active one are dimmed.
  function dotStack(el, rows, active) {
    const key = JSON.stringify([rows, active]);
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.replaceChildren(...rows.map(([total, done, current], row) => {
      const line = document.createElement("div");
      line.className = row === active ? "dots" : "dots dim";
      line.replaceChildren(...Array.from({ length: total }, (_, i) => { const d = document.createElement("i"); if (i < done) d.className = "d"; else if (i === current) d.className = "c"; return d; }));
      return line;
    }));
  }
  function phaseFor(segment, item) {
    switch (segment.kind) {
      case "prep": return ["准备", `第 1 项 · ${item.short}`];
      case "settle": return ["就位", `${item.short} · 准备好器材`];
      case "work": return ["用力保持", `第 ${segment.set} 组 · 第 ${segment.rep} 次`];
      case "rest": return ["放松", `下一次：第 ${segment.rep + 1} 次`];
      case "group-rest": return ["组间休息", `第 ${segment.set} 组完成 · 接下来第 ${segment.set + 1} 组`];
      case "tiptoe": return ["踮脚", `第 ${segment.round} 轮 · 共 ${item.rounds} 轮`];
      case "stretch": return ["拉伸", `第 ${segment.round} 轮 · 共 ${item.rounds} 轮`];
      case "round-rest": return ["轮间休息", `第 ${segment.round} 轮完成 · 接下来第 ${segment.round + 1} 轮`];
      case "stage-rest": return ["节间休息", "这一项完成，休息后换下一项"];
      default: return ["", ""];
    }
  }
  function renderRun(t) {
    const s = ui.session;
    if (!s || s.state !== "running") return;
    const item = s.current, place = s.where(t);
    setText($("runPlace"), `${s.item + 1} / ${s.items.length} · ${item.short}`);
    setArt($("runArt"), $("runImg"), item);
    const segment = place.segment;
    if (!segment) return;
    let phase, sub, waterClass, fraction;
    if (place.phase === "lead") {
      phase = s.track.mode === "resume" ? "准备继续" : "准备";
      sub = phaseFor(segment, item)[1];
      waterClass = "water lead"; fraction = place.remaining / s.track.lead;
    } else {
      [phase, sub] = phaseFor(segment, item);
      const resting = ["rest", "group-rest", "round-rest", "stage-rest", "prep", "settle"].includes(segment.kind);
      waterClass = segment.kind === "prep" || segment.kind === "settle" ? "water lead" : resting ? "water rest" : "water";
      fraction = place.remaining / segment.seconds;
    }
    setText($("runPhase"), phase);
    setText($("runSub"), sub);
    const count = $("runCount");
    const text = clockText(place.remaining);
    setText(count, text);
    count.classList.toggle("clock", text.includes(":"));
    const water = $("water");
    if (water.className !== waterClass) water.className = waterClass;
    water.style.height = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    if (item.type === "hold") {
      const set = segment.set || 1, rep = segment.rep || 0;
      const inRest = place.phase === "segment" && segment.kind !== "work";
      const doneCount = segment.kind === "work" && place.phase === "segment" ? rep - 1 : segment.kind === "group-rest" ? item.reps : inRest ? rep : Math.max(0, rep - 1);
      const current = segment.kind === "group-rest" ? -1 : segment.kind === "work" ? rep - 1 : rep;
      dotStack($("runDots"), Array.from({ length: item.sets }, (_, i) => i + 1 < set ? [item.reps, item.reps, -1] : i + 1 === set ? [item.reps, doneCount, current] : [item.reps, 0, -1]), set - 1);
    } else if (item.type === "rounds") {
      const round = segment.round || 0;
      dotStack($("runDots"), [[item.rounds, segment.kind === "round-rest" ? round : Math.max(0, round - 1), segment.kind === "round-rest" ? -1 : round - 1]], 0);
    }
    // Skip only where the plan allows it, and only once the skip track can play from this tap.
    const canSkip = place.phase === "segment" && s.canSkip(t);
    let skipTrack = null;
    if (canSkip) skipTrack = Core.buildTrack(s.compiled(), Core.skipTarget(s.compiled(), place.itemTime), "skip");
    const skipReady = canSkip && trackReady(skipTrack);
    const skip = $("runSkip");
    show(skip, skipReady);
    if (skipReady) setText(skip, { prep: "跳过准备", settle: "立即开始", "group-rest": "跳过休息", "round-rest": "跳过休息" }[segment.kind]);
    // Pause resumes from this segment's start; render that track ahead of the tap.
    if (place.phase === "segment") {
      const key = `${s.item}:${segment.start}`;
      if (ui.lastSegmentKey !== key) { ui.lastSegmentKey = key; trackReady(Core.buildTrack(s.compiled(), Core.resumePoint(s.compiled(), segment.start + 0.001), "resume")); }
    }
  }
  function pauseNow() {
    const s = ui.session;
    if (!s || s.state !== "running") return;
    const t = clockTime();
    stopClock();
    s.pause(t);
    ui.holdNotice = ""; save(true); lockTaps(); go("hold");
  }
  function skipNow() {
    const s = ui.session;
    if (!s || s.state !== "running" || locked()) return;
    const t = clockTime();
    if (!s.canSkip(t)) return;
    const target = Core.buildTrack(s.compiled(), Core.skipTarget(s.compiled(), s.where(t).itemTime), "skip");
    if (!trackReady(target)) return;
    stopClock();
    s.skip(t);
    startClock(s.track);
    lockTaps(); save(true); renderRun(0);
  }

  // ---------- paused / manual ----------
  function renderHold() {
    const s = ui.session;
    if (!s) { go("home"); return; }
    const item = s.current;
    setText($("holdPlace"), `${s.item + 1} / ${s.items.length} · ${item.short}`);
    const primary = $("holdPrimary"), secondary = $("holdSecondary");
    show($("holdCount"), false); show($("holdDots"), false);
    note($("holdNotice"), ui.holdNotice);
    if (s.state === "paused") {
      show($("holdMark"), true); show($("holdArt"), false); show($("holdImg"), false);
      setText($("holdPhase"), "已暂停");
      const segment = Core.segmentAt(s.compiled(), s.at);
      setText($("holdSub"), segment ? `${Core.describePlace(s.plan, s.item, s.at, s.config)}${segment.rep ? ` · 第 ${segment.rep} 次` : ""}` : "");
      setText($("holdNote"), segment && Core.WORK_KINDS.has(segment.kind) ? "继续时，这一次从头开始，先倒数 4 秒。" : "继续时，从暂停的地方接着计时。");
      const ready = trackReady(s.pendingTrack());
      primary.disabled = !ready;
      setText(primary, ready ? "继续" : "正在准备声音…");
      show(secondary, true); setText(secondary, ui.offerSilent ? "静音继续" : "结束训练");
      return;
    }
    show($("holdMark"), false); setArt($("holdArt"), $("holdImg"), item);
    if (s.state === "manual") {
      setText($("holdPhase"), `第 ${s.set} 组`);
      show($("holdCount"), true); setText($("holdCount"), item.reps);
      setText($("holdSub"), "次 · 不计时，做完点下面");
      setText($("holdNote"), item.name);
      show($("holdDots"), true); dots($("holdDots"), item.sets, s.set - 1, s.set - 1);
      primary.disabled = false; setText(primary, `完成第 ${s.set} 组`);
      show(secondary, false);
      if (s.set === item.sets) trackReady(Core.finishTrack());
    } else if (s.state === "manual-ready") {
      setText($("holdPhase"), `第 ${s.set - 1} 组完成`);
      setText($("holdSub"), `歇一下，准备好后开始第 ${s.set} 组`);
      setText($("holdNote"), item.name);
      show($("holdDots"), true); dots($("holdDots"), item.sets, s.set - 1, -1);
      const ready = trackReady(s.pendingTrack());
      primary.disabled = !ready; setText(primary, ready ? `开始第 ${s.set} 组` : "正在准备声音…");
      show(secondary, false);
    }
  }
  function holdPrimary() {
    const s = ui.session;
    if (!s || locked()) return;
    if (s.state === "paused" || s.state === "manual-ready") { if (beginPrimary(s.pendingTrack())) lockTaps(); return; }
    if (s.state === "manual") {
      const result = s.completeManualSet(new Date());
      lockTaps();
      if (result === "finished") { playOnce(Core.finishTrack()); finishSession(); return; }
      save(true); refresh();
    }
  }
  function holdSecondary() {
    if (ui.offerSilent) { ui.forceSilent = true; ui.offerSilent = false; ui.holdNotice = "这次改为静音计时。"; refresh(); return; }
    openSheet();
  }

  // ---------- between items ----------
  function renderBetween() {
    const s = ui.session;
    if (!s) { go("home"); return; }
    const item = s.current;
    setText($("betweenPlace"), `${s.item + 1} / ${s.items.length}`);
    setText($("betweenDone").querySelector("span"), `第 ${s.item} 项完成`);
    setArt($("betweenArt"), $("betweenImg"), item);
    $("betweenBox").classList.toggle("photo", Boolean(item.image));
    setText($("betweenName"), item.name);
    $("betweenChips").replaceChildren(...[...item.tools.map(t => ["chip tool", t]), ["chip", Core.itemDose(item)]].map(([cls, text]) => { const c = document.createElement("span"); c.className = cls; c.textContent = text; return c; }));
    setText($("betweenRest"), [item.equipment && item.equipment !== item.tools[0] ? `器材：${item.equipment}` : "", Core.itemRestNote(item, s.config)].filter(Boolean).join(" · "));
    setText($("betweenHint"), item.type === "manual" ? "不计时，做完一组点一次完成" : `点击后有 ${Core.SETTLE_SECONDS} 秒就位倒数`);
    const ready = trackReady(s.pendingTrack());
    const start = $("betweenStart");
    start.disabled = !ready; setText(start, ready ? "准备好了，开始" : "正在准备声音…");
    const voice = voiceStatus();
    note($("betweenNotice"), voice.message);
    renderVoiceAction("betweenVoiceAction", voice.action);
  }

  // ---------- done ----------
  function renderDone() {
    const record = ui.lastCompletion;
    if (!record) { go("home"); return; }
    const elapsed = ui.elapsedMs;
    const time = elapsed ? ` · 用时 ${Math.floor(elapsed / 60000)} 分 ${Math.floor(elapsed % 60000 / 1000)} 秒` : "";
    setText($("doneMeta"), `${planName(record.program)}${time}`);
    const count = weekStrip($("doneWeek"));
    setText($("doneCount"), `本周第 ${count} 次`);
  }

  // ---------- records ----------
  function renderRecords() {
    const now = today();
    if (!ui.month) ui.month = { y: now.getFullYear(), m: now.getMonth() };
    if (!ui.selected) ui.selected = todayKey();
    const { y, m } = ui.month;
    setText($("monthTitle"), `${y} 年 ${m + 1} 月`);
    const isCurrent = y === now.getFullYear() && m === now.getMonth();
    $("nextMonth").disabled = isCurrent;
    const records = store.list();
    const byDate = new Map();
    for (const r of records) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
    const cells = Core.monthCells(y, m, now);
    const grid = $("calendar");
    const nodes = "一二三四五六日".split("").map(d => { const w = document.createElement("span"); w.className = "wd"; w.textContent = d; return w; });
    for (const cell of cells) {
      if (!cell) { nodes.push(document.createElement("span")); continue; }
      const day = button(String(cell.day), "", () => { ui.selected = cell.date; ui.revokeArmed = null; ui.manualArmed = null; ui.manualOpen = false; renderRecords(); });
      const list = byDate.get(cell.date) || [];
      const marks = document.createElement("u");
      if (list.some(r => r.program === Core.PLAN_A)) { const i = document.createElement("i"); i.className = "dot-a"; marks.append(i); }
      if (list.some(r => r.program === Core.PLAN_B)) { const i = document.createElement("i"); i.className = "dot-b"; marks.append(i); }
      day.append(marks);
      if (cell.today) day.classList.add("today");
      if (cell.date === ui.selected) { day.classList.add("selected"); day.setAttribute("aria-pressed", "true"); }
      day.disabled = cell.future;
      day.setAttribute("aria-label", `${dateLabel(cell.date)}${list.length ? `，${list.length} 次记录` : ""}`);
      nodes.push(day);
    }
    grid.replaceChildren(...nodes);
    const week = Core.weekDates(now);
    const countA = records.filter(r => r.program === Core.PLAN_A && week.includes(r.date)).length;
    const countB = records.filter(r => r.program === Core.PLAN_B && week.includes(r.date)).length;
    setText($("weekSummary"), `本周 左腿抗阻 ${countA} 次（建议每周 3–4 次）· 双腿关节 ${countB} 次`);
    renderDay(byDate.get(ui.selected) || []);
  }
  function renderDay(list) {
    setText($("dayTitle"), dateLabel(ui.selected));
    const items = list.map(record => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      const time = record.finishedAt ? new Date(record.finishedAt) : null;
      text.textContent = `${planName(record.program)} · ${record.source === "manual" ? "补记" : time ? `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")} 完成` : "完成"}`;
      const armed = ui.revokeArmed === record.id;
      const revoke = button(armed ? "确认撤销" : "撤销", `text-button${armed ? " confirm" : ""}`, () => {
        if (ui.revokeArmed !== record.id) { ui.revokeArmed = record.id; setText($("dayMessage"), "只撤销这一条，其他记录保留。"); renderRecords(); return; }
        store.revoke(record.program, record.id); ui.revokeArmed = null; setText($("dayMessage"), "已撤销。"); renderRecords();
      });
      li.append(text, revoke);
      return li;
    });
    if (!items.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "这一天没有记录。"; items.push(li); }
    $("dayList").replaceChildren(...items);
    const add = $("manualAdd");
    if (ui.selected > todayKey()) { add.replaceChildren(); return; }
    if (!ui.manualOpen) { add.replaceChildren(button("补记一次完成", "link-button", () => { ui.manualOpen = true; renderRecords(); })); return; }
    add.replaceChildren(...Core.PLAN_IDS.map(planId => {
      const armed = ui.manualArmed === planId;
      return button(armed ? `确认补记${planName(planId)}` : planName(planId), `chip-button${armed ? " confirm" : ""}`, () => {
        if (ui.manualArmed !== planId) { ui.manualArmed = planId; setText($("dayMessage"), `为 ${dateLabel(ui.selected)} 补记一次${planName(planId)}，再点一次确认。`); renderRecords(); return; }
        store.addManual(planId, ui.selected, todayKey()); ui.manualArmed = null; ui.manualOpen = false; setText($("dayMessage"), "已补记。"); renderRecords();
      });
    }));
  }

  // ---------- sheet & sound ----------
  function openSheet() {
    const s = ui.session;
    if (s?.state === "running") pauseNow();
    ui.sheetFrom = ui.screen;
    show($("endSheet"), true);
    requestAnimationFrame(() => $("endKeepTraining").focus());
  }
  function closeSheet() { show($("endSheet"), false); }
  function syncSoundButtons() {
    const on = store.prefs().sound;
    for (const id of ["runSound", "holdSound", "betweenSound"]) {
      const el = $(id);
      el.setAttribute("aria-pressed", String(on));
      el.setAttribute("aria-label", on ? "声音已开，点按静音" : "已静音，点按打开声音");
      const use = el.querySelector("use"), ref = on ? "#i-sound" : "#i-mute";
      if (use.getAttribute("href") !== ref) use.setAttribute("href", ref);
    }
    const prep = $("prepSound");
    prep.setAttribute("aria-pressed", String(on)); setText(prep, on ? "声音：开" : "声音：关");
  }
  function toggleSound() {
    const on = !store.prefs().sound;
    store.setPrefs({ sound: on });
    media.muted = !on;
    syncSoundButtons();
  }
  function testSound() {
    const track = Core.testTrack();
    if (!trackReady(track) || audioMode() !== "media") return;
    playOnce(track);
    note($("prepNotice"), "正在播放声音测试。听不清就调大音量，并检查静音开关。");
  }

  // ---------- events ----------
  function on(id, handler) { $(id).addEventListener("click", handler); }
  on("tabTrain", () => go("home"));
  on("tabRecords", () => { ui.month = null; ui.selected = null; ui.manualOpen = false; go("records"); });
  on("prepBack", () => go("home"));
  on("prepStart", startNew);
  on("paramsReset", () => { store.setPlanSettings(ui.plan, {}); ui.prepConfirm = false; settlePrep(); refresh(); });
  on("prepSound", toggleSound);
  on("prepTest", testSound);
  on("runPause", () => { if (!locked()) pauseNow(); });
  on("runSkip", skipNow);
  on("runExit", openSheet);
  on("runSound", toggleSound);
  on("holdSound", toggleSound);
  on("betweenSound", toggleSound);
  on("holdPrimary", holdPrimary);
  on("holdSecondary", holdSecondary);
  on("holdExit", openSheet);
  on("betweenExit", openSheet);
  on("betweenStart", () => { const s = ui.session; if (s && !locked() && beginPrimary(s.pendingTrack())) lockTaps(); });
  on("doneOk", () => { ui.lastCompletion = null; go("home"); });
  on("prevMonth", () => { const d = new Date(ui.month.y, ui.month.m - 1, 1); ui.month = { y: d.getFullYear(), m: d.getMonth() }; renderRecords(); });
  on("nextMonth", () => { const d = new Date(ui.month.y, ui.month.m + 1, 1); ui.month = { y: d.getFullYear(), m: d.getMonth() }; renderRecords(); });
  on("endKeepTraining", () => { closeSheet(); refresh(); });
  on("endLater", () => endSession(true));
  on("endConfirm", () => endSession(false));
  $("endSheet").addEventListener("click", event => { if (event.target === $("endSheet")) closeSheet(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("endSheet").hidden) closeSheet(); });

  media.addEventListener("pause", () => {
    if (ui.expectingPause || media.ended) return;
    if (ui.session?.state === "running" && ui.clock.kind === "media") interrupt("播放被系统打断，已暂停。点继续，这一次从头开始。");
  });
  media.addEventListener("ended", () => { if (ui.session?.state === "running" && ui.clock.kind === "media") tick(); });
  media.addEventListener("error", () => { if (ui.session?.state === "running" && ui.clock.kind === "media") interrupt("声音播放出错，已暂停。", true); });
  document.addEventListener("visibilitychange", () => {
    const s = ui.session;
    if (document.hidden) {
      // Without a playing track, background timers are unreliable: pause instead of guessing.
      if (s?.state === "running" && ui.clock.kind === "wall") interrupt("离开页面时已暂停。");
      save(true);
      return;
    }
    if (s?.state === "running") {
      if (ui.clock.kind === "media" && media.paused && !media.ended) { interrupt("播放被系统打断，已暂停。点继续，这一次从头开始。"); return; }
      ui.lastProgressAt = performance.now(); requestWakeLock(); tick();
    }
    store.refresh().then(() => store.flush());
  });
  addEventListener("pagehide", () => save(true));
  addEventListener("online", () => store.flush());
  store.onChange(() => { if (["home", "records", "done", "prep"].includes(ui.screen)) refresh(); });

  // ---------- boot ----------
  if (isolated) {
    const parts = ["测试模式 · 只存本机"];
    if (debugMs) parts.push(`${debugMs}ms/秒 · 静音`);
    else if (fileMode) parts.push("本地文件");
    setText($("testBadge"), parts.join(" · ")); show($("testBadge"), true);
  }
  if (!debugMs) {
    loadVoice();
  }
  store.init().catch(() => {});
  go("home");

  Object.defineProperty(globalThis, "__rehabTimer", {
    value: Object.freeze({
      config: Object.freeze({ debugMs, testMode, fileMode, isolated, unit, storage: store.ns }),
      state: () => ({ screen: ui.screen, voice: ui.voice, audio: audioMode(), session: ui.session ? { state: ui.session.state, item: ui.session.item, at: ui.session.at, set: ui.session.set, plan: ui.session.plan } : null, pending: store.pending(), clock: ui.clock.kind, mediaTime: media.currentTime, tracks: ui.tracks.size }),
      // Isolated preview only: file:// cannot fetch the sprite, so a test can hand it over.
      loadVoice: isolated && !debugMs ? async data => { await Sound.loadBuffer(data); ui.voice = "ready"; ui.forceSilent = false; refresh(); return true; } : undefined
    })
  });
})();
