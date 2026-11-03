/* Browser audio: decode the voice sprite once, render each track offline into one continuous WAV,
   and hand it to the single retained <audio> element. Speech, tones and the timing clock share it. */
globalThis.RehabAudio = (() => {
  "use strict";
  const RATE = 22050;
  const Offline = () => globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  let sprite = null, loading = null;

  // Some browsers never settle a decode or render they cannot finish; a deadline turns that into an error.
  const within = (promise, ms, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
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
  async function loadBuffer(data) { sprite = await within(decode(data), 30000, "decode"); return sprite; }
  // Download with a stall timer: a slow connection may keep going, but one that stops delivering
  // bytes for `stallMs` fails, so the page can fall back to silent timing instead of waiting forever.
  async function download(url, { stallMs = 10000, onProgress } = {}) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const arm = () => { clearTimeout(timer); if (controller) timer = setTimeout(() => controller.abort(), stallMs); };
    arm();
    try {
      const response = await fetch(url, { signal: controller?.signal });
      if (!response.ok) throw new Error(`voice ${response.status}`);
      const total = Number(response.headers.get("content-length")) || 0;
      if (!response.body?.getReader) return await response.arrayBuffer();
      const reader = response.body.getReader(), chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); received += value.length; arm();
        onProgress?.(received, total);
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes.buffer;
    } finally { clearTimeout(timer); }
  }
  // `urls` are tried in order: a small compressed copy first, the WAV as the fallback. A source is only
  // accepted when it decodes to the expected length, so a browser that pads or trims it differently
  // cannot shift the clip offsets.
  function load(urls, options = {}) {
    if (sprite) return Promise.resolve(sprite);
    if (!loading) {
      loading = (async () => {
        let failure = new Error("no voice source");
        for (const url of [].concat(urls)) {
          try {
            const buffer = await within(decode(await download(url, options)), 30000, "decode");
            if (options.samples && Math.abs(buffer.length - options.samples) > RATE * 0.02) throw new Error("voice length mismatch");
            sprite = buffer;
            return sprite;
          } catch (error) { failure = error; }
        }
        throw failure;
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
    const header = new DataView(new ArrayBuffer(44));
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) header.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, "RIFF"); header.setUint32(4, 36 + length * 2, true); text(8, "WAVE");
    text(12, "fmt "); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
    header.setUint32(24, buffer.sampleRate, true); header.setUint32(28, buffer.sampleRate * 2, true);
    header.setUint16(32, 2, true); header.setUint16(34, 16, true);
    text(36, "data"); header.setUint32(40, length * 2, true);
    // Samples go in as little-endian Int16 (every target platform is little-endian); the Blob joins the
    // two parts without a second full-size copy, which matters for tracks of many minutes.
    const pcm = new Int16Array(length);
    for (let i = 0; i < length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return new Blob([header.buffer, pcm.buffer], { type: "audio/wav" });
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
    const rendered = await within(startRendering(context), 60000, "render");
    const blob = encodeWav(rendered);
    return { url: URL.createObjectURL(blob), duration: rendered.length / RATE, bytes: blob.size };
  }
  return Object.freeze({ RATE, supported, load, loadBuffer, ready, render, encodeWav });
})();
