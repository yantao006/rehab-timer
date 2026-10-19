(() => {
  "use strict";
  const { PROGRAM, JOINT_PROGRAM, programs, GROUP_REST_OPTIONS, planFor, Engine, MediaChannel, cues, cueFor, stageTrack, localDate, monthCells, weeklyCount } = RehabCore;
  const params = new URLSearchParams(location.search);
  const debugMs = Number(params.get("debugMs"));
  const isDebug = Number.isFinite(debugMs) && debugMs >= 20 && debugMs < 1000;
  const unitMs = isDebug ? debugMs : 1000;
  const isTest = isDebug || params.get("test") === "1";
  // Any diagnostic parameter stays isolated, including malformed values.
  const mode = params.has("test") || params.has("debugMs") || location.protocol === "file:" ? "local" : "cloud";
  const basePrefix = isTest ? `rehab-timer:test:v1:${unitMs}` : "rehab-timer:v1";
  const uiKey = `${basePrefix}:ui:v2`;
  const $ = id => document.getElementById(id);
  const text = (id,value) => { if ($(id).textContent !== String(value)) $(id).textContent = value; };
  const showMessage = (id,value) => { text(id,value); $(id).hidden = !value; };
  let storage;
  try { storage = localStorage; } catch { storage = null; }
  let preferredProgram = PROGRAM, preferredGroupRestSeconds = 60;
  try {
    const preference=JSON.parse(storage?.getItem(uiKey)||"null");
    if(programs[preference?.program])preferredProgram=preference.program;
    if(GROUP_REST_OPTIONS.includes(preference?.groupRestSeconds))preferredGroupRestSeconds=preference.groupRestSeconds;
  } catch { /* A preference cannot prevent training. */ }
  let program=preferredProgram, stages=programs[program].stages;
  let prefix=program===PROGRAM?basePrefix:`${basePrefix}:joint`;
  let engine=new Engine(unitMs,program,preferredGroupRestSeconds), plan=engine.plan, view="home", appReady=false, cloudBusy=false;
  let legacyScan=null, backupDownloaded=false, lastCloudLists="", lastManualClick=-Infinity, pendingManualDate=null;
  const events=[];
  const log=(type,detail={})=>{events.push({type,at:performance.now(),...detail});if(events.length>1200)events.shift();};
  const storageWarning=message=>showMessage("storageMessage",message);
  const repository=RehabPersistence.create({
    storage, mode, prefix:basePrefix,
    onChange:()=>{ if(!appReady)return; history=store.history(); if(view==="records")renderCalendar(); render(); renderCloud(); },
    onStatus:status=>{ if(!appReady)return; if(status.conflicts?.some(conflict=>conflict.sessionId===engine.id)&&["running","cue","manual"].includes(engine.state))pause("这次训练的云端写入权或版本已变化，请先处理同步冲突。"); renderCloud(); render(); }
  });
  let store=repository.forProgram(program), history=store.history(), savedCompletion=false;
  function savePreference(){try{storage?.setItem(uiKey,JSON.stringify({program,groupRestSeconds:preferredGroupRestSeconds}));}catch{storageWarning("训练偏好未保存，训练记录不受影响。");}}
      const clock = () => performance.now();
  // Only this page owns these timestamps. Never attach them to an Engine or repository payload.
  const sessionElapsed = new Map();
  let elapsedTimer = null;
  function currentElapsed(){
    const entry=sessionElapsed.get(program);
    return entry&&(entry.id===engine.id||(engine.state==="idle"&&entry.finished))?entry:null;
  }
  function elapsedMilliseconds(entry,wallNow=Date.now(),monoNow=clock()){
    if(!entry.finished)entry.milliseconds=Math.max(entry.milliseconds,wallNow-entry.wallStart,monoNow-entry.monoStart);
    return entry.milliseconds;
  }
  function startElapsed(){
    sessionElapsed.set(program,{id:engine.id,wallStart:Date.now(),monoStart:clock(),milliseconds:0,finished:false,outcome:null});
  }
  function finishElapsed(outcome,milliseconds){
    const entry=currentElapsed();
    if(!entry||entry.finished)return;
    entry.milliseconds=milliseconds??elapsedMilliseconds(entry);entry.finished=true;entry.outcome=outcome;
  }
  function elapsedText(milliseconds){
    const seconds=Math.floor(milliseconds/1000),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);
    return `${hours?`${hours}:`:""}${String(hours?minutes%60:minutes).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`;
  }
  function renderElapsed(){
    clearTimeout(elapsedTimer);elapsedTimer=null;
    const entry=currentElapsed(),hasSession=engine.state!=="idle",value=entry?elapsedText(elapsedMilliseconds(entry)):"未记录";
    const label=entry?.finished?`本次${entry.outcome==="completed"?"已完成":"已结束"} · 整体耗时`:"本次整体耗时";
    const hint=entry?"含暂停、休息和等待；仅本页查看，不保存。":"刷新或换设备后，整体耗时无法恢复。";
    for(const location of ["home","training"]){
      $(`${location}ElapsedPanel`).hidden=!entry&&!hasSession;
      text(`${location}ElapsedLabel`,label);text(`${location}ElapsedValue`,value);text(`${location}ElapsedHint`,hint);
    }
    // An independent display heartbeat must keep running while training is paused or waiting.
    // Absolute timestamps include background/sleep time even when callbacks are throttled.
    if(entry&&!entry.finished&&view!=="records"&&!document.hidden)elapsedTimer=setTimeout(renderElapsed,1000-entry.milliseconds%1000);
  }
      let timer = null, generation = 0, wakeLock = null, beepTimer = null;
      let nextCueIndex = -1, beepIndex = -1, lastSave = "", lastLane = "";
      let pendingBeep = null, soundEnabled = true;
      const issues = new Map();
      let selectedDate = localDate(new Date());
      $("historyDate").value = selectedDate; $("historyDate").max = selectedDate;
      let month = new Date(); month = new Date(month.getFullYear(),month.getMonth(),1,12);
      const warn = (key,message) => { issues.set(key,message); showMessage("compatibilityMessage",[...issues.values()].join(" ")); };
      const soundMessage = message => {
        showMessage("audioStatusText",message);
        showMessage("homeAudioStatus",message);
        text("testSoundButton",message ? "重试声音" : "试听声音");
        text("homeTestSoundButton",message ? "重试声音" : "试听声音");
      };
      // Warm the tiny same-origin recordings once, so later cues need no network round trip.
      // file:// uses the native media loader instead (fetch is often blocked for local files).
      const mediaSources = new Map();
      if (location.protocol !== "file:") for (const key of Object.keys(cues)) {
        fetch(`audio/${key}.wav`).then(response => {
          if (!response.ok) throw new Error("asset unavailable");
          return response.blob();
        }).then(blob => { mediaSources.set(key,URL.createObjectURL(blob)); log("asset-ready",{key,bytes:blob.size}); })
          .catch(() => log("asset-preload-failed",{key}));
      }
      const speaker = new MediaChannel({
        media: $("cueAudio"), sourceFor: key => mediaSources.get(key), now: clock,
        setTimer: (fn,ms) => setTimeout(fn,ms), clearTimer: id => clearTimeout(id),
        warn: soundMessage, recover: () => soundMessage(""),
        onPlaying: (key,elapsed) => {
          if (key === "beep" && elapsed > 150 && engine.state === "running") {
            pause("声音延迟，已暂停。",true); speaker.failed = true;
            soundMessage("声音延迟，请重试声音。");
          }
        }, log
      });
      function playbackSession() {
        // Optional on newer iOS; HTML media playback also works without AudioSession.
        try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* Optional enhancement. */ }
      }
      const trackMedia = $("cueAudio");
      let activeTrack = null;
      let trackStage = -1, resumePosition = null, resumeStage = -1;
      let trackGuard = null, trackWatchdog = null;
      const stageSources = new Map();
      const TRACK_LOAD_TIMEOUT = 12000, TRACK_PROGRESS_TIMEOUT = 8000, POSITION_TOLERANCE = .08;
      const stageSource = (stage,selectedProgram,groupRestSeconds=60) => `audio/stage-${selectedProgram===PROGRAM?"":"joint-"}${stage+1}${stage<4&&groupRestSeconds!==60?`-rest-${groupRestSeconds}`:""}.mp3`;
      function loadSeekableStage(stage,selectedProgram,groupRestSeconds) {
        const src=stageSource(stage,selectedProgram,groupRestSeconds);
        if(location.protocol==="file:")return Promise.resolve(src);
        if(stageSources.has(src))return stageSources.get(src).promise;
        const entry={url:null,promise:null};
        const controller=typeof AbortController==="function"?new AbortController():null;
        let timeout;
        const load=Promise.resolve().then(async()=>{
          const response=await fetch(src,controller?{signal:controller.signal}:{});
          if(!response.ok)throw new Error("stage-resource");
          const blob=await response.blob();
          if(!blob.size)throw new Error("stage-empty");
          return blob;
        });
        const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{controller?.abort();reject(new Error("stage-timeout"));},TRACK_LOAD_TIMEOUT);});
        entry.promise=Promise.race([load,deadline]).then(blob=>{
          clearTimeout(timeout);entry.url=URL.createObjectURL(blob);log("track-cached",{stage,bytes:blob.size});return entry.url;
        }).catch(error=>{clearTimeout(timeout);stageSources.delete(src);throw error;});
        stageSources.set(src,entry);return entry.promise;
      }
      function mediaState(state) {
        if (navigator.mediaSession) navigator.mediaSession.playbackState = state;
      }
      function trackIntent(resuming=false) {
        const stage=engine.interval.stage,groupRestSeconds=engine.groupRestSeconds,track=stageTrack(stage,program,groupRestSeconds),entry=track.entries.find(item=>item.index===engine.index);
        const fresh=engine.remaining===engine.interval.seconds*unitMs;
        const cue=cueFor(engine.interval,engine.index===1||entry===track.entries[0],program);
        const position=resuming&&resumeStage===stage&&Number.isFinite(resumePosition)
          ?resumePosition
          :resuming||!fresh?entry.end-engine.remaining/1000:Math.max(0,entry.start-cues[cue][1]/1000-.25);
        return {stage,program,groupRestSeconds,track,entry,index:engine.index,fresh,position,snapshot:engine.snapshot()};
      }
      function failTrack(reason) {
        const guard=trackGuard;
        if(!guard)return;
        // Never derive recovery from a media position that failed validation.
        const snapshot=guard.snapshot,position=guard.confirmed?guard.lastPosition:guard.position;
        activeTrack=null;trackGuard=null;clearAudio();
        engine.restore(snapshot);engine.reason=reason;resumePosition=position;resumeStage=guard.stage;
        mediaState("paused");releaseWake();checkpoint(true);render();soundMessage(reason);
        log("track-position-rejected",{index:engine.index,position,reason});
      }
      function watchTrackProgress() {
        clearTimeout(trackWatchdog);
        const guard=trackGuard;
        if(!guard)return;
        trackWatchdog=setTimeout(()=>{
          if(trackGuard!==guard)return;
          syncTrack();
          if(trackGuard===guard&&clock()-guard.lastProgressAt>=TRACK_PROGRESS_TIMEOUT)failTrack("音轨未能定位或继续播放，进度已保留，请重试后继续。");
          else if(trackGuard===guard)watchTrackProgress();
        },TRACK_PROGRESS_TIMEOUT);
      }
      function syncTrack() {
        const track=activeTrack,guard=trackGuard;
        if(!track||!guard||!["cue","running"].includes(engine.state)||!guard.playing)return;
        let position=trackMedia.currentTime;
        const now=clock();
        if(!Number.isFinite(position))return;
        if(!guard.confirmed){
          // Some browsers first report zero while a nonzero seek is still pending.
          // Keep the original interval until the target is actually reached.
          if(position<guard.position-POSITION_TOLERANCE)return;
          const permittedAdvance=Math.max(0,(now-guard.playingAt)/1000)+.35;
          if(position>guard.position+permittedAdvance){failTrack("音轨定位发生跳跃，进度已保留，请重试后继续。");return;}
          // Decoder rounding must never add time back to a restored interval.
          position=Math.max(position,guard.position);
          guard.confirmed=true;guard.lastPosition=position;guard.lastObservedAt=now;guard.lastProgressAt=now;
          log("track-position-confirmed",{index:guard.index,position,target:guard.position});
        }else{
          const advance=position-guard.lastPosition,elapsed=(now-guard.lastObservedAt)/1000;
          if(advance< -POSITION_TOLERANCE||elapsed<0||advance>elapsed+.35){failTrack("音轨位置异常，进度已保留，请重试后继续。");return;}
          if(advance<0)return;
          if(advance>.001)guard.lastProgressAt=now;
          guard.lastPosition=position;guard.lastObservedAt=now;
        }
        if(position>=track.end){
          // Let the new plan's short "下一项" finish before releasing its stage track.
          if(program===JOINT_PROGRAM&&position<track.duration-.25)return;
          const finishedStage=trackStage;activeTrack=null;trackGuard=null;clearTimeout(trackWatchdog);trackWatchdog=null;
          if(finishedStage===4&&program===PROGRAM){
            engine.index=plan.length-1;engine.remaining=0;engine.state="finished";
            const date=new Date();engine.completion={version:1,id:engine.id,date:localDate(date),finishedAt:date.toISOString()};finishSave();
          }else{
            engine.index=track.entries[track.entries.length-1].index+1;engine.remaining=engine.interval.seconds*unitMs;engine.state="ready";checkpoint(true);render();
          }
          releaseWake();mediaState("paused");log("track-boundary",{stage:finishedStage});return;
        }
        let entry=track.entries.find(item=>position<item.end);
        // The spoken cue for a skipped rest can overlap the previous interval.
        // Play that cue, but never put the engine back into the skipped interval.
        if(entry.index<guard.index&&position<guard.entry.start)entry=guard.entry;
        if(entry.index<engine.index){failTrack("音轨位置回退，进度已保留，请重试后继续。");return;}
        const changed=engine.index!==entry.index;
        engine.index=entry.index;engine.remaining=Math.min(engine.interval.seconds,entry.end-position)*1000;
        engine.state=position<entry.start?"cue":"running";engine.lastNow=now;engine.deadline=now+engine.remaining;
        guard.snapshot=engine.snapshot();
        if(changed)log("track-interval",{index:entry.index,position,hidden:document.hidden});
        checkpoint();render();
      }
      function startTrack(intent=trackIntent(),source=null) {
        clearAudio();playbackSession();
        trackStage=intent.stage;activeTrack=intent.track;
        const originalSource=stageSource(intent.stage,intent.program,intent.groupRestSeconds);
        const src=source||stageSources.get(originalSource)?.url||originalSource;
        const token=generation;
        const guard={...intent,confirmed:false,playing:false,playingAt:clock(),lastPosition:intent.position,lastObservedAt:clock(),lastProgressAt:clock()};
        trackGuard=guard;resumePosition=null;resumeStage=-1;
        trackMedia.src=src;speaker.loadedKey=null;trackMedia.muted=!soundEnabled;
        trackMedia.playbackRate=1;
        const applyPosition=()=>{
          if(token!==generation||trackGuard!==guard||guard.confirmed)return;
          try{trackMedia.currentTime=intent.position;}catch{ /* Metadata or seeked can settle the same requested position. */ }
        };
        trackMedia.onloadedmetadata=applyPosition;
        trackMedia.onseeked=()=>{if(token===generation&&trackGuard===guard)syncTrack();};
        applyPosition();
        try{
          // New stages still call play synchronously in the initiating user gesture.
          trackMedia.play()?.catch(()=>{if(token===generation)failTrack("声音未播放，进度已保留，请重试声音后继续。");});
        }catch{failTrack("声音未播放，进度已保留，请重试声音后继续。");}
        if(trackGuard!==guard)return;
        if(navigator.mediaSession){try{navigator.mediaSession.metadata=new MediaMetadata({title:"康复训练计时器",artist:stages[trackStage].short});}catch{ /* Optional. */ }}
        mediaState("playing");render();checkpoint(true);requestWake(token);watchTrackProgress();
        log("track-start",{stage:trackStage,position:intent.position,seekableSource:src!==originalSource});
        // Prepare a fully loaded source for later nonzero positioning. This does
        // not delay the gesture-started playback and does not depend on HTTP Range behavior.
        loadSeekableStage(intent.stage,intent.program,intent.groupRestSeconds).catch(()=>log("track-cache-unavailable",{stage:intent.stage}));
      }
      trackMedia.addEventListener("timeupdate",syncTrack);
      trackMedia.addEventListener("ended",syncTrack);
      trackMedia.addEventListener("playing",()=>{
        const guard=trackGuard;if(!activeTrack||!guard)return;
        if(!guard.playing){guard.playing=true;guard.playingAt=clock();}
        soundMessage("");log("track-playing",{position:trackMedia.currentTime});syncTrack();
      });
      trackMedia.addEventListener("pause",()=>{
        if(activeTrack&&trackMedia.paused&&!trackMedia.ended)pause("媒体已暂停，请确认后继续。");
      });
      trackMedia.addEventListener("error",()=>{if(activeTrack)failTrack("音轨加载失败，进度已保留，请重试声音后继续。");});
      trackMedia.addEventListener("waiting",()=>{if(activeTrack)soundMessage("音轨缓冲中，计时随声音等待。");});
      if (navigator.mediaSession) {
        for (const [action,handler] of Object.entries({
          pause:() => pause(), stop:() => pause(),
          play:() => { if (engine.state==="paused" && engine.continue()) enterCue(true,true); }
        })) try { navigator.mediaSession.setActionHandler(action,handler); } catch { /* Optional. */ }
      }
      function clearAudio() {
        activeTrack = null; trackGuard = null; trackMedia.onloadedmetadata = null; trackMedia.onseeked = null;
        clearTimeout(trackWatchdog); trackWatchdog = null;
        try { trackMedia.pause(); } catch { /* Media may already be detached. */ }
        generation++; clearTimeout(timer); timer = null;
        speaker.cancel();
        clearTimeout(beepTimer); beepTimer = null;
        nextCueIndex = -1; beepIndex = -1; pendingBeep = null;
      }
      async function releaseWake() {
        const lock = wakeLock; wakeLock = null;
        if (lock) { try { await lock.release(); } catch { /* Already released by browser. */ } }
      }
      async function requestWake(token) {
        if (wakeLock) return;
        if (!navigator.wakeLock) { warn("wake","无法常亮，请延长锁屏时间。"); return; }
        try {
          const lock = await navigator.wakeLock.request("screen");
          if (token !== generation || !["cue","running"].includes(engine.state)) { await lock.release(); return; }
          wakeLock = lock;
          lock.addEventListener("release",() => { if (wakeLock === lock) wakeLock = null; });
        } catch { warn("wake","无法常亮，请延长锁屏时间。"); }
      }
      function speak(key, retry=false) {
        if (isDebug) { log("test-cue",{key,cue:cues[key][0]}); return Promise.resolve(); }
        if (!soundEnabled) return Promise.resolve();
        if (speaker.job && !retry) {
          speaker.cancel(); speaker.failed = true;
          soundMessage("声音中断，请重试声音。"); log("media-overrun",{key});
          return Promise.resolve();
        }
        return speaker.play(key,retry);
      }
      function beep(at,index) {
        clearTimeout(beepTimer);
        if (!soundEnabled || speaker.failed || isDebug) { log("visual-zero",{index}); return; }
        const token = generation;
        log("beep-scheduled",{index,zero:at});
        beepTimer = setTimeout(() => {
          beepTimer = null;
          if (token !== generation || engine.state !== "running" || document.hidden) return;
          // Do not emit a stale zero after a blocked event loop or page interruption.
          if (clock()-at > 150) { pause("声音延迟，已暂停。",true); return; }
          if (speaker.job) {
            speaker.cancel(); speaker.failed = true;
            soundMessage("语音中断，请重试声音。"); log("media-overrun",{index}); return;
          }
          speaker.play("beep");
          log("beep-request",{index,zero:at,lateMs:clock()-at});
        },Math.max(0,at-clock()));
      }
  function checkpoint(force=false) {
    const snap=engine.snapshot();
    const key=snap?`${snap.id}:${snap.index}:${snap.state}:${Math.ceil(snap.remaining/unitMs)}`:"idle";
    if(force||key!==lastSave){if(store.saveProgress(snap,force))lastSave=key;}
  }
  function finishSave() {
    finishElapsed("completed");
    store.saveProgress(engine.snapshot(),true);
    savedCompletion=store.complete(engine.completion);
    if(savedCompletion){store.saveProgress(null);history=store.history();}
    renderCalendar();render();
  }
  function recordName(record){return record.source==="manual"?"手动补记":record.source==="legacy"?"导入的完成记录":"完整训练";}
  function renderCalendar() {
    const today=new Date();
    text("monthTitle",`${month.getFullYear()} 年 ${month.getMonth()+1} 月`);
    text("calendarTitle",`${program===PROGRAM?"原计划":"下肢关节居家训练"} · 记录`);
    text("weeklySummary",`本周共享 ${weeklyCount(history,today)} 次${program===PROGRAM?" · 每周 3-4 次":""}`);
    $("historyDate").value=selectedDate;$("historyDate").max=localDate(today);
    const grid=$("calendarGrid");grid.replaceChildren();
    for(const day of ["一","二","三","四","五","六","日"]){const el=document.createElement("span");el.className="weekday";el.textContent=day;el.setAttribute("aria-hidden","true");grid.append(el);}
    for(const cell of monthCells(month.getFullYear(),month.getMonth(),history,today)){
      const el=document.createElement(cell?"button":"div");
      if(!cell){el.setAttribute("aria-hidden","true");grid.append(el);continue;}
      el.type="button";el.disabled=cell.date>localDate(today);el.className="calendar-day";el.dataset.complete=cell.complete;el.dataset.date=cell.date;
      el.setAttribute("aria-pressed",String(cell.date===selectedDate));
      el.setAttribute("aria-label",`${cell.date}${cell.today?"，今天":""}${cell.complete?"，已完成训练":"，无完成记录"}`);
      if(cell.today)el.setAttribute("aria-current","date");
      el.addEventListener("click",()=>{selectedDate=cell.date;renderCalendar();const selected=grid.querySelector(`[data-date="${selectedDate}"]`);selected?.focus({preventScroll:true});});
      const number=document.createElement("span");number.textContent=cell.day;el.append(number);
      if(cell.today||cell.complete){const label=document.createElement("small");label.textContent=cell.today?(cell.complete?"今天\n完成":"今天"):"完成";el.append(label);}grid.append(el);
    }
    const daily=history.filter(record=>record.date===selectedDate).sort((a,b)=>String(a.finishedAt).localeCompare(String(b.finishedAt)));
    text("dateDetailsTitle",`${selectedDate} · ${daily.length} 次完成`);
    const list=$("dateRecords");list.replaceChildren();
    if(!daily.length){const empty=document.createElement("p");empty.className="muted-note";empty.textContent="这一天还没有完成记录。";list.append(empty);}
    for(const record of daily){
      const row=document.createElement("div");row.className="record-row";
      const copy=document.createElement("div"),title=document.createElement("p"),detail=document.createElement("small"),revoke=document.createElement("button");
      title.textContent=recordName(record);
      const finished=new Date(record.finishedAt);detail.textContent=record.source==="manual"?"补记的完整训练":Number.isFinite(finished.getTime())?`${String(finished.getHours()).padStart(2,"0")}:${String(finished.getMinutes()).padStart(2,"0")} 完成`:"完成时间已保留";
      copy.append(title,detail);revoke.type="button";revoke.className="text-button";revoke.textContent="撤销这条";revoke.setAttribute("aria-label",`撤销 ${selectedDate} 的${recordName(record)}`);
      let awaitingConfirmation=false;
      revoke.addEventListener("click",()=>{
        if(!awaitingConfirmation){awaitingConfirmation=true;revoke.textContent="确认撤销";detail.textContent="只撤销这条，其他记录保留。";return;}
        if(store.revoke(record.id)){history=store.history();renderCalendar();text("historyStatus",mode==="local"?"这条记录已撤销，原始数据保留。":"撤销已保留，正在同步；不影响同日其他记录。");}else storageWarning("撤销未保存，请重试。");
      });row.append(copy,revoke);list.append(row);
    }
    if(pendingManualDate!==selectedDate)pendingManualDate=null;
    $("markDate").disabled=selectedDate>localDate(today);
    text("markDate",pendingManualDate?"确认补记一次完整训练":"补记一次完成");
    text("historyStatus",`${selectedDate} · ${daily.length?`${daily.length} 次完成`:"未标记完成"}`);
  }
  function stagePoints(){
    const active=engine.state==="idle"?0:engine.interval.stage;
    [...$("stageProgress").children].forEach((el,i)=>{
      const state=engine.state==="finished"||i<active?"complete":i===active?"current":"pending";el.dataset.state=state;
      if(state==="current")el.setAttribute("aria-current","step");else el.removeAttribute("aria-current");
      const label={complete:"已完成",current:engine.state==="idle"?"待开始":"当前项",pending:"待进行"}[state];
      el.querySelector(".stage-status").textContent=label;el.setAttribute("aria-label",`${i+1}，${stages[i].name}${stages[i].equipment?`，${stages[i].equipment}`:""}，${label}`);
    });
  }
  function lanes(){
    const item=engine.interval,key=`${engine.index}:${engine.state}`;if(lastLane===key)return;lastLane=key;
    const root=$("laneProgress");root.replaceChildren();
    const groups=item.stage===4&&program===PROGRAM?[1]:[1,2];
    for(const group of groups){
      const label=document.createElement("span");label.className="lane-label";label.textContent=item.stage===4&&program===PROGRAM?"四轮动作":`第 ${group} 组`;
      const cells=document.createElement("div");cells.className="lane-cells";
      const works=plan.filter(p=>p.stage===item.stage&&(program===PROGRAM&&item.stage===4?["work","stretch"].includes(p.kind):p.group===group&&["work","manual"].includes(p.kind)));
      cells.style.gridTemplateColumns=`repeat(${works.length},minmax(0,1fr))`;
      for(const work of works){const cell=document.createElement("span");cell.className="lane-cell";cell.setAttribute("aria-hidden","true");cell.dataset.state=engine.state==="finished"||work.index<engine.index?"complete":work.index===engine.index&&!["ready","cue"].includes(engine.state)?"active":"pending";cells.append(cell);}root.append(label,cells);
    }
  }
  function nextText(){
    const item=engine.interval,next=plan[engine.index+1];if(!next)return "接着：完成";
    if(next.stage!==item.stage)return "接着：下一项就位";if(item.kind==="prep")return `接着：${stages[0].short}`;
    if(program===PROGRAM&&next.stage===4)return `接着：${next.kind==="round-rest"?"轮间休息":next.kind==="stretch"?"拉伸":"踮脚"}`;
    if(item.kind==="manual")return "完成本组后，准备下一组";
    return `接着：${next.kind==="stage-rest"?"节间休息":next.kind==="group-rest"?"组间休息":next.kind==="rest"?"休息":"训练"}`;
  }
  function renderCompletion(){
    if(engine.state!=="finished")return;
    const synced=savedCompletion&&repository.isSynced(program,engine.id);
    text("finishedMeta",`${program===PROGRAM?"原计划":"下肢关节居家训练"} · ${engine.completion?.date||localDate(new Date())}`);
    text("completionStatus",!savedCompletion?"记录尚未保存":mode==="local"?"记录已保存在隔离预览":synced?"记录已同步到云端":"训练已完成，记录等待同步");
    text("completionHint",!savedCompletion?"请重试保存。结束或返回不会假装保存成功。":mode==="local"?"这是本地隔离记录，不会写入正式云端。":synced?"其他设备打开后可查看这次完成。":"已保留在本设备。联网后会自动重试，请不要清除浏览器数据。");
    $("retrySaveButton").hidden=savedCompletion&&synced;
    text("retrySaveButton",savedCompletion?"重试同步":"重试保存记录");
  }
  function timedDuration(){
    const seconds=plan.reduce((sum,item)=>sum+item.seconds,0),minutes=Math.floor(seconds/60),remainder=seconds%60;
    return `${minutes} 分${remainder?` ${remainder} 秒`:""}`;
  }
  function syncPlan(){
    if(engine.id&&sessionElapsed.get(program)?.id!==engine.id)sessionElapsed.delete(program);
    plan=engine.plan;lastLane="";renderProgramDetails();
  }
  function restSelectionLocked(){return !["idle","finished"].includes(engine.state)||(engine.state==="finished"&&!savedCompletion);}
  function prepareHomeTraining(){
    if(view!=="home"||engine.state!=="finished"||!savedCompletion)return;
    engine=new Engine(unitMs,program,preferredGroupRestSeconds);savedCompletion=false;lastSave="";resumePosition=null;resumeStage=-1;syncPlan();
  }
  function render(){
    const previousFocus=document.activeElement;
    const state=engine.state,item=engine.interval,hasProgress=!["idle","finished"].includes(state),manualReady=state==="ready"&&item.kind==="manual"&&item.group===2;
    $("appShell").dataset.view=view;
    $("siteHeader").hidden=view==="training";$("planSelector").hidden=view==="training";
    $("homeView").hidden=view!=="home";$("trainingView").hidden=view!=="training";$("recordsView").hidden=view!=="records";
    $("mainNav").hidden=view==="training";$("pageFooter").hidden=view==="training";$("actionDock").hidden=view!=="training";
    for(const [id,current]of [["homeNav",view==="home"],["recordsNav",view==="records"]]){if(current)$(id).setAttribute("aria-current","page");else $(id).removeAttribute("aria-current");}
    $("resumePanel").hidden=!hasProgress;$("idlePanel").hidden=hasProgress;
    text("homePlanMeta",`5 项动作 · 计时 ${timedDuration()}${program===JOINT_PROGRAM?" + 手动动作":""}`);
    $("groupRestSelect").value=String(engine.groupRestSeconds);$("groupRestSelect").disabled=restSelectionLocked();
    text("groupRestHint",hasProgress?"本次训练已锁定，结束后可更改。":engine.state==="finished"&&!savedCompletion?"请先保存这次完成记录，再更改休息时间。":"前四项两组之间，可跳过；两套计划共用此偏好。");
    if(hasProgress){text("resumeTitle",`${item.stage+1}. ${stages[item.stage].name}`);text("resumeMeta",state==="ready"?(manualReady?"第 1 组已完成，等待开始第 2 组。":"上一项已完成，等待下一项就位。"):item.kind==="manual"?`第 ${item.group}/2 组 · 8 到 10 次，进度已保留。`:`当前段还剩 ${Math.ceil(engine.remaining/unitMs)} 秒，进度已保留。`);}
    $("runningPanel").hidden=state==="idle"||state==="finished";$("finishedPanel").hidden=state!=="finished";
    stagePoints();text("trainingPlanLabel",`${program===PROGRAM?"原计划":"下肢关节居家训练"} · ${item.stage+1}/5 项`);
    showMessage("runtimeMessage",state==="paused"?engine.reason:"");
    text("exerciseName",stages[item.stage].name);text("exerciseMeta",stages[item.stage].equipment?`器材：${stages[item.stage].equipment}`:"");$("exerciseMeta").hidden=!stages[item.stage].equipment;
    const phase=program===PROGRAM&&item.stage===4&&item.kind==="work"?"踮脚":{prep:"准备",work:"训练",rest:"休息","group-rest":"组间休息","round-rest":"轮间休息","stage-rest":"节间休息",manual:"训练",stretch:"拉伸"}[item.kind];
    $("scoreboard").dataset.state=state;$("positionCopy").hidden=state==="finished";
    text("phaseName",state==="ready"?(manualReady?"下一组就位":"下一项就位"):state==="paused"?"已暂停":state==="cue"?"准备开始":phase);
    text("positionCopy",item.kind==="manual"?`第 ${item.group}/2 组 · 8 到 10 次`:program===PROGRAM&&item.stage===4?`第 ${item.round}/4 轮${item.kind==="round-rest"?"已完成":""}`:item.kind==="prep"?"第一项尚未开始":item.kind==="stage-rest"?"下一节即将开始":`第 ${item.group}/2 组 · 第 ${item.rep}/6 次${["rest","group-rest"].includes(item.kind)?"已完成":""}`);
    text("countdown",item.kind==="manual"?"8-10":String(Math.max(0,Math.ceil(engine.remaining/unitMs-1e-6))));
    text("countdownUnit",state==="ready"?(item.kind==="manual"?"次 / 组 · 确认后开始":"秒 · 确认后开始"):item.kind==="manual"?"次 / 组 · 不计时":state==="cue"?"秒 · 提示音后计时":state==="paused"?"秒 · 剩余时间已保留":"秒");
    $("nextCue").hidden=["finished","ready","paused"].includes(state);text("nextCue",nextText());
    const conflicted=repository.conflicts().some(conflict=>conflict.sessionId===engine.id);
    $("continueButton").disabled=conflicted;$("completeButton").disabled=conflicted;
    $("continueButton").hidden=!["paused","ready"].includes(state);text("continueButton",state==="ready"?(manualReady?"准备好了，开始第 2 组":"准备好了，开始下一项"):"继续训练");
    $("pauseButton").hidden=!["running","cue"].includes(state);$("completeButton").hidden=state!=="manual";$("manualPauseButton").hidden=state!=="manual";text("completeButton",`完成第 ${item.group||1} 组`);
    $("skipPrepButton").hidden=state!=="running"||item.kind!=="prep";$("skipRestButton").hidden=state!=="running"||!["group-rest","round-rest"].includes(item.kind);
    text("skipRestButton",item.kind==="round-rest"?"跳过轮间休息":"跳过休息");
    $("finishedRecordsButton").hidden=state!=="finished";$("finishedHomeButton").hidden=state!=="finished";
    for(const id of ["soundButton","testSoundButton","resetButton"])$(id).hidden=state==="finished";
    $("normalActions").hidden=!$("resetConfirm").hidden;
    renderCompletion();renderElapsed();lanes();
    if(view==="training"&&previousFocus?.hidden)primaryButton()?.focus({preventScroll:true});
  }
  function setView(next,{focus=false}={}){
    if(next!=="training"){pause();if(engine.state==="ready")checkpoint(true);}
    view=next;prepareHomeTraining();$("resetConfirm").hidden=true;$("cloudPanel").hidden=true;$("openCloudButton").setAttribute("aria-expanded","false");
    render();if(next==="records")renderCalendar();window.scrollTo?.({top:0,behavior:"auto"});
    if(focus){const target=next==="home"?(!$("resumePanel").hidden?$("resumeButton"):$("startButton")):next==="records"?$("prevMonth"):primaryButton();target?.focus({preventScroll:true});}
  }
  function primaryButton(){return ["continueButton","pauseButton","completeButton","finishedRecordsButton"].map($).find(button=>!button.hidden);}
      function pause(reason="", conservative=false) {
        if (activeTrack) {
          syncTrack();
          if(trackGuard){
            resumePosition=trackGuard.confirmed?trackGuard.lastPosition:trackGuard.position;
            resumeStage=trackGuard.stage;
          }
        }
        if (!engine.pause(conservative && engine.state==="running"?engine.lastNow:clock())) return;
        engine.reason = reason; clearAudio(); mediaState("paused"); releaseWake(); checkpoint(true); render();
        log("paused",{index:engine.index,remaining:engine.remaining,reason});
      }
      async function enterCue(resuming=false, gesture=false) {
        if (!isDebug) {
          if (engine.interval.kind === "manual") {
            clearAudio(); playbackSession(); engine.state = "manual";
            checkpoint(true); render(); speak(cueFor(engine.interval,true,program),gesture); return;
          }
          const intent=trackIntent(resuming);
          if(resuming||intent.position>POSITION_TOLERANCE){
            // The short cue below already announces this interval. If its work has
            // not begun, join the zero beep instead of replaying an old announcement.
            // Once work has begun, preserve the exact partial-interval position.
            if(intent.fresh){
              const zeroLead=Math.max(0,intent.entry.start-.25);
              if(!resuming||intent.position<zeroLead)intent.position=zeroLead;
            }
            clearAudio();playbackSession();
            const token=generation;
            resumePosition=intent.position;resumeStage=intent.stage;
            trackMedia.muted=!soundEnabled;
            // Even with sound muted, establish media permission synchronously.
            // Loading the complete stage in parallel avoids browser-specific seek behavior.
            const playing=speaker.play(cueFor(engine.interval,true,program),gesture);
            const loading=loadSeekableStage(intent.stage,intent.program,intent.groupRestSeconds);
            render();checkpoint(true);
            try{
              const [result,source]=await Promise.all([playing,loading]);
              if(token!==generation||engine.state!=="cue")return;
              if(result!=="ended")throw new Error("cue-unavailable");
              startTrack(intent,source);
            }catch{
              if(token!==generation||engine.state!=="cue")return;
              pause("音轨未准备好，进度已保留，请重试声音后继续。");
              soundMessage("音轨未准备好，请重试声音后继续。");
            }
            return;
          }
          startTrack(intent);return;
        }
        if (engine.interval.kind === "manual") {
          clearAudio(); engine.state = "manual"; checkpoint(true); render(); log("manual-start",{index:engine.index}); return;
        }
        clearAudio(); const token = generation;
        const item = engine.interval;
        if (gesture) playbackSession();
        // No await or asynchronous initialization before the first media.play in a click.
        const playing = speak(cueFor(item,!resuming,program),gesture);
        render(); checkpoint(true); requestWake(token);
        await playing;
        if (token!==generation || engine.state!=="cue") return;
        const zero = clock()+40;
        beep(zero,item.index); engine.arm(zero); checkpoint(true); render();
        log("interval-start",{index:item.index,kind:item.kind,stage:item.stage,zero});
        timer = setTimeout(pump,Math.max(8,zero-clock()+8));
      }
      function pump() {
        clearTimeout(timer);
        if (engine.state!=="running") return;
        const now = clock();
        const result = engine.tick(now,new Date());
        if (result === "late") { clearAudio(); releaseWake(); checkpoint(true); render(); log("late-paused"); return; }
        if (result === "finished") {
          clearAudio(); releaseWake(); finishSave(); speak("complete"); log("session-finished",{id:engine.id,date:engine.completion.date,saved:savedCompletion}); return;
        }
        if (result === "ready") {
          clearAudio(); releaseWake(); checkpoint(true); render();
          speak("next");
          log("stage-ready",{stage:engine.interval.stage}); return;
        }
        if (result === "cue") { enterCue(); return; }
        if (result === "interval") {
          if (beepIndex !== engine.index) beep(engine.deadline-engine.interval.seconds*unitMs,engine.index);
          log("interval-start",{index:engine.index,kind:engine.interval.kind,stage:engine.interval.stage,zero:engine.deadline-engine.interval.seconds*unitMs});
          nextCueIndex = -1; pendingBeep = null;
        }
        const next = plan[engine.index+1];
        const automatic = next && next.stage===engine.interval.stage && engine.interval.kind!=="prep";
        if (automatic) {
          const cue = cueFor(next,false,program);
          // Allow media startup plus the 250ms heartbeat before the fixed boundary.
          // Production observed a 718ms decoder start even with a preloaded local Blob.
          const lead = isDebug?0:cues[cue][1]+1000;
          if (engine.remaining<=lead && nextCueIndex!==next.index) { nextCueIndex=next.index; speak(cue); }
          // Only arm the immediately upcoming beep close to its boundary.
          if (engine.remaining<=Math.min(350,unitMs) && beepIndex!==next.index) {
            beepIndex=next.index; pendingBeep=engine.deadline; beep(engine.deadline,next.index);
          }
        }
        render(); checkpoint();
        // Second-boundary display ticks with a bounded foreground heartbeat, never RAF/count-based elapsed time.
        const toSecond = engine.remaining%unitMs || unitMs;
        timer = setTimeout(pump,Math.max(8,Math.min(250,toSecond,engine.remaining)));
      }
  function openCloud(){
    if(view==="training")setView("home");
    $("cloudPanel").hidden=false;$("openCloudButton").setAttribute("aria-expanded","true");renderCloud(true);
    $("cloudTitle").scrollIntoView?.({block:"start",behavior:"auto"});
  }
  function renderCloud(force=false){
    const status=repository.status(),labels={loading:"读取云端中",synced:mode==="local"?"隔离预览记录":"已同步",pending:"等待同步",offline:"离线，进度保留",error:"同步未完成",conflict:"有同步冲突"};
    text("syncSummary",labels[status.state]||"记录状态");$("openCloudButton").dataset.state=status.state;
    text("cloudStatus",mode==="local"?"当前为本地隔离预览，所有记录与正式云端分开，不会联网同步。":status.message||labels[status.state]||"正在检查同步状态。");
    $("syncRetryButton").hidden=mode==="local";
    $("syncRetryButton").disabled=cloudBusy||status.state==="loading";
    $("remoteDetails").hidden=mode!=="cloud";$("migrationDetails").hidden=mode!=="cloud";
    text("persistenceNote",mode==="local"?"本地隔离预览，不会写入正式云端记录。":"云端共享记录；本设备保留恢复进度和待同步记录。");
    if($("cloudPanel").hidden&&!force)return;
    const conflicts=repository.conflicts(),sessions=repository.sessions();
    const listKey=JSON.stringify({conflicts,sessions});if(!force&&lastCloudLists===listKey)return;lastCloudLists=listKey;
    $("conflictPanel").hidden=!conflicts.length;const conflictList=$("conflictList");conflictList.replaceChildren();
    for(const conflict of conflicts){
      const row=document.createElement("div");row.className="conflict-row";const title=document.createElement("h4"),description=document.createElement("p"),actions=document.createElement("div");actions.className="cloud-actions";
      title.textContent=conflict.program===JOINT_PROGRAM?"下肢关节居家训练":"原计划";description.textContent=conflict.message||"这次训练在其他设备上有更新。请选择保留哪一份。";
      const useCloud=document.createElement("button");useCloud.type="button";useCloud.className="control";useCloud.textContent="采用云端版本";
      useCloud.addEventListener("click",()=>resolveConflict(conflict,"cloud",useCloud));actions.append(useCloud);
      if(conflict.canCopy){const copy=document.createElement("button");copy.type="button";copy.className="control";copy.textContent="本地完成另存为一次";copy.addEventListener("click",()=>resolveConflict(conflict,"copy",copy));actions.append(copy);}
      row.append(title,description,actions);conflictList.append(row);
    }
    const remote=$("remoteSessions");remote.replaceChildren();
    const resumable=sessions.filter(session=>!["finished","completed","abandoned"].includes(session.status)&&session.snapshot&&programs[session.program]);
    if(!resumable.length){const empty=document.createElement("p");empty.className="muted-note";empty.textContent="没有其他可恢复的训练。";remote.append(empty);}
    for(const session of resumable){
      const row=document.createElement("div");row.className="remote-row";const heading=document.createElement("h4"),detail=document.createElement("p"),button=document.createElement("button");
      const schedule=programs[session.program],item=planFor(session.program,session.snapshot.groupRestSeconds??60)[session.snapshot.index],own=repository.forProgram(session.program).loadProgress()?.id===session.id;
      heading.textContent=session.program===JOINT_PROGRAM?"下肢关节居家训练":"原计划";
      detail.textContent=item?`第 ${item.stage+1} 项 · ${schedule.stages[item.stage].name}，组间休息 ${session.snapshot.groupRestSeconds??60} 秒，${session.snapshot.state==="ready"?"等待就位":"恢复后保持暂停"}。`:"可恢复进度，需明确确认后继续。";
      button.type="button";button.className="control";button.textContent=own?"查看本设备进度":"选择在本设备恢复";
      let confirm=false;
      button.addEventListener("click",()=>{
        if(own){activateProgram(session.program);setView("training",{focus:true});return;}
        if(!confirm){confirm=true;button.textContent="确认恢复并取得写入权";detail.textContent+=" 另一设备继续同步时会看到冲突提示。";return;}
        claimRemote(session,button);
      });row.append(heading,detail,button);remote.append(row);
    }
  }
  async function runCloudAction(button,action){
    if(cloudBusy)return;cloudBusy=true;if(button)button.disabled=true;showMessage("cloudActionMessage","");
    try{await action();}catch(error){showMessage("cloudActionMessage",error?.message||"操作未完成，请检查网络后重试。");}
    finally{cloudBusy=false;if(button)button.disabled=false;renderCloud(true);renderCompletion();}
  }
  async function resolveConflict(conflict,choice,button){
    if(button.dataset.confirm!=="true"){button.dataset.confirm="true";button.textContent=choice==="cloud"?"确认采用云端版本":"确认另记一次完成";return;}
    pause("正在处理同步冲突，已暂停。");
    await runCloudAction(button,async()=>{
      const resolved=await repository.resolveConflict(conflict.id,choice);if(!resolved)throw new Error("这项冲突已变化，请刷新后核对。");activateProgram(program);renderCalendar();render();
      showMessage("cloudActionMessage",choice==="cloud"?"已采用云端版本，本地原数据由同步层保留。":"本地完成已另存为独立会话，请核对共享记录。");
    });
  }
  async function claimRemote(session,button){
    const local=repository.forProgram(session.program).loadProgress();
    if(local&&local.id!==session.id&&local.state!=="finished"){showMessage("cloudActionMessage","这个计划在本设备还有未完成训练，请先查看并明确结束，再恢复云端进度。");return;}
    pause("准备恢复云端进度，当前训练已暂停。");
    await runCloudAction(button,async()=>{
      const snapshot=await repository.claimSession(session.id,session.program);
      activateProgram(session.program);
      if(!engine.restore(snapshot))throw new Error("云端进度与当前计划不兼容，尚未开始训练。");
      syncPlan();
      $("cloudPanel").hidden=true;setView("training",{focus:true});
    });
  }
  function restoreProgress(){
    const snapshot=store.loadProgress();if(snapshot===null)return;
    if(!engine.restore(snapshot)){showMessage("storageMessage","进度无法恢复，原数据和历史保留。");return;}
    syncPlan();
    const existing=history.find(record=>record.id===engine.id||record.sessionId===engine.id);
    if(existing){engine.index=plan.length-1;engine.remaining=0;engine.state="finished";engine.completion=existing;savedCompletion=true;store.saveProgress(null);}
    else if(engine.state==="finished")finishSave();
  }
  function renderProgramDetails(){
    $("stageProgress").replaceChildren();$("routineList").replaceChildren();
    stages.forEach((stage,i)=>{
      const point=document.createElement("li");point.className="stage-point";point.innerHTML='<span class="stage-number"></span><span class="stage-label"></span><span class="stage-status"></span>';
      point.querySelector(".stage-number").textContent=i+1;point.querySelector(".stage-label").textContent=stage.short;$("stageProgress").append(point);
      const line=document.createElement("li"),name=document.createElement("span"),dose=document.createElement("span");name.className="routine-name";dose.className="routine-dose";
      name.textContent=`${stage.name}${stage.equipment?` · ${stage.equipment}`:""}`;
      dose.textContent=program===PROGRAM?(i<4?`训练 15 秒 / 重复间休息 5 秒，6 次 × 2 组；组间休息 ${engine.groupRestSeconds} 秒，可跳过。`:"踮脚 30 秒接拉伸 30 秒为一轮，共 4 轮；前三轮结束后休息 30 秒，可跳过，第 4 轮后直接完成。"):(i<4?`训练 15 秒 / 重复间休息 5 秒，6 次 × 2 组；组间休息 ${engine.groupRestSeconds} 秒可跳过，节间休息 60 秒。`:"每组 8 到 10 次，共 2 组。逐组点完成，不计时。");
      line.append(name,dose);$("routineList").append(line);
    });
    for(const [id,selected]of [["originalTab",program===PROGRAM],["jointTab",program===JOINT_PROGRAM]]){$(id).setAttribute("aria-selected",String(selected));$(id).tabIndex=selected?0:-1;}
    $("planContent").setAttribute("aria-labelledby",program===PROGRAM?"originalTab":"jointTab");
  }
  function activateProgram(nextProgram){
    clearAudio();releaseWake();mediaState("paused");
    program=nextProgram;stages=programs[program].stages;prefix=program===PROGRAM?basePrefix:`${basePrefix}:joint`;
    store=repository.forProgram(program);engine=new Engine(unitMs,program,preferredGroupRestSeconds);history=store.history();savedCompletion=false;lastSave="";lastLane="";resumePosition=null;resumeStage=-1;
    $("resetConfirm").hidden=true;showMessage("runtimeMessage","");savePreference();syncPlan();restoreProgress();prepareHomeTraining();render();renderCalendar();
  }
  function chooseProgram(nextProgram){
    if(program===nextProgram)return;
    pause("切换计划，当前进度已保留。");
    if(!["idle","finished"].includes(engine.state)&&!store.saveProgress(engine.snapshot(),true)){storageWarning("当前进度未保存，请先重试，暂未切换计划。");return;}
    if(engine.state==="finished"&&!savedCompletion){storageWarning("完成记录尚未保留，请先重试保存。");return;}
    activateProgram(nextProgram);if(view==="training")setView("home");log("plan-selected",{program});
  }
  function requestReset(){
    pause();clearAudio();view="training";$("resetConfirm").hidden=false;render();$("cancelResetButton").focus();
  }
  function renderSound(){
    for(const id of ["soundButton","homeSoundButton"]){$(id).setAttribute("aria-pressed",String(soundEnabled));text(id,`声音：${soundEnabled?"开":"关"}`);}
  }
  function testSound(){
    pause();speaker.cancel();clearTimeout(beepTimer);beepTimer=null;soundEnabled=true;renderSound();
    playbackSession();trackMedia.muted=false;speaker.play("test",true);
  }
  function toggleSound(){
    if(!soundEnabled){testSound();return;}
    soundEnabled=false;trackMedia.muted=true;
    // A muted training cue must finish normally to complete its stage-track handoff.
    if(!activeTrack&&(isDebug||engine.state!=="cue"))speaker.cancel();
    clearTimeout(beepTimer);beepTimer=null;renderSound();soundMessage("");log("sound-off");
  }
  $("groupRestSelect").addEventListener("change",()=>{
    const selected=Number($("groupRestSelect").value);
    if(restSelectionLocked()||!GROUP_REST_OPTIONS.includes(selected)){render();return;}
    preferredGroupRestSeconds=selected;savePreference();
    engine=new Engine(unitMs,program,preferredGroupRestSeconds);savedCompletion=false;lastSave="";resumePosition=null;resumeStage=-1;
    syncPlan();render();log("group-rest-selected",{seconds:selected});
  });
  $("startButton").addEventListener("click",()=>{
    if(!repository.canStart()){showMessage("startMessage",mode==="cloud"?"正在连接共享记录，请联网后重试。已有暂停进度仍可继续。":"本地保存不可用，请检查浏览器存储后重试。");openCloud();return;}
    if(engine.state==="finished"){
      if(!savedCompletion){showMessage("startMessage","上一条完成记录尚未保留，请先重试保存。");view="training";render();return;}
      engine=new Engine(unitMs,program,preferredGroupRestSeconds);savedCompletion=false;syncPlan();
    }
    const id=window.crypto?.randomUUID?.()||`session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if(!engine.start(id))return;startElapsed();resumePosition=null;resumeStage=-1;view="training";savedCompletion=false;showMessage("startMessage","");showMessage("runtimeMessage","");
    enterCue(false,true);window.scrollTo?.({top:0,behavior:"auto"});primaryButton()?.focus({preventScroll:true});
  });
  $("resumeButton").addEventListener("click",()=>setView("training",{focus:true}));
  $("continueButton").addEventListener("click",()=>{
    const resuming=engine.state==="paused";if(!engine.continue())return;$("resetConfirm").hidden=true;enterCue(resuming,true);primaryButton()?.focus({preventScroll:true});
  });
  for(const id of ["pauseButton","manualPauseButton"])$(id).addEventListener("click",()=>{pause();$("continueButton").focus({preventScroll:true});});
  $("completeButton").addEventListener("click",()=>{
    if(engine.state!=="manual"||clock()-lastManualClick<600)return;lastManualClick=clock();
    const result=engine.completeManual(new Date());if(!result)return;
    if(result==="finished"){finishSave();speaker.cancel();speak("complete");log("session-finished",{id:engine.id,saved:savedCompletion});}
    else{clearAudio();checkpoint(true);render();log("manual-ready",{index:engine.index});}
    primaryButton()?.focus({preventScroll:true});
  });
  for(const id of ["testSoundButton","homeTestSoundButton"])$(id).addEventListener("click",testSound);
  for(const id of ["soundButton","homeSoundButton"])$(id).addEventListener("click",toggleSound);
  for(const id of ["skipPrepButton","skipRestButton"])$(id).addEventListener("click",()=>{
    const kind=engine.interval.kind;
    if(engine.state!=="running"||(id==="skipPrepButton"?kind!=="prep":!["group-rest","round-rest"].includes(kind)))return;
    if(activeTrack)syncTrack();
    if(engine.skip(kind,clock())){log("rest-skipped",{kind,index:engine.index});enterCue(false,true);}
    else{clearAudio();if(engine.state==="cue")enterCue();else{if(engine.state==="running")pause("阶段已变化，请确认后继续。",true);checkpoint(true);render();}}
  });
  $("resetButton").addEventListener("click",requestReset);$("homeResetButton").addEventListener("click",requestReset);
  $("cancelResetButton").addEventListener("click",()=>{$("resetConfirm").hidden=true;render();primaryButton()?.focus({preventScroll:true});});
  $("confirmResetButton").addEventListener("click",()=>{
    const entry=currentElapsed(),elapsedAtClick=entry?elapsedMilliseconds(entry):null;
    if(engine.state==="finished"&&!savedCompletion){showMessage("storageMessage","完成记录尚未保存，请重试保存后返回。");$("resetConfirm").hidden=true;render();return;}
    if(!store.saveProgress(null)){storageWarning("进度未清除，仍保留当前训练。");return;}
    finishElapsed("ended",elapsedAtClick);
    clearAudio();releaseWake();engine=new Engine(unitMs,program,preferredGroupRestSeconds);syncPlan();resumePosition=null;resumeStage=-1;lastSave="";savedCompletion=false;$("resetConfirm").hidden=true;setView("home",{focus:true});log("reset");
  });
  $("retrySaveButton").addEventListener("click",()=>{showMessage("storageMessage","");if(!savedCompletion)finishSave();else runCloudAction($("retrySaveButton"),()=>repository.flush());});
  $("homeNav").addEventListener("click",()=>setView("home"));$("recordsNav").addEventListener("click",()=>setView("records"));
  $("backTrainingButton").addEventListener("click",()=>setView("home",{focus:true}));
  $("finishedRecordsButton").addEventListener("click",()=>setView("records",{focus:true}));$("finishedHomeButton").addEventListener("click",()=>setView("home",{focus:true}));
  for(const [id,offset]of [["prevMonth",-1],["nextMonth",1]])$(id).addEventListener("click",()=>{month=new Date(month.getFullYear(),month.getMonth()+offset,1,12);renderCalendar();});
  $("historyDate").addEventListener("change",()=>{if(!$("historyDate").checkValidity()){$("historyDate").reportValidity();return;}selectedDate=$("historyDate").value;const[y,m]=selectedDate.split("-").map(Number);month=new Date(y,m-1,1,12);renderCalendar();});
  $("markDate").addEventListener("click",()=>{
    if(!$("historyDate").checkValidity()){$("historyDate").reportValidity();return;}
    selectedDate=$("historyDate").value;
    if(pendingManualDate!==selectedDate){pendingManualDate=selectedDate;text("markDate","确认补记一次完整训练");text("historyStatus",`为 ${selectedDate} 补记当前计划的一次完整训练？已有记录保持不变。`);return;}
    pendingManualDate=null;
    if(store.addManual(selectedDate)){history=store.history();renderCalendar();text("historyStatus",mode==="local"?`${selectedDate} · 补记已保存在隔离预览`:`${selectedDate} · 补记已保留，等待同步`);}else{text("markDate","补记一次完成");storageWarning("补记未保存，请检查存储后重试。");}
  });
  for(const [id,value]of [["originalTab",PROGRAM],["jointTab",JOINT_PROGRAM]]){
    $(id).addEventListener("click",()=>chooseProgram(value));
    $(id).addEventListener("keydown",event=>{
      if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;event.preventDefault();
      const target=event.key==="Home"?"originalTab":event.key==="End"?"jointTab":id==="originalTab"?"jointTab":"originalTab";
      $(id).tabIndex=-1;$(target).tabIndex=0;$(target).focus();
    });
  }
  $("openCloudButton").addEventListener("click",openCloud);$("trainingSyncButton").addEventListener("click",openCloud);
  $("closeCloudButton").addEventListener("click",()=>{$("cloudPanel").hidden=true;$("openCloudButton").setAttribute("aria-expanded","false");$("openCloudButton").focus();});
  $("syncRetryButton").addEventListener("click",()=>runCloudAction($("syncRetryButton"),async()=>{await repository.flush();await repository.refresh();}));
  $("refreshSessionsButton").addEventListener("click",()=>runCloudAction($("refreshSessionsButton"),()=>repository.refresh()));
  $("scanLegacyButton").addEventListener("click",()=>{
    legacyScan=repository.scanLegacy();backupDownloaded=false;$("migrationPreview").hidden=false;$("importLegacyButton").disabled=true;
    const counts=legacyScan.counts||{};text("migrationSummary",`检测到 ${counts.records||0} 条完成记录、${counts.overrides||0} 处日期编辑、${counts.progress||0} 段未完成进度。`);
    const list=$("migrationIssues");list.replaceChildren();for(const issue of legacyScan.issues||[]){const li=document.createElement("li");li.textContent=typeof issue==="string"?issue:issue.message||"部分旧数据需人工检查，原数据将保留。";list.append(li);}
    text("migrationHint",counts.issues?"存在需要检查的数据。请下载备份，核对后再决定是否导入。":"请先下载备份，核对后再导入。");
  });
  $("backupLegacyButton").addEventListener("click",()=>{
    try{const data=repository.backupLegacy(),blob=new Blob([data],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=`rehab-timer-backup-${localDate(new Date())}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);backupDownloaded=true;$("importLegacyButton").disabled=!legacyScan?.canImport;text("migrationHint","备份下载已发起。核对下载文件后，可确认导入旧记录。");}catch{showMessage("cloudActionMessage","备份未能下载，请重试，尚未导入。");}
  });
  $("importLegacyButton").addEventListener("click",()=>{
    if(!legacyScan?.canImport||!backupDownloaded)return;
    runCloudAction($("importLegacyButton"),async()=>{const result=await repository.importLegacy(legacyScan);text("migrationHint",result.message||(result.ok&&!result.pending?(result.conflicts?.length?"部分旧记录已导入，仍有冲突需要核对；原数据保留。":"旧记录已导入并核对，原本地数据仍保留。"):"导入操作已保留，请处理同步状态后再核对记录。原数据未删除。"));if(engine.state==="idle")activateProgram(program);history=store.history();renderCalendar();});
  });
  document.addEventListener("visibilitychange",()=>{
    log("visibility",{hidden:document.hidden});if(document.hidden){if(isDebug&&engine.state!=="manual")pause("测试页面离开前台，已暂停。",true);checkpoint(true);releaseWake();}
    else{syncTrack();if(activeTrack&&trackMedia.paused)pause("后台播放已中断，请确认后继续。");if(activeTrack)requestWake(generation);history=store.history();renderCalendar();render();repository.refresh().catch(()=>{});}
    renderElapsed();
  });
  window.addEventListener("pagehide",()=>{pause("离开页面，已暂停。",true);clearAudio();releaseWake();});
  window.addEventListener("online",()=>{repository.flush().catch(()=>{});});
  window.addEventListener("storage",()=>{history=store.history();if(view==="records")renderCalendar();renderCloud();});
  renderProgramDetails();restoreProgress();prepareHomeTraining();appReady=true;render();renderCalendar();renderCloud();
  if(isTest||mode==="local"){$("debugBadge").hidden=false;text("debugBadge",isDebug?`隔离测试 · ${unitMs} ms/秒 · 无声音`:isTest?"隔离测试 · 真实秒长与声音":"本地隔离预览 · 不同步正式记录");}
  repository.init().then(()=>{history=store.history();renderCalendar();render();renderCloud();}).catch(()=>renderCloud());
  window.__rehabTimer={
    get config(){return {debug:isDebug,test:isTest,unitMs,prefix,program,mode,groupRestSeconds:engine.groupRestSeconds,totalSeconds:plan.reduce((n,p)=>n+p.seconds,0)};},events,
    getPlan:()=>plan.map(p=>({...p})),
    getElapsed:()=>{const entry=currentElapsed();return entry?{milliseconds:elapsedMilliseconds(entry),finished:entry.finished}:null;},
    getState:()=>({...engine.snapshot(),runState:engine.state,view,savedCompletion,soundEnabled,mediaState:speaker.failed?"unavailable":$("cueAudio").paused?"paused":"playing",mediaJob:speaker.job?.key||null,pendingBeep,historyCount:history.length,syncState:repository.status().state})
  };
})();
