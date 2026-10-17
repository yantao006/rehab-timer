/* Cloud is authoritative; local snapshots and independent outbox keys survive interruptions. */
globalThis.RehabPersistence = (() => {
  "use strict";
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const validId = value => typeof value === "string" && /^[\w-]{8,100}$/.test(value);
  const hash = value => {
    let a = 2166136261, b = 2246822507;
    for (const char of String(value)) { a = Math.imul(a ^ char.charCodeAt(0),16777619); b = Math.imul(b ^ char.charCodeAt(0),3266489909); }
    return (a >>> 0).toString(16).padStart(8,"0") + (b >>> 0).toString(16).padStart(8,"0");
  };
  function create(options = {}) {
    const core = globalThis.RehabCore;
    if (!core) throw new Error("RehabCore must load before RehabPersistence");
    const storage = options.storage;
    const now = () => Number(options.now ? options.now() : Date.now());
    const uuid = options.uuid || (() => globalThis.crypto.randomUUID());
    const token = () => { let value = uuid(); while (value.length < 32) value += uuid(); return value; };
    const prefix = options.prefix || "rehab-timer:v2";
    const location = globalThis.location || {};
    const isolated = options.mode !== "cloud" || location.protocol === "file:" || /(?:[?&])(?:test=1|debugMs=)/.test(location.search || "") || /(?:^|:)test(?:$|:)/.test(prefix);
    const mode = isolated ? "local" : "cloud";
    const base = mode === "local" ? `rehab-timer:test:v2:${hash(prefix)}` : "rehab-timer:v2";
    const fetcher = options.fetch || globalThis.fetch?.bind(globalThis);
    const setTimer = options.setTimeout || globalThis.setTimeout?.bind(globalThis);
    const clearTimer = options.clearTimeout || globalThis.clearTimeout?.bind(globalThis);
    const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : 12000;
    const instance = uuid();
    let serial = 0, authenticated = mode === "local", busy = null, problem = mode === "local" ? null : {state:"loading",message:"正在读取共享记录。"};
    let lastStatus = "", lastChange = "";
    const listeners = new Set();
    const lastCheckpoint = new Map();
    const observedHeads = new Map(), adoptedOperations = new Set();
    const key = (kind,program,id) => `${base}:${kind}${program ? `:${program}` : ""}${id ? `:${id}` : ""}`;
    const read = name => { const raw = storage.getItem(name); return raw === null ? null : JSON.parse(raw); };
    const write = (name,value) => storage.setItem(name,JSON.stringify(value));
    const remove = name => storage.removeItem(name);
    const keys = start => {
      const found = [];
      for (let index = 0; index < storage.length; index++) { const name = storage.key(index); if (name?.startsWith(start)) found.push(name); }
      return found.sort();
    };
    function entries(kind) { return keys(`${base}:${kind}:`).map(name => ({name,value:read(name)})).filter(entry => entry.value !== null); }
    function operations() {
      return entries("op").map(entry => entry.value).sort((a,b) => a.createdAt-b.createdAt || a.sequence-b.sequence || a.id.localeCompare(b.id));
    }
    function conflicts() {
      try {
        const pending = operations();
        return [...pending.filter(op => op.conflict).map(op => ({id:op.id,program:op.program,sessionId:op.sessionId,type:op.type,...op.conflict,canCopy:pending.some(item => item.type === "complete" && item.program === op.program && item.sessionId === op.sessionId)})),...entries("conflict").map(entry => entry.value)];
      } catch { return []; }
    }
    function status() {
      let pending = 0, conflictList = [];
      try { pending = operations().length; conflictList = conflicts(); }
      catch { return {state:"error",message:"无法读取本地恢复数据，请检查网站存储。",pending:0,conflicts:[],mode}; }
      let state = problem?.state || (conflictList.length ? "conflict" : pending ? "pending" : "synced");
      if (conflictList.length && !["locked","loading","error"].includes(state)) state = "conflict";
      const messages = {synced:mode === "local" ? "隔离模式，记录保存在本地。" : "共享记录已同步。",pending:"记录已保留，等待同步。",conflict:"发现同步冲突，原记录已保留，请选择处理方式。"};
      return {state,message:problem?.state === state ? problem.message : messages[state],pending,conflicts:conflictList,mode};
    }
    function emit(changed = false) {
      const current = status(), digest = JSON.stringify(current);
      if (digest !== lastStatus) { lastStatus = digest; options.onStatus?.(copy(current)); }
      if (changed) { options.onChange?.(); for (const listener of listeners) listener(copy(current)); }
    }
    function failure(message) { problem = {state:"error",message}; emit(); return false; }
    function safely(fn,message = "记录未保存，请检查网站存储和空间。") { try { return fn(); } catch { return failure(message); } }
    function validRecord(record) {
      return Boolean(record && record.version === 1 && validId(record.id) && core.validDate(record.date) && typeof record.finishedAt === "string" && Number.isFinite(Date.parse(record.finishedAt)));
    }
    function validLegacyRecord(record) {
      if (!validRecord(record) || !Object.keys(record).every(field => ["version","id","program","date","finishedAt","source","timeZone"].includes(field))) return false;
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(record.finishedAt)) return false;
      const finished = Date.parse(record.finishedAt), midday = Date.parse(`${record.date}T12:00:00Z`);
      if (finished > now()+300000 || record.date > new Date(now()+14*3600000).toISOString().slice(0,10) || finished < midday-26*3600000 || finished > midday+24*3600000) return false;
      if (record.timeZone != null) {
        try {
          const parts = new Intl.DateTimeFormat("en-CA",{timeZone:record.timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(finished));
          const part = type => parts.find(value => value.type === type).value;
          if (`${part("year")}-${part("month")}-${part("day")}` !== record.date) return false;
        } catch { return false; }
      }
      return true;
    }
    function normalizeSnapshot(snapshot,program) {
      try {
        if (!snapshot || snapshot.program !== program || !core.programs[program] || (mode !== "local" && snapshot.unitMs !== 1000)) return null;
        const engine = new core.Engine(snapshot.unitMs,program);
        if (!engine.restore(copy(snapshot))) return null;
        // Let the actual engine map old plan indexes. Preserve the recorded state in the
        // transport; the engine still restores running/cue snapshots as paused for playback.
        return {...engine.snapshot(),state:snapshot.state};
      } catch { return null; }
    }
    function timeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } }
    function schedule() { if (mode === "cloud" && authenticated && !problem) Promise.resolve().then(flush).catch(() => {}); }
    function enqueue(type,payload,id = `op-${uuid()}`) {
      const name = key("op",null,id), existing = read(name);
      if (existing) return existing;
      serial = Math.max(serial,...operations().map(item => item.sequence || 0)) + 1;
      const op = {id,type,program:payload.program,sessionId:payload.sessionId,createdAt:now(),sequence:serial,owner:instance,payload:copy(payload)};
      if (["progress","complete","abandon"].includes(type)) {
        const credential = observedOwner(payload.program,payload.sessionId);
        const preceding = pendingFor(payload.program,payload.sessionId).filter(item => (item.owner === instance || adoptedOperations.has(item.id)) && ["create","progress","complete","abandon","claim"].includes(item.type));
        op.expectedRevision = credential.revision + preceding.length;
        op.writerEpoch = credential.writerEpoch; op.writerToken = credential.writerToken;
      }
      write(name,op); problem = problem?.state === "error" ? null : problem;
      emit(true); schedule(); return op;
    }
    function owner(program,id) { return read(key("owner",program,id)); }
    function observedOwner(program,id) {
      const name = `${program}:${id}`;
      if (!observedHeads.has(name)) {
        observedHeads.set(name,copy(owner(program,id)));
        for (const op of pendingFor(program,id)) adoptedOperations.add(op.id);
      }
      return observedHeads.get(name);
    }
    function ensureCreate(program,snapshot) {
      if (mode === "local") return;
      snapshot = normalizeSnapshot(snapshot,program);
      if (!snapshot) throw new Error("训练快照无法转换，原数据已保留。");
      let credential = owner(program,snapshot.id);
      if (!credential) { credential = {revision:0,writerEpoch:1,writerToken:token()}; write(key("owner",program,snapshot.id),credential); }
      observedOwner(program,snapshot.id);
      if (credential.revision > 0) return;
      const initial = copy(snapshot);
      if (initial.state === "finished") { initial.state = "paused"; initial.index = 0; initial.remaining = 30000; initial.completion = null; }
      enqueue("create",{program,sessionId:initial.id,snapshot:initial,writerToken:credential.writerToken},`create-${hash(program+initial.id)}`);
    }
    function pendingFor(program,id) { return operations().filter(op => op.program === program && op.sessionId === id); }
    function projectedHistory(program) {
      const records = new Map();
      for (const {value} of entries("record")) if (value.program === program) records.set(value.id,value);
      for (const op of operations()) {
        if (op.program !== program) continue;
        if ((op.type === "complete" || op.type === "manual") && !op.conflict && !records.has(op.payload.record.id)) records.set(op.payload.record.id,{...op.payload.record,revoked:false,pending:true});
        if (op.type === "revoke") { const record = records.get(op.payload.recordId); if (record) records.set(record.id,{...record,revoked:true}); }
      }
      return [...records.values()].filter(record => !record.revoked).map(record => ({...copy(record),version:1})).sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    }
    function forProgram(program) {
      if (!core.programs[program]) throw new Error("Unknown training program");
      return {
        loadProgress() {
          const result = safely(() => {
            const id = read(key("active",program));
            if (!id || read(key("terminal",program,id)) === "abandoned") return null;
            const raw = read(key("snapshot",program,id)), snapshot = normalizeSnapshot(raw,program);
            if (!snapshot) { if (raw !== null) failure("进度无法恢复，原数据已保留。"); return null; }
            if (mode === "cloud" && owner(program,id)) observedOwner(program,id);
            return copy(snapshot);
          },"进度读取失败，原数据已保留。");
          return result || null;
        },
        saveProgress(snapshot,force = false) {
          return safely(() => {
            if (snapshot === null) {
              const id = read(key("active",program));
              if (id && (read(key("record",program,id)) || pendingFor(program,id).some(op => op.type === "complete"))) write(key("terminal",program,id),"completed");
              if (id && !read(key("terminal",program,id))) {
                if (mode === "cloud") enqueue("abandon",{program,sessionId:id},`abandon-${hash(program+id)}`);
                write(key("terminal",program,id),"abandoned");
              }
              remove(key("active",program)); emit(true); return true;
            }
            snapshot = normalizeSnapshot(snapshot,program);
            if (!snapshot) return failure("进度格式无效，原数据已保留。");
            const terminal = read(key("terminal",program,snapshot.id));
            if (terminal && (terminal !== "completed" || snapshot.state !== "finished")) return false;
            const previous = read(key("snapshot",program,snapshot.id));
            if (previous && normalizeSnapshot(previous,program)?.groupRestSeconds !== snapshot.groupRestSeconds) return failure("本次训练的组间休息已固定，原进度已保留。");
            if (!previous && mode === "cloud" && !canStart()) return failure("当前无法开始新的共享训练，请先联网解锁。");
            write(key("snapshot",program,snapshot.id),snapshot);
            write(key("active",program),snapshot.id);
            if (mode === "cloud" && !terminal && !pendingFor(program,snapshot.id).some(op => op.conflict)) {
              ensureCreate(program,snapshot);
              const checkpointId = `${program}:${snapshot.id}`, last = lastCheckpoint.get(checkpointId) ?? now();
              if (!lastCheckpoint.has(checkpointId)) lastCheckpoint.set(checkpointId,last);
              const boundary = !previous || previous.index !== snapshot.index || previous.state !== snapshot.state;
              if (snapshot.state !== "finished" && (force || boundary || now()-last >= 10000)) {
                const op = enqueue("progress",{program,sessionId:snapshot.id,snapshot});
                for (const previousOp of pendingFor(program,snapshot.id)) {
                  if (previousOp.id !== op.id && previousOp.type === "progress" && previousOp.owner === instance && !previousOp.request && !previousOp.conflict) {
                    op.expectedRevision = Math.min(op.expectedRevision,previousOp.expectedRevision);
                    write(key("op",null,op.id),op); remove(key("op",null,previousOp.id));
                  }
                }
                lastCheckpoint.set(checkpointId,now());
              }
            }
            return true;
          });
        },
        history() { const result = safely(() => projectedHistory(program),"历史读取失败，原数据已保留。"); return Array.isArray(result) ? result : []; },
        complete(record) {
          return safely(() => {
            if (!validRecord(record)) return false;
            const existing = read(key("record",program,record.id));
            if (existing) { if (existing.source === "manual") return false; write(key("terminal",program,record.id),"completed"); return true; }
            if (read(key("terminal",program,record.id)) === "abandoned") return false;
            const snapshot = normalizeSnapshot(read(key("snapshot",program,record.id)),program);
            if (!snapshot || snapshot.state !== "finished" || snapshot.completion?.id !== record.id || snapshot.completion.date !== record.date || snapshot.completion.finishedAt !== record.finishedAt) return failure("完成进度尚未保存，请重试。");
            const cloudRecord = {id:record.id,program,date:record.date,finishedAt:record.finishedAt,source:"training",timeZone:timeZone()};
            if (mode === "cloud") {
              ensureCreate(program,snapshot);
              enqueue("complete",{program,sessionId:record.id,snapshot,record:cloudRecord},`complete-${hash(program+record.id)}`);
            } else write(key("record",program,record.id),{...cloudRecord,revoked:false});
            write(key("terminal",program,record.id),"completed"); emit(true); return true;
          });
        },
        setDate(date,completed) {
          return safely(() => {
            if (!core.validDate(date) || date > core.localDate(new Date(now())) || typeof completed !== "boolean") return false;
            const records = projectedHistory(program).filter(record => record.date === date);
            if (completed) {
              if (records.length) return true;
              return this.addManual(date);
            } else { for (const record of records) if (!this.revoke(record.id)) return false; }
            emit(true); return true;
          });
        },
        addManual(date) {
          return safely(() => {
            if (!core.validDate(date) || date > core.localDate(new Date(now()))) return false;
            const record = {id:`manual-${uuid()}`,program,date,finishedAt:null,source:"manual",timeZone:timeZone()};
            if (mode === "cloud") enqueue("manual",{program,record});
            else write(key("record",program,record.id),{...record,revoked:false});
            emit(true); return true;
          });
        },
        revoke(id) {
          return safely(() => {
            if (!validId(id)) return false;
            const record = projectedHistory(program).find(item => item.id === id);
            if (!record) return true;
            if (mode === "cloud") enqueue("revoke",{program,recordId:id},`revoke-${hash(program+id)}`);
            else write(key("record",program,id),{...record,revoked:true});
            emit(true); return true;
          });
        }
      };
    }
    async function request(path,body) {
      if (mode !== "cloud") throw new Error("Isolated mode cannot use the cloud API");
      if (!fetcher) throw new Error("网络接口不可用。");
      const controller = globalThis.AbortController ? new globalThis.AbortController() : null;
      let timeout;
      const network = (async () => {
        const response = await fetcher(path,{method:body === undefined ? "GET" : "POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},...(controller ? {signal:controller.signal} : {}),...(body === undefined ? {} : {body:JSON.stringify(body)})});
        let data;
        try { data = await response.json(); } catch { const error = new Error("服务器返回了无效内容，请稍后重试。"); error.status = response.status; throw error; }
        if (!response.ok || data.ok !== true) { const error = new Error(data.error?.message || "同步失败，请重试。"); error.status = response.status; error.code = data.error?.code; error.session = data.session; throw error; }
        return data;
      })();
      if (!setTimer) return network;
      const deadline = new Promise((resolve,reject) => {
        timeout = setTimer(() => {
          const error = new Error("连接超时，待同步记录已保留，请重试。"); error.code = "request_timeout";
          reject(error); controller?.abort();
        },requestTimeoutMs);
      });
      try { return await Promise.race([network,deadline]); }
      finally { clearTimer?.(timeout); }
    }
    function networkFailure(error) {
      if (error.status === 401) { authenticated = false; problem = {state:"locked",message:"输入共享口令后同步记录。"}; }
      else problem = {state:error.status ? "error" : "offline",message:error.status || error.code === "request_timeout" ? error.message : "网络暂不可用，已保留待同步记录。"};
      emit();
    }
    function rememberSession(session) {
      const name = key("session",session.program,session.id), existing = read(name);
      if (!existing || existing.revision <= session.revision) write(name,{...session,snapshot:normalizeSnapshot(session.snapshot,session.program) || session.snapshot});
    }
    function rememberRecord(record,program = record.program) {
      const name = key("record",program,record.id), existing = read(name);
      write(name,{...record,program,revoked:Boolean(existing?.revoked || record.revoked)});
    }
    function acknowledge(op,data) {
      if (data.session) {
        rememberSession(data.session);
        const credential = owner(data.session.program,data.session.id);
        if ((credential || data.writerToken) && (!credential || data.session.revision >= credential.revision)) write(key("owner",data.session.program,data.session.id),{revision:data.session.revision,writerEpoch:data.session.writerEpoch,writerToken:data.writerToken || credential.writerToken});
        const headKey = `${data.session.program}:${data.session.id}`, observed = observedHeads.get(headKey);
        if ((op.owner === instance || adoptedOperations.has(op.id)) && (!observed || data.session.revision >= observed.revision)) observedHeads.set(headKey,{revision:data.session.revision,writerEpoch:data.session.writerEpoch,writerToken:data.writerToken || op.writerToken || credential?.writerToken});
      }
      if (data.record) rememberRecord(data.record,data.record.program || op.program);
      if (op.type === "revoke") {
        const record = read(key("record",op.program,op.payload.recordId));
        if (record) write(key("record",op.program,record.id),{...record,revoked:true});
      }
      if (data.import) {
        write(key("import-result",null,op.id),data.import);
        if (data.import.conflicts?.length) write(key("conflict",null,op.id),{id:op.id,type:"import",message:"部分旧记录与共享记录冲突，请核对导入结果。",details:data.import.conflicts,canCopy:false});
        for (const session of data.import.insertedSessions || []) {
          const item = op.payload.progress.find(entry => entry.program === session.program && entry.snapshot.id === session.id);
          if (item && item.snapshot.state !== "finished") {
            const known = read(key("session",session.program,session.id));
            if (known && (known.revision > 1 || known.writerEpoch > 1 || known.status !== "active")) {
              const name = key("conflict",null,op.id), notice = read(name);
              const detail = {program:session.program,id:session.id,reason:"imported_session_changed"};
              write(name,{id:op.id,type:"import",message:"导入后的训练已被更新，请核对并明确选择接管。",details:[...(notice?.details || []),detail],canCopy:false});
              continue;
            }
            write(key("owner",session.program,session.id),{revision:1,writerEpoch:1,writerToken:item.writerToken});
            const snapshot = normalizeSnapshot(item.snapshot,session.program);
            if (!snapshot) throw new Error("导入的快照无法恢复，原数据已保留。");
            write(key("snapshot",session.program,session.id),snapshot);
            if (!read(key("active",session.program))) write(key("active",session.program),session.id);
          }
        }
      }
      remove(key("op",null,op.id));
    }
    async function refresh() {
      if (mode === "local") { emit(); return status(); }
      try {
        const data = await request("/api/state"); authenticated = true;
        for (const record of data.records || []) rememberRecord(record);
        for (const session of data.sessions || []) rememberSession(session);
        problem = null; emit(true); return status();
      } catch (error) { networkFailure(error); return status(); }
    }
    async function flush() {
      if (busy) return busy;
      if (mode === "cloud" && !authenticated && problem?.state === "offline") await refresh();
      if (mode === "local" || !authenticated) { emit(); return status(); }
      busy = (async () => {
        let refreshNeeded = false;
        try {
          const attempted = new Set();
          let initial;
          while ((initial = operations().find(item => !attempted.has(item.id)))) {
            attempted.add(initial.id);
            const op = read(key("op",null,initial.id));
            if (!op || op.conflict) continue;
            if (op.sessionId && operations().some(previous => previous.conflict && previous.program === op.program && previous.sessionId === op.sessionId)) continue;
            try {
              if (!op.request) {
                op.request = {operationId:op.id,type:op.type,...copy(op.payload)};
                if (["progress","complete","abandon"].includes(op.type)) {
                  if (!op.expectedRevision) continue;
                  Object.assign(op.request,{expectedRevision:op.expectedRevision,writerEpoch:op.writerEpoch,writerToken:op.writerToken});
                }
                write(key("op",null,op.id),op);
              }
              const data = await request("/api/operation",op.request);
              acknowledge(op,data); refreshNeeded ||= op.type === "import"; problem = null;
            } catch (error) {
              if (error.status === 409 || (error.status >= 400 && error.status < 500 && ![401,403,429].includes(error.status))) {
                op.conflict = {message:error.message,code:error.code,session:error.session || null};
                write(key("op",null,op.id),op); problem = null;
              } else { networkFailure(error); break; }
            }
          }
        } catch { failure("同步结果无法写入本地，待同步操作已保留。"); }
        if (refreshNeeded) await refresh();
        emit(true); return status();
      })();
      try { return await busy; } finally { busy = null; }
    }
    function canStart() { return mode === "local" || (authenticated && !["locked","loading","offline","error"].includes(status().state)); }
    async function init() { await refresh(); if (authenticated) await flush(); return status(); }
    async function login(passphrase) {
      if (mode === "local") return status();
      try { await request("/api/login",{passphrase}); authenticated = true; problem = null; await refresh(); await flush(); }
      catch (error) { networkFailure(error); }
      return status();
    }
    async function logout() {
      if (mode === "local") return status();
      try { await request("/api/logout",{}); authenticated = false; problem = {state:"locked",message:"已锁定，待同步数据保留在本设备。"}; emit(true); }
      catch (error) { networkFailure(error); }
      return status();
    }
    function sessions() {
      try { return entries("session").map(entry => copy(entry.value)).filter(session => session.status === "active"); }
      catch { failure("无法读取可继续的训练。"); return []; }
    }
    async function claimSession(id,program) {
      if (mode !== "cloud" || !authenticated || ["offline","locked","error","loading"].includes(status().state)) throw new Error("请联网解锁后接管训练。");
      const candidates = sessions().filter(session => session.id === id && (!program || session.program === program));
      if (candidates.length !== 1) throw new Error("请选择明确的可继续训练。");
      const session = candidates[0];
      if (pendingFor(session.program,id).length) throw new Error("本设备仍有该训练的待同步记录，请先处理。");
      const op = enqueue("claim",{program:session.program,sessionId:id,expectedRevision:session.revision});
      await flush();
      const pending = read(key("op",null,op.id));
      if (pending) throw new Error(pending.conflict?.message || status().message);
      const claimed = read(key("session",session.program,id));
      const engine = new core.Engine(1000,session.program);
      if (!engine.restore(claimed.snapshot)) throw new Error("云端快照无法恢复，原记录已保留。");
      const snapshot = {...claimed.snapshot,...engine.snapshot()};
      write(key("snapshot",session.program,id),snapshot); write(key("active",session.program),id);
      emit(true); return copy(snapshot);
    }
    function legacyEntries() {
      if (mode !== "cloud") return [];
      return keys("rehab-timer:v1:").map(name => ({key:name,value:storage.getItem(name)}));
    }
    function sourceId() {
      const name = key("legacy-source"); let value = read(name);
      if (!value) { value = `source-${uuid()}`; write(name,value); }
      return value;
    }
    function scanLegacy() {
      const scan = {entries:[],records:[],overrides:[],progress:[],issues:[],counts:{records:0,overrides:0,progress:0,issues:0},importId:null,sourceId:null,canImport:false,disabled:mode !== "cloud"};
      if (mode !== "cloud") return scan;
      try {
        scan.entries = legacyEntries(); scan.sourceId = sourceId();
        for (const entry of scan.entries) {
          const joint = entry.key.startsWith("rehab-timer:v1:joint:");
          const program = joint ? core.JOINT_PROGRAM : core.PROGRAM;
          const stem = joint ? "rehab-timer:v1:joint:" : "rehab-timer:v1:";
          const suffix = entry.key.slice(stem.length);
          if (!/^(done:|date:|progress$)/.test(suffix)) continue;
          try {
            const value = JSON.parse(entry.value);
            if (suffix.startsWith("done:")) {
              if (!validLegacyRecord(value) || suffix !== `done:${value.id}`) throw new Error("完成记录格式、日期或时间不兼容。");
              scan.records.push({key:entry.key,program,record:value});
            } else if (suffix.startsWith("date:")) {
              const date = suffix.slice(5);
              if (!core.validDate(date) || typeof value !== "boolean" || date > core.localDate(new Date(now()))) throw new Error("日期覆盖格式不兼容。");
              scan.overrides.push({key:entry.key,program,date,completed:value});
            } else {
              const snapshot = normalizeSnapshot(value,program);
              if (!snapshot || !Object.keys(value).every(field => ["version","planRevision","program","unitMs","groupRestSeconds","id","index","remaining","state","completion"].includes(field)) || (value.completion && !validLegacyRecord(value.completion))) throw new Error("训练进度版本或内容不兼容。");
              const tokenKey = key("legacy-token",program,value.id); let writerToken = read(tokenKey);
              if (!writerToken) { writerToken = token(); write(tokenKey,writerToken); }
              scan.progress.push({key:entry.key,program,snapshot,writerToken});
            }
          } catch (error) { scan.issues.push({key:entry.key,message:error.message}); }
        }
        scan.canImport = Boolean(scan.records.length || scan.overrides.length || scan.progress.length);
        if (scan.records.length > 500 || scan.overrides.length > 500 || scan.progress.length > 2) { scan.canImport = false; scan.issues.push({key:null,message:"旧数据超过单批上限，请保留备份并分批迁移，未截断数据。"}); }
        scan.importId = `import-${hash(JSON.stringify([scan.sourceId,scan.records,scan.overrides,scan.progress]))}`;
      } catch { scan.issues.push({key:null,message:"无法读取旧数据，原始内容未修改。"}); }
      scan.counts = {records:scan.records.length,overrides:scan.overrides.length,progress:scan.progress.length,issues:scan.issues.length};
      return scan;
    }
    function backupLegacy() { return JSON.stringify({format:"rehab-timer-legacy-backup-v1",exportedAt:new Date(now()).toISOString(),sourceId:mode === "cloud" ? sourceId() : null,entries:legacyEntries()},null,2); }
    async function importLegacy(preview) {
      if (mode !== "cloud") return {ok:false,pending:false,conflicts:[],message:"隔离模式不迁移正式数据。"};
      const scan = scanLegacy();
      if (preview?.importId && preview.importId !== scan.importId) return {ok:false,pending:false,conflicts:[],message:"旧数据已变化，请重新检查迁移预览。"};
      if (!scan.canImport) return {ok:false,pending:false,conflicts:[],message:"没有可导入的数据，或数据需要先处理。"};
      const payload = {sourceId:scan.sourceId,records:scan.records,overrides:scan.overrides,progress:scan.progress};
      if (!safely(() => enqueue("import",payload,scan.importId))) return {ok:false,pending:false,conflicts:[]};
      await flush();
      const pending = read(key("op",null,scan.importId)), result = read(key("import-result",null,scan.importId));
      return {ok:!pending && Boolean(result),pending:Boolean(pending),conflicts:result?.conflicts || [],result};
    }
    async function resolveConflict(id,choice) {
      const op = read(key("op",null,id));
      const notice = read(key("conflict",null,id));
      if (!op?.conflict && !notice) return false;
      if (!["cloud","copy"].includes(choice)) throw new Error("未知冲突处理方式。");
      if (choice === "copy") {
        const completion = op?.sessionId && pendingFor(op.program,op.sessionId).find(item => item.type === "complete");
        if (!completion || !authenticated || ["offline","locked","error"].includes(status().state)) throw new Error("只有联网后才能将本地完整训练另存。");
        const intentKey = key("copy-intent",op.program,op.sessionId);
        let intent = read(intentKey);
        if (!intent) {
          // Persist the destination before any request can be queued. A partial local write,
          // refresh, or another tab retry must refer to the same additional training session.
          const nextId = `copy-${hash(JSON.stringify([completion.id,op.program,op.sessionId,completion.payload.record]))}`;
          const record = {...completion.payload.record,id:nextId};
          const snapshot = {...completion.payload.snapshot,id:nextId,completion:{...completion.payload.snapshot.completion,id:nextId}};
          intent = {sourceOperationId:completion.id,program:op.program,sessionId:nextId,snapshot,record};
          write(intentKey,intent);
        }
        if (!read(key("record",intent.program,intent.sessionId))) {
          const snapshot = normalizeSnapshot(intent.snapshot,intent.program);
          if (!snapshot) throw new Error("另存的快照无法转换，原数据已保留。");
          write(key("snapshot",intent.program,intent.sessionId),snapshot);
          ensureCreate(intent.program,snapshot);
          enqueue("complete",{program:intent.program,sessionId:intent.sessionId,snapshot,record:intent.record},`complete-${hash(intent.program+intent.sessionId)}`);
        }
        write(key("terminal",intent.program,intent.sessionId),"completed");
      }
      // Keep a private audit copy before the user explicitly dismisses any pending data.
      if (op) {
        const related = op.sessionId ? pendingFor(op.program,op.sessionId) : [op];
        for (const item of related) { write(key("resolved",null,item.id),{...item,resolution:choice,resolvedAt:now()}); remove(key("op",null,item.id)); }
        if (op.sessionId && read(key("active",op.program)) === op.sessionId) remove(key("active",op.program));
      }
      if (notice) { write(key("resolved",null,id),{...notice,resolution:choice,resolvedAt:now()}); remove(key("conflict",null,id)); }
      problem = null; emit(true); await refresh(); await flush(); return true;
    }
    function isSynced(program,id) {
      try { return Boolean(read(key("record",program,id)) && !pendingFor(program,id).length); }
      catch { return false; }
    }
    function storageChanged(event) {
      if (!event.key?.startsWith(`${base}:`) || event.key.includes(":snapshot:")) return;
      const fingerprint = `${status().pending}:${JSON.stringify(conflicts())}:${keys(`${base}:record:`).map(name => storage.getItem(name)).join("")}`;
      if (fingerprint !== lastChange) { lastChange = fingerprint; emit(true); }
    }
    globalThis.addEventListener?.("storage",storageChanged);
    const online = () => { if (mode === "cloud") init(); };
    globalThis.addEventListener?.("online",online);
    return {mode,prefix:base,forProgram,status,subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },init,refresh,login,logout,flush,canStart,sessions,claimSession,conflicts,resolveConflict,isSynced,scanLegacy,importLegacy,backupLegacy,destroy() { globalThis.removeEventListener?.("storage",storageChanged); globalThis.removeEventListener?.("online",online); listeners.clear(); }};
  }
  return {create};
})();
