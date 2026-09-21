'use strict';
// Execute the shipped DOM controller with a deterministic event loop and media boundary.
// This is not a browser or an iOS emulator; real decoder evidence is a separate EGO check.
const vm = require('node:vm');
const fs = require('node:fs');
const html = fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
module.exports = function appFixture({rejectPlay=false, stuck=false, beepDelay=0, mediaDelays={}, storage=new Map()}={}) {
  let now=0, serial=0, gesture=false;
  const timers=new Map(), elements=new Map(), documentEvents={}, requests=[];
  const setTimer=(fn,ms=0)=>{const id=++serial;timers.set(id,{fn,at:now+ms});return id;};
  class Element {
    constructor() { this.children=[]; this.hidden=false; this.dataset={}; this.style={}; this.listeners={}; this.attributes={}; this.textContent=''; this.parts={}; this.classList={add(){},remove(){}}; }
    setAttribute(k,v) { this.attributes[k]=String(v); }
    removeAttribute(k) { delete this.attributes[k]; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children=nodes; }
    querySelector(s) { return this.parts[s] ||= new Element(); }
    addEventListener(k,fn) { this.listeners[k]=fn; }
    focus() {}
  }
  for(const [,id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id,new Element());
  const media=elements.get('cueAudio'); media.currentTime=0; media.paused=true;
  let mediaTimers=[];
  const clearMediaTimers=()=>{for(const id of mediaTimers)timers.delete(id);mediaTimers=[];};
  media.pause=()=>{media.paused=true;clearMediaTimers();media.listeners.pause?.();};
  media.load=()=>{media.pause();media.currentTime=0;};
  media.play=()=>{
    const stage=media.src.match(/stage-(\d+)\.mp3$/);
    if (stage) {
      const key=`stage-${stage[1]}`; requests.push({key,at:now,gesture});
      if(rejectPlay) return Promise.reject({name:'NotAllowedError'});
      clearMediaTimers();
      const track=context.RehabCore.stageTrack(Number(stage[1])-1);
      const start=Math.max(0,Number(media.currentTime)||0), started=now;
      media.onloadedmetadata?.(); media.paused=false; media.listeners.playing?.();
      if(!stuck) {
        const tick=()=>{
          const position=Math.min(track.duration,start+(now-started)/1000);
          media.currentTime=position; media.listeners.timeupdate?.();
        };
        for(let position=start+.25; position<track.duration; position+=.25) {
          mediaTimers.push(setTimer(tick,(position-start)*1000));
        }
        mediaTimers.push(setTimer(()=>{
          media.currentTime=track.duration; media.listeners.timeupdate?.(); media.listeners.ended?.(); media.paused=true;
        },(track.duration-start)*1000));
      }
      return Promise.resolve();
    }
    const key=media.src.match(/([^/]+)\.wav$/)[1]; requests.push({key,at:now,gesture});
    if(rejectPlay) return Promise.reject({name:'NotAllowedError'});
    media.paused=false;
    if(!stuck) {
      const playing=media.onplaying, ended=media.onended;
      const delay=key==='beep'?beepDelay:(mediaDelays[key] || 0);
      mediaTimers.push(setTimer(()=>playing?.(),delay));
      mediaTimers.push(setTimer(()=>{media.currentTime=context.RehabCore.cues[key][1]/1000;media.paused=true;ended?.();},delay+context.RehabCore.cues[key][1]));
    }
    return Promise.resolve();
  };
  const localStorage={get length(){return storage.size;},key:i=>[...storage.keys()][i]??null,
    getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  const document={hidden:false,getElementById:id=>elements.get(id),createElement:()=>new Element(),
    querySelector:s=>elements.get('runningPanel').querySelector(s), addEventListener:(k,fn)=>documentEvents[k]=fn};
  const context=vm.createContext({Date,URLSearchParams,performance:{now:()=>now},setTimeout:setTimer,clearTimeout:id=>timers.delete(id),
    localStorage,document,location:{search:'?test=1',protocol:'file:'},navigator:{audioSession:{}},crypto:{randomUUID:()=>`synthetic-app-${++serial}`}});
  context.window=context; context.addEventListener=(k,fn)=>documentEvents[k]=fn;
  for(const script of scripts) vm.runInContext(script,context);
  const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  return {elements,requests,storage,context,media,
    state:()=>context.__rehabTimer.getState(), events:()=>context.__rehabTimer.events,
    fail(value){rejectPlay=value;}, stall(value){stuck=value;},
    async click(id) { gesture=true;elements.get(id).listeners.click();gesture=false;await flush(); },
    async visibility(hidden) {document.hidden=hidden;documentEvents.visibilitychange();await flush();},
    async advance(ms) {
      const target=now+ms; await flush();
      for(let guard=0;guard<100000;guard++) {
        const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next || next[1].at>target) break;
        const [id,t]=next;timers.delete(id);now=t.at;t.fn();await flush();
      }
      now=target;await flush();
    }
  };
};
