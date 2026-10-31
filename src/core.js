/* Pure domain code: fixed plans, timeline compiler, voice-cue schedule and session state.
   No DOM, no audio, no storage. Tests execute this exact script. */
globalThis.RehabCore = (() => {
  "use strict";
  const PLAN_A = "five-stage-v1";
  const PLAN_B = "lower-limb-joints-v1";
  const GROUP_REST_OPTIONS = Object.freeze([60, 90, 120, 150]);
  const GROUP_REST_LABELS = Object.freeze({ 60: "60 秒", 90: "1 分半", 120: "2 分钟", 150: "2 分半" });
  const PREP_SECONDS = 30;     // first item only, skippable, part of the planned total
  const SETTLE_SECONDS = 10;   // after tapping "开始" on items 2-5, skippable, not part of the dose
  const COUNT_IN = 4;          // lead-in before a resumed or skipped-to work segment
  const RESUME_LEAD = 1.2;     // lead-in before a resumed rest
  const TONE_GAP = 0.5;        // voice after a boundary tone
  const CHIME_GAP = 0.75;
  const WORK_KINDS = Object.freeze(new Set(["work", "tiptoe", "stretch"]));
  const SKIPPABLE_KINDS = Object.freeze(new Set(["prep", "settle", "group-rest", "round-rest"]));

  const freeze = value => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  };
  const hold = extra => ({ type: "hold", hold: 15, reps: 6, sets: 2, ...extra });

  // Training facts are authoritative in PRODUCT.md. Names, equipment and doses must not drift.
  const PLANS = freeze({
    [PLAN_A]: {
      id: PLAN_A, letter: "a", name: "左腿抗阻训练", formerName: "原计划", stageRest: 0,
      items: [
        hold({ name: "俯卧左大腿屈膝后伸抗阻静力训练", short: "大腿后伸", equipment: "1 kg", tools: ["1 kg 负重"], art: "hipext", rest: 5 }),
        hold({ name: "左侧直抬腿", short: "直抬腿", equipment: "1 kg", tools: ["1 kg 负重"], art: "slr", rest: 5 }),
        hold({ name: "左髋内收抗阻静力训练", short: "髋内收", equipment: "弹力带 15 磅", tools: ["15 磅弹力带"], art: "hipadd", rest: 5 }),
        hold({ name: "左踝内翻训练", short: "踝内翻", equipment: "弹力带 15 磅", tools: ["15 磅弹力带"], art: "ankle", rest: 5 }),
        { type: "rounds", name: "左小腿踮脚静力训练 → 左小腿拉伸", short: "踮脚/拉伸", equipment: "", tools: [], art: "calf", rounds: 4, work: 30, stretch: 30, roundRest: 30 }
      ]
    },
    [PLAN_B]: {
      id: PLAN_B, letter: "b", name: "双腿关节训练", formerName: "下肢关节居家训练", stageRest: 60,
      items: [
        hold({ name: "双侧屈膝抗阻静力训练", short: "屈膝抗阻", equipment: "弹力带 10 到 15 磅", tools: ["弹力带 10–15 磅"], art: "kneeres", rest: 7 }),
        hold({ name: "双侧屈膝屈髋维持训练", short: "屈膝屈髋", equipment: "", tools: [], art: "table", rest: 7 }),
        hold({ name: "双髋外展抗阻静力训练", short: "髋外展", equipment: "20 磅弹力环", tools: ["20 磅弹力环"], art: "abd", rest: 7 }),
        hold({ name: "双髋内收抗阻静力训练", short: "髋内收", equipment: "仰卧内收腿夹球，球径 20 到 25 厘米", tools: ["夹球 20–25 厘米"], art: "ball", rest: 7 }),
        { type: "manual", name: "双侧抬腿跨障碍", short: "抬腿跨障碍", equipment: "", tools: [], art: "step", sets: 2, reps: "8–10" }
      ]
    }
  });
  const PLAN_IDS = Object.freeze([PLAN_A, PLAN_B]);

  // Every spoken cue. scripts/generate-voice.mjs renders these texts into audio/voice.wav.
  const VOICE_TEXT = freeze({
    start: "开始", relax: "放松", n3: "三", n2: "二", n1: "一",
    "rep-2": "第二次", "rep-3": "第三次", "rep-4": "第四次", "rep-5": "第五次", "rep-6": "第六次",
    "set-1": "第一组", "set-2": "第二组",
    "round-1": "第一轮", "round-2": "第二轮", "round-3": "第三轮", "round-4": "第四轮",
    prepare: "准备",
    "in10-set-1": "十秒后开始第一组", "in10-set-2": "十秒后开始第二组",
    "in10-round-2": "十秒后开始第二轮", "in10-round-3": "十秒后开始第三轮", "in10-round-4": "十秒后开始第四轮",
    "group-rest-60": "第一组完成，休息一分钟", "group-rest-90": "第一组完成，休息一分半",
    "group-rest-120": "第一组完成，休息两分钟", "group-rest-150": "第一组完成，休息两分半",
    "item-done": "这一项完成", "stage-rest": "这一节完成，休息一分钟", "stage-rest-end": "休息结束，准备下一项",
    tiptoe: "踮脚", stretch: "换拉伸", "round-rest": "这一轮完成，休息三十秒",
    resume: "继续",
    "manual-1": "第一组，做八到十次，做完点完成", "manual-2": "第二组，做八到十次，做完点完成",
    "all-done": "训练完成",
    test: "声音测试。能听清，就可以开始了。",
    "intro-a-0": "第一项，俯卧左大腿后伸。准备一公斤负重。",
    "intro-a-1": "第二项，左侧直抬腿。准备一公斤负重。",
    "intro-a-2": "第三项，左髋内收。准备十五磅弹力带。",
    "intro-a-3": "第四项，左踝内翻。准备十五磅弹力带。",
    "intro-a-4": "第五项，左小腿踮脚和拉伸。",
    "intro-b-0": "第一项，双侧屈膝抗阻。准备弹力带。",
    "intro-b-1": "第二项，双侧屈膝屈髋维持。",
    "intro-b-2": "第三项，双髋外展。准备二十磅弹力环。",
    "intro-b-3": "第四项，双髋内收，仰卧夹球。",
    "intro-b-4": "第五项，双侧抬腿跨障碍。"
  });
  const TONE_SECONDS = freeze({ rise: 0.42, fall: 0.46, tick: 0.06, chime: 0.72 });

  // Measured clip durations come from audio/voice.json, inlined by the build as RehabVoice.
  function voiceSeconds(key) {
    const clip = globalThis.RehabVoice?.clips?.[key];
    if (clip) return clip[1] / 1000;
    const text = VOICE_TEXT[key];
    if (text === undefined) throw new Error(`unknown voice cue: ${key}`);
    return 0.15 + [...text].reduce((sum, char) => sum + (/[，。、]/.test(char) ? 0.18 : 0.24), 0);
  }

  function planOf(id) {
    const plan = PLANS[id];
    if (!plan) throw new Error("unknown plan");
    return plan;
  }
  function checkRest(groupRest) {
    if (!GROUP_REST_OPTIONS.includes(groupRest)) throw new Error("invalid group rest");
    return groupRest;
  }

  const compiled = new Map();
  // Expand one item into absolute segments (item seconds from 0) and the cue events laid on them.
  function compile(planId, index, groupRest = 60) {
    const plan = planOf(planId);
    checkRest(groupRest);
    const item = plan.items[index];
    if (!item) throw new Error("unknown item");
    const cacheKey = `${planId}:${index}:${groupRest}:${globalThis.RehabVoice?.version || "est"}`;
    if (compiled.has(cacheKey)) return compiled.get(cacheKey);
    const isLast = index === plan.items.length - 1;
    if (item.type === "manual") {
      const result = freeze({ plan: planId, index, item, manual: true, segments: [], events: [], end: 0, duration: 0, isLast });
      compiled.set(cacheKey, result);
      return result;
    }
    const segments = [], events = [];
    let t = 0;
    const push = (kind, seconds, extra = {}) => {
      const segment = { kind, start: t, end: t + seconds, seconds, skippable: SKIPPABLE_KINDS.has(kind), dose: kind !== "settle", ...extra };
      segments.push(segment);
      t += seconds;
      return segment;
    };
    const voice = (at, key) => { voiceSeconds(key); events.push({ at, voice: key }); };
    const tone = (at, name) => events.push({ at, tone: name });
    const countdownTicks = end => { for (const s of [3, 2, 1]) tone(end - s, "tick"); };
    const countdownVoice = end => { voice(end - 3, "n3"); voice(end - 2, "n2"); voice(end - 1, "n1"); };
    const intro = `intro-${plan.letter}-${index}`;

    if (index === 0) {
      const prep = push("prep", PREP_SECONDS);
      voice(prep.start + 0.3, "prepare");
      voice(prep.start + 0.6 + voiceSeconds("prepare"), intro);
      voice(prep.end - 10, item.type === "rounds" ? "in10-round-1" : "in10-set-1");
      countdownTicks(prep.end);
    } else {
      const settle = push("settle", SETTLE_SECONDS);
      voice(settle.start + 0.3, intro);
      countdownTicks(settle.end);
    }

    if (item.type === "hold") {
      for (let set = 1; set <= item.sets; set++) {
        for (let rep = 1; rep <= item.reps; rep++) {
          const work = push("work", item.hold, { set, rep });
          tone(work.start, "rise");
          if (rep === 1) voice(work.start + TONE_GAP, "start");
          countdownVoice(work.end);
          if (rep < item.reps) {
            const rest = push("rest", item.rest, { set, rep });
            tone(rest.start, "fall");
            voice(rest.start + TONE_GAP, "relax");
            const next = `rep-${rep + 1}`;
            voice(rest.end - 1.4 - voiceSeconds(next), next);
            tone(rest.end - 1, "tick");
          } else if (set < item.sets) {
            const groupRestSegment = push("group-rest", groupRest, { set, rep });
            tone(groupRestSegment.start, "fall");
            voice(groupRestSegment.start + TONE_GAP, `group-rest-${groupRest}`);
            voice(groupRestSegment.end - 10, `in10-set-${set + 1}`);
            countdownTicks(groupRestSegment.end);
          }
        }
      }
    } else {
      for (let round = 1; round <= item.rounds; round++) {
        const tiptoe = push("tiptoe", item.work, { round });
        tone(tiptoe.start, "rise"); voice(tiptoe.start + TONE_GAP, "tiptoe"); countdownVoice(tiptoe.end);
        const stretch = push("stretch", item.stretch, { round });
        tone(stretch.start, "rise"); voice(stretch.start + TONE_GAP, "stretch"); countdownVoice(stretch.end);
        if (round < item.rounds) {
          const roundRest = push("round-rest", item.roundRest, { round });
          tone(roundRest.start, "fall"); voice(roundRest.start + TONE_GAP, "round-rest");
          voice(roundRest.end - 10, `in10-round-${round + 1}`);
          countdownTicks(roundRest.end);
        }
      }
    }

    let tail;
    if (isLast) {
      tone(t, "chime"); voice(t + CHIME_GAP, "all-done");
      tail = t + CHIME_GAP + voiceSeconds("all-done") + 0.6;
    } else if (plan.stageRest) {
      const stageRest = push("stage-rest", plan.stageRest);
      tone(stageRest.start, "fall"); voice(stageRest.start + TONE_GAP, "stage-rest");
      tone(stageRest.end, "chime"); voice(stageRest.end + CHIME_GAP, "stage-rest-end");
      tail = stageRest.end + CHIME_GAP + voiceSeconds("stage-rest-end") + 0.6;
    } else {
      tone(t, "chime"); voice(t + CHIME_GAP, "item-done");
      tail = t + CHIME_GAP + voiceSeconds("item-done") + 0.6;
    }
    events.sort((a, b) => a.at - b.at);
    const result = freeze({ plan: planId, index, item, manual: false, segments, events, end: t, duration: tail, isLast });
    compiled.set(cacheKey, result);
    return result;
  }

  function segmentIndexAt(item, time) {
    const { segments } = item;
    for (let i = 0; i < segments.length; i++) if (time < segments[i].end - 1e-9) return time >= segments[i].start - 1e-9 ? i : -1;
    return -1;
  }
  const segmentAt = (item, time) => item.segments[segmentIndexAt(item, time)] || null;

  // Interrupted holds restart from their beginning: never fewer seconds of work than planned.
  function resumePoint(item, time) {
    const segment = segmentAt(item, time);
    if (!segment) return Math.min(time, item.end);
    return WORK_KINDS.has(segment.kind) ? segment.start : time;
  }
  function skipTarget(item, time) {
    const index = segmentIndexAt(item, time);
    const segment = item.segments[index];
    if (!segment || !segment.skippable) return null;
    const next = item.segments[index + 1];
    return next && WORK_KINDS.has(next.kind) ? next.start : null;
  }
  const actionVoice = segment => segment.kind === "tiptoe" ? "tiptoe" : segment.kind === "stretch" ? "stretch" : "start";

  // A playable track: an optional lead-in, then the item's own cues from `start` onwards.
  function buildTrack(item, start = 0, mode = "start") {
    if (item.manual) throw new Error("manual items have no timed track");
    if (!(start >= 0 && start < item.end)) throw new Error("track start outside item");
    const segment = segmentAt(item, start);
    const pre = [];
    let lead = 0;
    if (mode === "resume" || mode === "skip") {
      const counted = WORK_KINDS.has(segment.kind);
      lead = counted ? COUNT_IN : RESUME_LEAD;
      if (mode === "skip" && !counted) throw new Error("skip must land on work");
      const announce = mode === "resume" ? "resume" : segment.kind === "tiptoe" ? `round-${segment.round}` : `set-${segment.set}`;
      pre.push({ at: 0.2, voice: announce });
      if (counted) for (const s of [3, 2, 1]) pre.push({ at: lead - s, tone: "tick" });
    } else if (start !== 0 || mode !== "start") throw new Error("invalid track mode");
    const events = [...pre, ...item.events.filter(event => event.at >= start - 1e-9).map(event => ({ ...event, at: event.at - start + lead }))];
    if (lead && WORK_KINDS.has(segment.kind) && Math.abs(segment.start - start) < 1e-9 &&
        !events.some(event => event.voice && event.at >= lead && event.at <= lead + 0.6)) {
      events.push({ at: lead + TONE_GAP, voice: actionVoice(segment) });
    }
    events.sort((a, b) => a.at - b.at);
    return freeze({ plan: item.plan, index: item.index, start, lead, mode, events, duration: item.duration - start + lead });
  }
  function manualTrack(planId, index, set, withIntro) {
    const plan = planOf(planId);
    const events = [];
    let at = 0.2;
    if (withIntro) { events.push({ at, voice: `intro-${plan.letter}-${index}` }); at += voiceSeconds(`intro-${plan.letter}-${index}`) + 0.35; }
    events.push({ at, voice: `manual-${set}` });
    at += voiceSeconds(`manual-${set}`) + 0.4;
    return freeze({ plan: planId, index, start: 0, lead: 0, mode: "manual", events, duration: at });
  }
  function finishTrack() {
    return freeze({ mode: "finish", start: 0, lead: 0, events: [{ at: 0.1, tone: "chime" }, { at: 0.1 + CHIME_GAP, voice: "all-done" }], duration: 0.1 + CHIME_GAP + voiceSeconds("all-done") + 0.5 });
  }
  function testTrack() {
    const events = [{ at: 0.2, voice: "test" }];
    let at = 0.4 + voiceSeconds("test");
    events.push({ at, tone: "rise" }, { at: at + TONE_GAP, voice: "start" });
    at += 1.4;
    events.push({ at, tone: "fall" }, { at: at + TONE_GAP, voice: "relax" });
    at += 1.4;
    for (const key of ["n3", "n2", "n1"]) { events.push({ at, voice: key }); at += 1; }
    events.push({ at, tone: "tick" });
    return freeze({ mode: "test", start: 0, lead: 0, events, duration: at + 0.5 });
  }

  // Where a playing track is: lead-in, a segment, or the item's spoken tail.
  function position(item, track, trackTime) {
    if (trackTime < track.lead) {
      const target = segmentAt(item, track.start);
      return { phase: "lead", remaining: track.lead - trackTime, segment: target, itemTime: track.start };
    }
    const itemTime = track.start + trackTime - track.lead;
    if (itemTime >= item.end - 1e-9) return { phase: "done", remaining: 0, segment: null, itemTime };
    const segment = segmentAt(item, itemTime);
    return { phase: "segment", remaining: segment.end - itemTime, segment, itemTime };
  }

  function doseSeconds(planId, groupRest = 60) {
    const plan = planOf(planId);
    return plan.items.reduce((sum, _, index) => sum + compile(planId, index, groupRest).segments.filter(s => s.dose).reduce((a, s) => a + s.seconds, 0), 0);
  }
  function doseSegments(planId, groupRest = 60) {
    const plan = planOf(planId);
    return plan.items.reduce((sum, item, index) => sum + (item.type === "manual" ? item.sets : compile(planId, index, groupRest).segments.filter(s => s.dose).length), 0);
  }
  function itemDose(item) {
    if (item.type === "hold") return `保持 ${item.hold} 秒 × ${item.reps} 次 × ${item.sets} 组`;
    if (item.type === "rounds") return `踮脚、拉伸各 ${item.work} 秒 × ${item.rounds} 轮`;
    return `每组 ${item.reps} 次 × ${item.sets} 组 · 不计时`;
  }
  function itemRestNote(item, groupRest) {
    if (item.type === "hold") return `每次间休息 ${item.rest} 秒 · 组间休息 ${GROUP_REST_LABELS[groupRest]}`;
    if (item.type === "rounds") return `前三轮后各休息 ${item.roundRest} 秒`;
    return "两组之间自己掌握节奏";
  }

  const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const validDate = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number);
    return localDate(new Date(y, m - 1, d, 12)) === value;
  };
  const validId = id => typeof id === "string" && /^[\w-]{8,100}$/.test(id);
  function weekDates(today) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
    start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return localDate(d); });
  }
  function monthCells(year, month, today) {
    const first = new Date(year, month, 1, 12);
    const cells = Array((first.getDay() + 6) % 7).fill(null);
    const count = new Date(year, month + 1, 0, 12).getDate();
    const todayKey = localDate(today);
    for (let day = 1; day <= count; day++) {
      const date = localDate(new Date(year, month, day, 12));
      cells.push({ day, date, today: date === todayKey, future: date > todayKey });
    }
    return cells;
  }

  const SNAPSHOT_STATES = Object.freeze(new Set(["paused", "between", "manual", "manual-ready"]));

  // One training session. The UI drives time; this object only decides what may happen next.
  class Session {
    constructor({ plan, groupRest = 60, id, item = 0, at = 0, state = "new", set = 1 }) {
      planOf(plan); checkRest(groupRest);
      if (!validId(id)) throw new Error("invalid session id");
      Object.assign(this, { plan, groupRest, id, item, at, state, set, track: null, completion: null });
    }
    get items() { return planOf(this.plan).items; }
    get current() { return this.items[this.item]; }
    compiled(index = this.item) { return compile(this.plan, index, this.groupRest); }
    // The track the next primary action will play, or null for manual steps.
    pendingTrack() {
      if (this.state === "new") return buildTrack(this.compiled(0), 0, "start");
      if (this.state === "between") return this.current.type === "manual" ? manualTrack(this.plan, this.item, 1, true) : buildTrack(this.compiled(), 0, "start");
      if (this.state === "paused") return buildTrack(this.compiled(), this.at, "resume");
      if (this.state === "manual-ready") return manualTrack(this.plan, this.item, 2, false);
      return null;
    }
    // Primary action from new / between / paused / manual-ready.
    begin() {
      const track = this.pendingTrack();
      if (!track) return null;
      if (this.current.type === "manual") {
        // The second set needs its own explicit start; a double tap cannot complete both sets.
        this.set = this.state === "manual-ready" ? 2 : 1;
        this.state = "manual"; this.track = track;
        return track;
      }
      this.state = "running"; this.track = track; this.at = track.start;
      return track;
    }
    where(trackTime) { return position(this.compiled(), this.track, trackTime); }
    // Advance with the playing clock. Returns "item-done", "finished" or null.
    advance(trackTime, date = new Date()) {
      if (this.state !== "running") return null;
      const place = this.where(trackTime);
      if (place.phase === "segment") this.at = resumePoint(this.compiled(), place.itemTime);
      if (place.phase !== "done") return null;
      if (this.item === this.items.length - 1) return this.finish(date);
      this.item += 1; this.at = 0; this.state = "between"; this.track = null; this.set = 1;
      return "item-done";
    }
    pause(trackTime) {
      if (this.state !== "running") return false;
      const place = this.where(trackTime);
      if (place.phase === "done") return false;
      this.at = place.phase === "lead" ? this.track.start : resumePoint(this.compiled(), place.itemTime);
      this.state = "paused"; this.track = null;
      return true;
    }
    canSkip(trackTime) {
      if (this.state !== "running") return false;
      const place = this.where(trackTime);
      return place.phase === "segment" && skipTarget(this.compiled(), place.itemTime) !== null;
    }
    skip(trackTime) {
      if (!this.canSkip(trackTime)) return null;
      const target = skipTarget(this.compiled(), this.where(trackTime).itemTime);
      this.track = buildTrack(this.compiled(), target, "skip"); this.at = target;
      return this.track;
    }
    completeManualSet(date = new Date()) {
      if (this.state !== "manual") return null;
      if (this.set === 1) { this.state = "manual-ready"; this.set = 2; this.track = null; return "manual-ready"; }
      return this.finish(date);
    }
    finish(date) {
      this.state = "finished"; this.track = null;
      let timeZone = null;
      try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { timeZone = null; }
      this.completion = freeze({ version: 1, id: this.id, program: this.plan, date: localDate(date), finishedAt: date.toISOString(), source: "training", timeZone });
      return "finished";
    }
    // Restores never consume offline time: a running session is saved at its resume point.
    snapshot() {
      if (["new", "finished"].includes(this.state)) return null;
      const state = this.state === "running" ? "paused" : this.state;
      return { version: 3, plan: this.plan, groupRest: this.groupRest, id: this.id, item: this.item, at: this.at, state, set: this.set };
    }
    static restore(value) {
      if (!value || value.version !== 3 || !PLANS[value.plan] || !GROUP_REST_OPTIONS.includes(value.groupRest) || !validId(value.id)) return null;
      const items = PLANS[value.plan].items;
      if (!Number.isInteger(value.item) || !items[value.item] || !SNAPSHOT_STATES.has(value.state)) return null;
      const item = items[value.item];
      if (item.type === "manual") {
        if (!["between", "manual", "manual-ready"].includes(value.state)) return null;
        // A refresh during a manual set returns to that set's explicit start.
        const state = value.state === "manual" ? (value.set === 2 ? "manual-ready" : "between") : value.state;
        return new Session({ ...value, at: 0, state, set: state === "manual-ready" ? 2 : 1 });
      }
      if (value.state === "manual" || value.state === "manual-ready") return null;
      const end = compile(value.plan, value.item, value.groupRest).end;
      if (!(Number.isFinite(value.at) && value.at >= 0 && value.at < end)) return null;
      return new Session({ ...value, at: value.state === "between" ? 0 : value.at, set: 1 });
    }
  }
  // Human-readable place for resume cards: "第 3 项 · 第 1 组".
  function describePlace(planId, index, at, groupRest = 60) {
    const item = planOf(planId).items[index];
    if (!item) return "";
    const head = `第 ${index + 1} 项`;
    if (item.type === "manual") return head;
    const segment = segmentAt(compile(planId, index, groupRest), at);
    if (!segment) return head;
    if (segment.set) return `${head} · 第 ${segment.set} 组`;
    if (segment.round) return `${head} · 第 ${segment.round} 轮`;
    return head;
  }

  return Object.freeze({
    PLAN_A, PLAN_B, PLAN_IDS, PLANS, GROUP_REST_OPTIONS, GROUP_REST_LABELS, VOICE_TEXT, TONE_SECONDS,
    PREP_SECONDS, SETTLE_SECONDS, COUNT_IN, RESUME_LEAD, TONE_GAP, WORK_KINDS, SKIPPABLE_KINDS,
    planOf, compile, segmentAt, resumePoint, skipTarget, buildTrack, manualTrack, finishTrack, testTrack, position,
    doseSeconds, doseSegments, itemDose, itemRestNote, voiceSeconds, describePlace,
    localDate, validDate, validId, weekDates, monthCells, Session
  });
})();
