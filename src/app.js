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
  const VOICE_URL = `audio/voice.wav?v=${globalThis.RehabVoice?.version || "0"}`;
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
    voice: debugMs ? "off" : "loading", forceSilent: debugMs > 0,
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
  const planName = id => Core.PLANS[id].name;
  const today = () => new Date();
  const todayKey = () => Core.localDate(today());
  const dateLabel = key => { const [y, m, d] = key.split("-").map(Number); const date = new Date(y, m - 1, d, 12); return `${m} 月 ${d} 日 周${WEEKDAYS[date.getDay()]}`; };
  const clockText = seconds => seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : String(Math.max(1, Math.ceil(seconds - 1e-6)));
  const minutes = planId => Math.round(Core.doseSeconds(planId, store.prefs().groupRest) / 60);
  const locked = () => performance.now() < ui.lockUntil;
  const lockTaps = () => { ui.lockUntil = performance.now() + 700; };
  function note(el, message) { setText(el, message || ""); show(el, Boolean(message)); }

  // ---------- audio tracks ----------
  const audioMode = () => (!ui.forceSilent && ui.voice === "ready" && Sound.supported()) ? "media" : "wall";
  const trackKey = track => `${track.mode}:${track.plan}:${track.index}:${track.start}:${track.duration.toFixed(3)}`;
  function prepare(track) {
    if (!track || audioMode() !== "media") return null;
    const key = trackKey(track);
    let entry = ui.tracks.get(key);
    if (!entry) {
      entry = { key, result: null, failed: false };
      entry.promise = Sound.render(track, clips).then(result => { entry.result = result; refresh(); return result; }).catch(() => { entry.failed = true; refresh(); });
      ui.tracks.set(key, entry);
      while (ui.tracks.size > 6) {
        const [oldKey, old] = ui.tracks.entries().next().value;
        if (old.result?.url === ui.playingUrl) { ui.tracks.delete(oldKey); ui.tracks.set(oldKey, old); break; }
        if (old.result) URL.revokeObjectURL(old.result.url);
        ui.tracks.delete(oldKey);
      }
    }
    return entry;
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
    const keys = Core.weekDates(today()), done = new Set(store.list().map(r => r.date)), now = todayKey();
    el.replaceChildren(...keys.map((key, i) => {
      const cell = document.createElement("span");
      const dot = document.createElement("i");
      if (done.has(key)) dot.classList.add("on");
      if (key === now) dot.classList.add("today");
      cell.append("一二三四五六日"[i], dot);
      cell.setAttribute("aria-label", `${dateLabel(key)}${done.has(key) ? " 已练" : ""}`);
      return cell;
    }));
    return store.list().filter(r => keys.includes(r.date)).length;
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
    for (const item of plan.items) pics.insertAdjacentHTML("beforeend", `<span><svg><use href="#art-${item.art}"/></svg></span>`);
    const foot = document.createElement("div"); foot.className = "card-foot";
    const actions = document.createElement("div"); actions.className = "card-actions";
    if (session) {
      const line = document.createElement("p"); line.className = "resume-line";
      line.append("上次练到 ");
      const b = document.createElement("b"); b.textContent = session.state === "between" ? `第 ${session.item + 1} 项开始前` : Core.describePlace(planId, session.item, session.at, session.groupRest);
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
  function prepTrack() { return Core.buildTrack(Core.compile(ui.plan, 0, store.prefs().groupRest), 0, "start"); }
  function renderPrep() {
    const plan = Core.PLANS[ui.plan], prefs = store.prefs();
    setText($("prepTitle"), plan.name);
    setText($("prepMeta"), `${plan.items.length} 项 · 约 ${minutes(ui.plan)} 分钟${plan.items.some(i => i.type === "manual") ? "，另有 1 项不计时" : ""}`);
    const tools = [...new Set(plan.items.flatMap(item => item.tools))];
    $("prepTools").replaceChildren(...(tools.length ? tools : ["不需要额外器材"]).map(text => { const c = document.createElement("span"); c.className = tools.length ? "chip tool" : "chip"; c.textContent = text; return c; }));
    $("prepItems").replaceChildren(...plan.items.map(item => {
      const li = document.createElement("li");
      li.insertAdjacentHTML("beforeend", `<svg aria-hidden="true"><use href="#art-${item.art}"/></svg>`);
      const text = document.createElement("div");
      const b = document.createElement("b"); b.textContent = item.name;
      const dose = document.createElement("small"); dose.textContent = `${Core.itemDose(item)}${item.type === "hold" ? `，每次间休息 ${item.rest} 秒` : item.type === "rounds" ? `，前三轮后各休息 ${item.roundRest} 秒` : ""}`;
      text.append(b, dose);
      if (item.equipment) { const extra = document.createElement("small"); extra.textContent = `器材：${item.equipment}`; text.append(extra); }
      li.append(text);
      return li;
    }));
    $("restOptions").replaceChildren(...Core.GROUP_REST_OPTIONS.map(seconds => {
      const el = button(Core.GROUP_REST_LABELS[seconds], "", () => { store.setPrefs({ groupRest: seconds }); refresh(); });
      el.setAttribute("role", "radio"); el.setAttribute("aria-checked", String(prefs.groupRest === seconds));
      return el;
    }));
    const progress = restoreSession(ui.plan);
    let message = "";
    if (progress) message = `这套计划上次练到${progress.state === "between" ? `第 ${progress.item + 1} 项开始前` : Core.describePlace(ui.plan, progress.item, progress.at, progress.groupRest)}。从这里开始会从头练，那次进度会被放弃。`;
    if (ui.voice === "off" && !debugMs) message = [message, "声音没有加载成功，这次会静音计时。"].filter(Boolean).join("\n");
    note($("prepNotice"), message);
    const ready = trackReady(prepTrack());
    trackReady(Core.testTrack());
    const start = $("prepStart");
    start.disabled = !ready;
    start.classList.toggle("confirm", ui.prepConfirm);
    setText(start, !ready ? "正在准备声音…" : ui.prepConfirm ? "确认从头开始" : "开始训练");
    $("prepTest").disabled = audioMode() !== "media" || !trackReady(Core.testTrack());
  }
  function startNew() {
    if (locked()) return;
    const progress = restoreSession(ui.plan);
    if (progress && !ui.prepConfirm) { ui.prepConfirm = true; renderPrep(); return; }
    if (ui.session) { save(true); ui.session = null; }
    const session = new Core.Session({ plan: ui.plan, groupRest: store.prefs().groupRest, id: uuid() });
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
    useArt($("runArt"), item.art);
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
      dots($("runDots"), item.reps, set === 1 ? doneCount : item.reps, set === 1 ? current : -1);
      dots($("runDots2"), item.reps, set === 2 ? doneCount : 0, set === 2 ? current : -1);
    } else if (item.type === "rounds") {
      const round = segment.round || 0;
      dots($("runDots"), item.rounds, segment.kind === "round-rest" ? round : Math.max(0, round - 1), segment.kind === "round-rest" ? -1 : round - 1);
      $("runDots2").replaceChildren(); $("runDots2").dataset.key = "";
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
      show($("holdMark"), true); show($("holdArt"), false);
      setText($("holdPhase"), "已暂停");
      const segment = Core.segmentAt(s.compiled(), s.at);
      setText($("holdSub"), segment ? `${Core.describePlace(s.plan, s.item, s.at, s.groupRest)}${segment.rep ? ` · 第 ${segment.rep} 次` : ""}` : "");
      setText($("holdNote"), segment && Core.WORK_KINDS.has(segment.kind) ? "继续时，这一次从头开始，先倒数 4 秒。" : "继续时，从暂停的地方接着计时。");
      const ready = trackReady(s.pendingTrack());
      primary.disabled = !ready;
      setText(primary, ready ? "继续" : "正在准备声音…");
      show(secondary, true); setText(secondary, ui.offerSilent ? "静音继续" : "结束训练");
      return;
    }
    show($("holdMark"), false); show($("holdArt"), true); useArt($("holdArt"), item.art);
    if (s.state === "manual") {
      setText($("holdPhase"), `第 ${s.set} 组`);
      show($("holdCount"), true); setText($("holdCount"), item.reps);
      setText($("holdSub"), "次 · 不计时，做完点下面");
      setText($("holdNote"), item.name);
      show($("holdDots"), true); dots($("holdDots"), item.sets, s.set - 1, s.set - 1);
      primary.disabled = false; setText(primary, `完成第 ${s.set} 组`);
      show(secondary, false);
      if (s.set === 2) trackReady(Core.finishTrack());
    } else if (s.state === "manual-ready") {
      setText($("holdPhase"), "第 1 组完成");
      setText($("holdSub"), "歇一下，准备好后开始第 2 组");
      setText($("holdNote"), item.name);
      show($("holdDots"), true); dots($("holdDots"), item.sets, 1, -1);
      const ready = trackReady(s.pendingTrack());
      primary.disabled = !ready; setText(primary, ready ? "开始第 2 组" : "正在准备声音…");
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
    useArt($("betweenArt"), item.art);
    setText($("betweenName"), item.name);
    $("betweenChips").replaceChildren(...[...item.tools.map(t => ["chip tool", t]), ["chip", Core.itemDose(item)]].map(([cls, text]) => { const c = document.createElement("span"); c.className = cls; c.textContent = text; return c; }));
    setText($("betweenRest"), [item.equipment && item.equipment !== item.tools[0] ? `器材：${item.equipment}` : "", Core.itemRestNote(item, s.groupRest)].filter(Boolean).join(" · "));
    setText($("betweenHint"), item.type === "manual" ? "不计时，做完一组点一次完成" : `点击后有 ${Core.SETTLE_SECONDS} 秒就位倒数`);
    const ready = trackReady(s.pendingTrack());
    const start = $("betweenStart");
    start.disabled = !ready; setText(start, ready ? "准备好了，开始" : "正在准备声音…");
    note($("betweenNotice"), ui.voice === "off" && !debugMs ? "声音没有加载成功，这次会静音计时。" : "");
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
    if (!Sound.supported()) ui.voice = "off";
    else Sound.load(VOICE_URL).then(() => { ui.voice = "ready"; refresh(); }).catch(() => { ui.voice = "off"; refresh(); });
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
