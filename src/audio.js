/* Browser audio: decode the voice sprite once, render each track offline into one continuous WAV,
   and hand it to the single retained <audio> element. Speech, tones and the timing clock share it. */
globalThis.RehabAudio = (() => {
  "use strict";
  const RATE = 22050;
  const Offline = () => globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  let sprite = null, loading = null;

  const supported = () => Boolean(Offline() && globalThis.Blob && globalThis.URL?.createObjectURL);

  function decode(data) {
    const Context = Offline();
    const context = new Context(1, RATE, RATE);
    return new Promise((resolve, reject) => {
      // Older WebKit only supports the callback form; newer engines return a promise too.
      const result = context.decodeAudioData(data, resolve, reject);
      if (result && typeof result.then === "function") result.then(resolve, reject);
    });
  }
  async function loadBuffer(data) { sprite = await decode(data); return sprite; }
  function load(url) {
    if (sprite) return Promise.resolve(sprite);
    if (!loading) {
      loading = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`voice ${response.status}`);
        return loadBuffer(await response.arrayBuffer());
      })().catch(error => { loading = null; throw error; });
    }
    return loading;
  }
  const ready = () => Boolean(sprite);

  const TONES = Object.freeze({
    rise: [[660, 0, 0.17], [990, 0.14, 0.26]],
    fall: [[784, 0, 0.17], [523, 0.14, 0.3]],
    tick: [[1480, 0, 0.055, "triangle", 0.3]],
    chime: [[523, 0, 0.55], [659, 0.12, 0.55], [784, 0.24, 0.5]]
  });
  function note(context, out, frequency, at, duration, type = "sine", gain = 0.3) {
    const oscillator = context.createOscillator(), envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, at);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(envelope); envelope.connect(out);
    oscillator.start(at); oscillator.stop(at + duration + 0.02);
  }
  function startRendering(context) {
    return new Promise((resolve, reject) => {
      context.oncomplete = event => resolve(event.renderedBuffer);
      try {
        const result = context.startRendering();
        if (result && typeof result.then === "function") result.then(resolve, reject);
      } catch (error) { reject(error); }
    });
  }
  function encodeWav(buffer) {
    const samples = buffer.getChannelData(0), length = samples.length;
    const view = new DataView(new ArrayBuffer(44 + length * 2));
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, "RIFF"); view.setUint32(4, 36 + length * 2, true); text(8, "WAVE");
    text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, length * 2, true);
    for (let i = 0, offset = 44; i < length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([view.buffer], { type: "audio/wav" });
  }
  // Render a track descriptor from RehabCore into a playable blob URL.
  async function render(track, clips) {
    if (!sprite) throw new Error("voice not loaded");
    const Context = Offline();
    const context = new Context(1, Math.ceil((track.duration + 0.1) * RATE), RATE);
    const out = context.createGain();
    out.connect(context.destination);
    for (const event of track.events) {
      if (event.voice) {
        const clip = clips[event.voice];
        if (!clip) continue;
        const source = context.createBufferSource();
        source.buffer = sprite; source.connect(out);
        source.start(Math.max(0, event.at), clip[0] / 1000, clip[1] / 1000);
      } else {
        for (const [frequency, offset, duration, type, gain] of TONES[event.tone] || []) note(context, out, frequency, Math.max(0, event.at + offset), duration, type, gain);
      }
    }
    const rendered = await startRendering(context);
    const blob = encodeWav(rendered);
    return { url: URL.createObjectURL(blob), duration: rendered.length / RATE, bytes: blob.size };
  }
  return Object.freeze({ RATE, supported, load, loadBuffer, ready, render, encodeWav });
})();
