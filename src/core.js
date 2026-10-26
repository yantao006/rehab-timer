/* Dependency-free domain code. Tests execute this exact script, not a copy. */
    globalThis.RehabCore = (() => {
      "use strict";
      const VERSION = 1;
      const PLAN_REVISION = 2;
      const GROUP_REST_OPTIONS = Object.freeze([60, 90, 120, 150]);
      const PROGRAM = "five-stage-v1";
      const JOINT_PROGRAM = "lower-limb-joints-v1";
      const stages = [
        { name: "俯卧左大腿屈膝后伸抗阻静力训练", equipment: "1 kg", short: "大腿后伸" },
        { name: "左侧直抬腿", equipment: "1 kg", short: "直抬腿" },
        { name: "左髋内收抗阻静力训练", equipment: "弹力带 15 磅", short: "髋内收" },
        { name: "左踝内翻训练", equipment: "弹力带 15 磅", short: "踝内翻" },
        { name: "左小腿踮脚静力训练 → 左小腿拉伸", equipment: "", short: "踮脚/拉伸" }
      ];
      const makePlan = (roundRests = true) => {
        const plan = [{ stage: 0, kind: "prep", seconds: 30 }];
        for (let stage = 0; stage < 4; stage++) {
          for (let group = 1; group <= 2; group++) {
            for (let rep = 1; rep <= 6; rep++) {
              plan.push({ stage, group, rep, kind: "work", seconds: 15 });
              if (rep < 6) plan.push({ stage, group, rep, kind: "rest", seconds: 5 });
            }
            if (group === 1) plan.push({ stage, group, rep: 6, kind: "group-rest", seconds: 60 });
          }
        }
        for (let round = 1; round <= 4; round++) {
          plan.push({ stage: 4, round, kind: "work", action: "左小腿踮脚静力训练", seconds: 30 });
          plan.push({ stage: 4, round, kind: "stretch", action: "左小腿拉伸", seconds: 30 });
          if (roundRests && round < 4) plan.push({ stage: 4, round, kind: "round-rest", seconds: 30 });
        }
        return plan.map((item, index) => Object.freeze({ ...item, index }));
      };
      const plan = Object.freeze(makePlan());
      const legacyPlan = Object.freeze(makePlan(false));
      const jointStages = Object.freeze([
        { name: "双侧屈膝抗阻静力训练", equipment: "弹力带 10 到 15 磅", short: "屈膝抗阻" },
        { name: "双侧屈膝屈髋维持训练", equipment: "", short: "屈膝屈髋" },
        { name: "双髋外展抗阻静力训练", equipment: "20 磅弹力环", short: "髋外展" },
        { name: "双髋内收抗阻静力训练", equipment: "仰卧内收腿夹球，球径 20 到 25 厘米", short: "髋内收" },
        { name: "双侧抬腿跨障碍", equipment: "", short: "抬腿跨障碍" }
      ]);
      const jointPlan = Object.freeze((() => {
        const items = [{ stage: 0, kind: "prep", seconds: 30 }];
        for (let stage = 0; stage < 4; stage++) {
          for (let group = 1; group <= 2; group++) {
            for (let rep = 1; rep <= 6; rep++) {
              items.push({ stage, group, rep, kind: "work", seconds: 15 });
              if (rep < 6) items.push({ stage, group, rep, kind: "rest", seconds: 7 });
            }
            if (group === 1) items.push({ stage, group, rep: 6, kind: "group-rest", seconds: 60 });
          }
          items.push({ stage, kind: "stage-rest", seconds: 60 });
        }
        for (let group = 1; group <= 2; group++) items.push({ stage: 4, group, kind: "manual", seconds: 0 });
        return items.map((item,index) => Object.freeze({ ...item, index }));
      })());
      const programs = Object.freeze({
        [PROGRAM]: { stages, plan },
        [JOINT_PROGRAM]: { stages: jointStages, plan: jointPlan }
      });
      const plans = new Map();
      function planFor(program = PROGRAM, groupRestSeconds = 60) {
        if (!programs[program]) throw new Error("unknown program");
        if (!GROUP_REST_OPTIONS.includes(groupRestSeconds)) throw new Error("invalid group rest");
        const key = `${program}:${groupRestSeconds}`;
        if (!plans.has(key)) plans.set(key,Object.freeze(programs[program].plan.map(item => item.kind === "group-rest" ? Object.freeze({...item,seconds:groupRestSeconds}) : item)));
        return plans.get(key);
      }
      const localDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
      const validDate = value => {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const [y,m,d] = value.split("-").map(Number);
        return localDate(new Date(y,m-1,d,12)) === value;
      };
      const validId = id => typeof id === "string" && /^[\w-]{8,100}$/.test(id);
      const validRecord = r => Boolean(r && r.version === VERSION && validId(r.id) && validDate(r.date) && typeof r.finishedAt === "string" && Number.isFinite(Date.parse(r.finishedAt)));
      const monthCells = (year, month, records, today) => {
        const marked = new Set(records.map(r => r.date));
        const first = new Date(year,month,1,12);
        const cells = Array((first.getDay()+6)%7).fill(null);
        const count = new Date(year,month+1,0,12).getDate();
        for (let day = 1; day <= count; day++) {
          const date = localDate(new Date(year,month,day,12));
          cells.push({ day, date, complete: marked.has(date), today: date === localDate(today) });
        }
        return cells;
      };
      const weeklyCount = (records, today) => {
        const start = new Date(today.getFullYear(),today.getMonth(),today.getDate(),12);
        start.setDate(start.getDate()-(start.getDay()+6)%7);
        const end = new Date(start); end.setDate(end.getDate()+7);
        return records.filter(r => r.date >= localDate(start) && r.date < localDate(end)).length;
      };
      class Engine {
        constructor(unitMs = 1000, program = PROGRAM, groupRestSeconds = 60) { this.plan = planFor(program,groupRestSeconds); this.unitMs = unitMs; this.program = program; this.groupRestSeconds = groupRestSeconds; this.reset(); }
        reset() { this.state = "idle"; this.id = null; this.index = 0; this.remaining = 30*this.unitMs; this.deadline = null; this.lastNow = null; this.resumeState = "cue"; this.completion = null; this.reason = ""; }
        get interval() { return this.plan[this.index]; }
        start(id) { if (this.state !== "idle" || !validId(id)) return false; this.id = id; this.state = "cue"; return true; }
        arm(now) { if (this.state !== "cue") return false; this.state = "running"; this.deadline = now+this.remaining; this.lastNow = now; return true; }
        tick(now, date = new Date()) {
          if (this.state !== "running") return null;
          // A throttled callback never catches up through unseen/unperformed intervals.
          // Freeze at the last observed instant, including when the audio clock stops.
          const boundaryGrace = Math.min(1000, 2*this.unitMs);
          if (now < this.lastNow || now-this.lastNow > 1500 || now-this.deadline > boundaryGrace) {
            this.pause(this.lastNow); this.reason = "计时延迟，已暂停。"; return "late";
          }
          this.lastNow = now;
          this.remaining = Math.max(0,this.deadline-now);
          if (now < this.deadline) return null;
          const old = this.interval;
          if (this.index === this.plan.length-1) {
            this.state = "finished";
            this.completion = { version: VERSION, id: this.id, date: localDate(date), finishedAt: date.toISOString() };
            return "finished";
          }
          this.index++;
          this.remaining = this.interval.seconds*this.unitMs;
          if (this.interval.stage !== old.stage) { this.state = "ready"; this.deadline = null; return "ready"; }
          if (old.kind === "prep") { this.state = "cue"; this.deadline = null; return "cue"; }
          this.deadline += this.remaining;
          this.remaining = Math.max(0,this.deadline-now);
          return "interval";
        }
        completeManual(date = new Date()) {
          if (this.state !== "manual" || this.interval.kind !== "manual") return false;
          if (this.index === this.plan.length-1) {
            this.state = "finished";
            this.completion = { version: VERSION, id: this.id, date: localDate(date), finishedAt: date.toISOString() };
            return "finished";
          }
          // A second completion gesture must belong to an explicitly started group.
          // Keeping the boundary in the domain snapshot also protects refresh/cloud restore.
          this.index++; this.remaining = 0; this.state = "ready"; this.deadline = null;
          return "ready";
        }
        pause(now) {
          if (!["running","cue","manual"].includes(this.state)) return false;
          this.resumeState = this.state;
          if (this.state === "running") {
            // Do not count a gap since the last heartbeat as performed training.
            const safeNow = Math.min(now,this.lastNow+1500,this.deadline);
            this.remaining = Math.max(1,this.deadline-safeNow);
          }
          this.state = "paused"; this.deadline = null; return true;
        }
        continue() {
          if (!["paused","ready"].includes(this.state)) return false;
          this.state = this.state === "paused" && this.interval.kind === "manual" ? "manual" : "cue";
          this.reason = ""; return true;
        }
        skip(kind, now) {
          if (this.state !== "running" || this.interval.kind !== kind || !["prep","group-rest","round-rest"].includes(kind)) return false;
          // Revalidate at the click's timestamp, so a stale control cannot skip work.
          const result = this.tick(now);
          if (result || this.state !== "running" || this.interval.kind !== kind) return false;
          this.index++; this.remaining = this.interval.seconds*this.unitMs; this.state = "cue"; this.deadline = null; return true;
        }
        snapshot() {
          if (this.state === "idle") return null;
          return { version: VERSION, planRevision: PLAN_REVISION, groupRestSeconds: this.groupRestSeconds, program: this.program, unitMs: this.unitMs, id: this.id, index: this.index, remaining: this.remaining, state: this.state, completion: this.completion };
        }
        restore(s) {
          if (!s || (s.planRevision !== undefined && ![1, PLAN_REVISION].includes(s.planRevision))) return false;
          const groupRestSeconds = s.groupRestSeconds === undefined ? 60 : s.groupRestSeconds;
          if (!GROUP_REST_OPTIONS.includes(groupRestSeconds)) return false;
          const legacy = s.planRevision === undefined || s.planRevision === 1;
          const selectedPlan = planFor(this.program,groupRestSeconds);
          const schedule = legacy && this.program === PROGRAM ? legacyPlan.map(item => item.kind === "group-rest" ? {...item,seconds:groupRestSeconds} : item) : selectedPlan;
          if (!s || s.version !== VERSION || s.program !== this.program || s.unitMs !== this.unitMs || !validId(s.id) || !Number.isInteger(s.index) || !schedule[s.index] || !Number.isFinite(s.remaining) || s.remaining < 0 || s.remaining > schedule[s.index].seconds*this.unitMs || !["cue","running","paused","ready","manual","finished"].includes(s.state)) return false;
          if (s.state === "finished" && (s.index !== schedule.length-1 || s.remaining !== 0 || !validRecord(s.completion) || s.completion.id !== s.id)) return false;
          if (s.state !== "finished" && (s.completion !== null || (schedule[s.index].kind !== "manual" && s.remaining <= 0))) return false;
          if (s.state === "manual" && schedule[s.index].kind !== "manual") return false;
          const manualGroupBoundary = schedule[s.index].kind === "manual" && schedule[s.index].group === 2 && schedule[s.index-1]?.kind === "manual";
          if (s.state === "ready" && (s.index === 0 || (!manualGroupBoundary && schedule[s.index-1].stage === schedule[s.index].stage) || s.remaining !== schedule[s.index].seconds*this.unitMs)) return false;
          this.groupRestSeconds = groupRestSeconds; this.plan = selectedPlan;
          this.id = s.id; this.index = legacy && this.program === PROGRAM && s.index >= 93 ? s.index + Math.floor((s.index - 93) / 2) : s.index; this.remaining = s.remaining; this.completion = s.completion;
          this.state = s.state === "finished" ? "finished" : s.state === "ready" ? "ready" : "paused";
          this.deadline = null; this.lastNow = null; this.reason = "进度已恢复。";
          return true;
        }
      }
      // Fixed, locally generated PCM recordings. No device voices or runtime TTS service.
      const cues = Object.freeze({
        prepare: ["准备",494], rest: ["休息",576],
        "group-1": ["第一组",654], "group-2": ["第二组",608],
        "continue-2": ["第二次继续",1088], "continue-3": ["第三次继续",1188],
        "continue-4": ["第四次继续",1181], "continue-5": ["第五次继续",1179],
        "continue-6": ["第六次继续",1236],
        "hip-extension": ["第一组，大腿后伸",1946], "leg-raise": ["第一组，直抬腿",1555],
        "hip-adduction": ["第一组，髋内收",1553], "ankle-inversion": ["第一组，踝内翻",1520],
        "calf-raise": ["踮脚",584], stretch: ["拉伸",523],
        next: ["下一项",701], complete: ["训练完成",903], test: ["声音测试",1145], beep: ["",170]
      });
      function cueFor(item, full=false, program=PROGRAM) {
        if (program === JOINT_PROGRAM) {
          if (["rest","stage-rest"].includes(item.kind)) return "rest";
          if (item.kind === "manual") return `group-${item.group}`;
          if (item.kind === "work" && item.rep === 1) return `group-${item.group}`;
        }
        if (item.kind === "prep") return "prepare";
        if (["rest","group-rest","round-rest"].includes(item.kind)) return "rest";
        if (item.stage === 4) return item.kind === "stretch" ? "stretch" : "calf-raise";
        if (item.rep === 1) {
          if (item.group === 2) return "group-2";
          return full ? ["hip-extension","leg-raise","hip-adduction","ankle-inversion"][item.stage] : "group-1";
        }
        return `continue-${item.rep}`;
      }
      class MediaChannel {
        constructor({ media, sourceFor, now, setTimer, clearTimer, warn, recover, onPlaying, log }) {
          Object.assign(this,{ media, sourceFor, now, setTimer, clearTimer, warn, recover, onPlaying, log });
          this.job = null; this.failed = false; this.loadedKey = null;
        }
        cancel(stop=true) {
          this.job?.finish("canceled");
          if (stop) try { this.media?.pause(); } catch { /* Nothing is playing. */ }
        }
        play(key, retry=false) {
          // Never enqueue: exactly one retained media element owns both speech and beeps.
          this.cancel(false);
          if (retry) this.failed = false;
          if (this.failed) return Promise.resolve("unavailable");
          const fail = reason => {
            this.failed = true; this.log("media-error",{key,reason});
            this.warn("声音未播放，请重试声音。");
          };
          if (!this.media || !cues[key]) { fail("unsupported"); return Promise.resolve("unavailable"); }
          return new Promise(resolve => {
            const media = this.media, started = this.now();
            let done = false, sawPlaying = false, timeout;
            const finish = result => {
              if (done) return; done = true; this.clearTimer(timeout);
              media.onplaying = media.onended = media.onerror = null;
              if (this.job?.finish === finish) this.job = null;
              resolve(result);
            };
            const reject = reason => {
              if (done) return;
              fail(reason); finish("unavailable"); media.pause();
            };
            this.job = { key, finish };
            media.onplaying = () => {
              if (done) return; sawPlaying = true;
              const elapsed = this.now()-started;
              this.log("media-playing",{key,cue:cues[key][0],elapsed});
              this.onPlaying?.(key,elapsed);
            };
            media.onended = () => {
              if (done) return;
              const elapsed = this.now()-started, position = media.currentTime*1000;
              // iOS often reports stale currentTime on short WAV ended; wall-clock + playing is the bound.
              if (!sawPlaying || elapsed < cues[key][1]*.65) { reject("no-playback-progress"); return; }
              // Decoder progress is evidence of playback, never proof of physical audibility.
              this.log("media-ended",{key,elapsed,position}); this.recover(); finish("ended");
            };
            media.onerror = () => reject(`resource-${media.error?.code || "error"}`);
            timeout = this.setTimer(() => reject("timeout"),5000+cues[key][1]);
            this.log("media-request",{key,cue:cues[key][0]});
            try {
              const src = this.sourceFor?.(key) || `audio/${key}.wav`;
              if (this.loadedKey !== key) {
                media.src = src;
                this.loadedKey = key;
              } else {
                try { media.currentTime = 0; } catch { /* Engine may throw before metadata. */ }
              }
              // Assigning src already starts resource selection. A second load() drops iOS activation.
              // This call must remain synchronous with Start / Continue / Retry clicks.
              const promise = media.play();
              promise?.catch(error => reject(error.name || "play-rejected"));
            } catch (error) { reject(error.name || "play-threw"); }
          });
        }
      }
      class Store {
        constructor(storage, prefix, warn = () => {}) { this.storage = storage; this.prefix = prefix; this.warn = warn; }
        read(key) { const raw = this.storage.getItem(key); return raw === null ? null : JSON.parse(raw); }
        loadProgress() {
          try { return this.read(`${this.prefix}:progress`); }
          catch { this.warn("进度读取失败，请检查网站存储。"); return null; }
        }
        saveProgress(value) {
          try {
            if (value) this.storage.setItem(`${this.prefix}:progress`, JSON.stringify(value));
            else this.storage.removeItem(`${this.prefix}:progress`);
            return true;
          } catch { this.warn(value ? "进度未保存，请检查网站存储和空间。" : "进度未清除，请检查网站存储。"); return false; }
        }
        history() {
          const records = [];
          try {
            for (let i=0; i<this.storage.length; i++) {
              const key = this.storage.key(i);
              if (!key?.startsWith(`${this.prefix}:done:`)) continue;
              try {
                const r = this.read(key);
                if (!validRecord(r) || key !== `${this.prefix}:done:${r.id}`) throw new Error("invalid record");
                records.push(r);
              } catch { this.warn("部分历史读取失败，原数据已保留。"); }
            }
          } catch { this.warn("历史读取失败，请检查网站存储。"); }
          try {
            for (let i=0; i<this.storage.length; i++) {
              const key = this.storage.key(i);
              if (!key?.startsWith(`${this.prefix}:date:`)) continue;
              const date = key.slice(`${this.prefix}:date:`.length), completed = this.read(key);
              if (!validDate(date) || typeof completed !== "boolean") { this.warn("部分日期编辑读取失败。"); continue; }
              if (!completed) { for (let j=records.length-1;j>=0;j--) if (records[j].date===date) records.splice(j,1); }
              else if (!records.some(r=>r.date===date)) records.push({version:VERSION,id:`manual-${date}`,date,finishedAt:new Date(`${date}T12:00:00`).toISOString()});
            }
          } catch { this.warn("日期编辑读取失败，请检查网站存储。"); }
          return records;
        }
        setDate(date, completed, now = new Date()) {
          if (!validDate(date) || date > localDate(now)) return false;
          try {
            // One atomic override masks a date without destroying its session records.
            this.storage.setItem(`${this.prefix}:date:${date}`,JSON.stringify(completed));
            return true;
          } catch { this.warn("日期未保存，请检查网站存储后重试。"); return false; }
        }
        complete(record) {
          if (!validRecord(record)) return false;
          try {
            const key = `${this.prefix}:done:${record.id}`;
            const existing = this.read(key);
            if (existing !== null && (!validRecord(existing) || existing.id !== record.id)) throw new Error("invalid record");
            // One atomic key per session: retries/tabs never append duplicate records.
            if (!existing) this.storage.setItem(key,JSON.stringify(record));
            return true;
          } catch { this.warn("打卡未保存，请检查存储后重试。"); return false; }
        }
      }
      // Continuous stage media: silence, speech and beeps share one playback clock.
      function stageTrack(stage, program = PROGRAM, groupRestSeconds = 60) {
        const schedule = planFor(program,groupRestSeconds);
        let end = 0;
        const entries = [], sounds = [];
        for (const item of schedule.filter(p => p.stage === stage && p.kind !== "manual")) {
          const key = cueFor(item, entries.length === 0 || item.index === 1, program);
          const opening = entries.length === 0 || item.index === 1;
          const start = opening ? end + cues[key][1]/1000 + .25 : end;
          sounds.push({ key, at: opening ? end : start-cues[key][1]/1000-.25 });
          sounds.push({ key: "beep", at: start });
          end = start+item.seconds;
          entries.push({ index:item.index, start, end });
        }
        const key = stage === 4 ? "complete" : "next";
        sounds.push({ key, at:end });
        return { entries, sounds, end, duration:end+cues[key][1]/1000+.25 };
      }
      return { VERSION, PLAN_REVISION, GROUP_REST_OPTIONS, PROGRAM, JOINT_PROGRAM, programs, planFor, stages, plan, jointStages, jointPlan, Engine, Store, MediaChannel, cues, cueFor, stageTrack, localDate, validDate, monthCells, weeklyCount };
    })();
