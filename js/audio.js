/* Aufnahme, Wiedergabe und Zurückspulen.
   Alles liegt als 16-Bit-PCM im Speicher; das erlaubt das Überschreiben
   ab jeder beliebigen Stelle und echtes Rückwärtsabspielen. */

import { loadSamples, saveChunks, putMeta } from './db.js';

export const PREFERRED_RATE = 24000;
export const REWIND_RATE = 2;      // doppelte Geschwindigkeit rückwärts

const SEG_SEC    = 0.4;   // Länge eines eingeplanten Audioblocks
const LOOKAHEAD  = 0.9;   // so weit im Voraus wird eingeplant
const START_LAG  = 0.06;  // kleiner Vorlauf, damit der erste Block nicht zu spät kommt

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ---------- Tonspur ---------- */

export class Track {
  constructor(sampleRate, samples, length) {
    this.sampleRate = sampleRate;
    this.samples = samples || new Int16Array(0);
    this.length = length == null ? this.samples.length : length;
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
  }

  get durationSec() { return this.length / this.sampleRate; }

  ensure(n) {
    if (n <= this.samples.length) return;
    let cap = Math.max(this.samples.length, this.sampleRate) || 1;
    while (cap < n) cap *= 2;
    const next = new Int16Array(cap);
    next.set(this.samples.subarray(0, this.length));
    this.samples = next;
  }

  markDirty(from, to) {
    if (from < this.dirtyFrom) this.dirtyFrom = from;
    if (to > this.dirtyTo) this.dirtyTo = to;
  }

  /** Schreibt Float-Samples an eine Position – überschreibt oder verlängert. */
  writeFloat(data, atSample) {
    const n = data.length;
    const end = atSample + n;
    this.ensure(end);
    const s = this.samples;
    for (let i = 0; i < n; i++) {
      const v = clamp(data[i], -1, 1);
      s[atSample + i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    if (end > this.length) this.length = end;
    this.markDirty(atSample, end);
    return end;
  }

  readFloat(fromSample, count) {
    const out = new Float32Array(count);
    const s = this.samples;
    const start = Math.max(0, fromSample);
    const stop = Math.min(this.length, fromSample + count);
    for (let i = start; i < stop; i++) out[i - fromSample] = s[i] / 0x8000;
    return out;
  }
}

/** Einfache lineare Umtastung – nur nötig, wenn ein altes Diktat
    mit anderer Abtastrate weiterbespielt wird. */
function resample(input, fromRate, toRate) {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.min(last, Math.floor(src));
    const i1 = Math.min(last, i0 + 1);
    const f = src - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

/* ---------- Laufwerk ---------- */

export class Engine {
  constructor() {
    this.ctx = null;
    this.workletReady = false;

    this.stream = null;
    this.micSource = null;
    this.node = null;
    this.sink = null;
    this.outGain = null;

    this.meta = null;
    this.track = null;

    this.mode = 'stop';        // stop | record | play | rewind
    this.posSec = 0;

    this.playing = false;
    this.playDir = 1;
    this.playRate = 1;
    this.anchorCtxTime = 0;
    this.anchorPos = 0;
    this.nextStartTime = 0;
    this.edgeSec = 0;
    this.sources = [];
    this.schedTimer = null;

    this.capturing = false;
    this.writeSample = 0;
    this.lengthAtRecordStart = 0;
    this.flushWaiters = [];

    this.autosaveTimer = null;
    this.saveChain = Promise.resolve();
    this.wakeLock = null;

    this.onChange = () => {};
    this.onError = () => {};
    this.onEnded = () => {};
    this.onSilence = () => {};
  }

  /* --- Audiokontext / Mikrofon --- */

  async ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Dieser Browser kann kein Web Audio.');
      try {
        this.ctx = new Ctx({ sampleRate: PREFERRED_RATE, latencyHint: 'interactive' });
      } catch {
        this.ctx = new Ctx();
      }
      this.outGain = this.ctx.createGain();
      this.outGain.gain.value = 1;
      this.outGain.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* wird beim nächsten Tippen nachgeholt */ }
    }
    return this.ctx;
  }

  async ensureMic() {
    if (this.node) return;
    const ctx = await this.ensureContext();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Kein Mikrofonzugriff möglich. Die Seite muss über HTTPS oder localhost laufen.');
    }

    if (!this.workletReady) {
      await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
      this.workletReady = true;
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.micSource = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof Float32Array) {
        this.onPcm(d);
      } else if (d && d.type === 'flushed') {
        this.capturing = false;
        const w = this.flushWaiters;
        this.flushWaiters = [];
        w.forEach((fn) => fn());
      }
    };

    // stumm an den Ausgang, damit der Prozessor zuverlässig getaktet wird
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.micSource.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  releaseMic() {
    if (this.node) { try { this.node.disconnect(); } catch {} this.node.port.onmessage = null; this.node = null; }
    if (this.micSource) { try { this.micSource.disconnect(); } catch {} this.micSource = null; }
    if (this.sink) { try { this.sink.disconnect(); } catch {} this.sink = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.capturing = false;
  }

  /* --- Diktat öffnen / schließen --- */

  async openRecording(meta) {
    await this.ensureContext();
    const samples = await loadSamples(meta);
    this.meta = meta;
    this.track = new Track(meta.sampleRate || this.ctx.sampleRate, samples, meta.length);
    this.mode = 'stop';
    this.posSec = 0;
    this.emit();
  }

  async close() {
    await this.setMode('stop');
    await this.flushSave();
    this.releaseMic();
    this.meta = null;
    this.track = null;
  }

  /* --- Betriebsart --- */

  async setMode(mode) {
    if (mode === this.mode) return;

    if (this.mode === 'record') await this.endCapture();
    if (this.playing) this.stopPlayback();

    this.mode = mode;
    this.emit();

    try {
      if (mode === 'record') await this.beginCapture();
      else if (mode === 'play') this.startPlayback(1, 1);
      else if (mode === 'rewind') this.startPlayback(-1, REWIND_RATE);
    } catch (err) {
      this.mode = 'stop';
      this.emit();
      this.onError(err);
      return;
    }

    if (mode === 'stop') this.releaseWakeLock(); else this.requestWakeLock();
    this.emit();
  }

  /* --- Aufnahme --- */

  async beginCapture() {
    await this.ensureMic();
    const t = this.track;
    this.lengthAtRecordStart = t.length;
    this.writeSample = clamp(Math.round(this.posSec * t.sampleRate), 0, t.length);
    this.captureStart = this.writeSample;
    this.capturing = true;
    this.node.port.postMessage({ type: 'recording', value: true });
    this.startAutosave();
  }

  async endCapture() {
    this.stopAutosave();
    if (!this.node || !this.capturing) { this.capturing = false; return; }
    const wait = new Promise((resolve) => {
      this.flushWaiters.push(resolve);
      setTimeout(resolve, 400); // nicht ewig warten
    });
    this.node.port.postMessage({ type: 'recording', value: false });
    await wait;
    this.capturing = false;

    // Stille über die ganze Aufnahme heißt: das Mikrofon hat nichts geliefert
    const t = this.track;
    if (t && this.writeSample - this.captureStart > t.sampleRate / 2) {
      let peak = 0;
      for (let i = this.captureStart; i < this.writeSample; i++) {
        const v = Math.abs(t.samples[i]);
        if (v > peak) { peak = v; if (peak > 64) break; }
      }
      if (peak <= 64) this.onSilence();
    }

    this.queueSave();
  }

  onPcm(data) {
    if (!this.capturing || !this.track) return;
    const t = this.track;
    const src = this.ctx.sampleRate !== t.sampleRate
      ? resample(data, this.ctx.sampleRate, t.sampleRate)
      : data;
    this.writeSample = t.writeFloat(src, this.writeSample);
    this.posSec = this.writeSample / t.sampleRate;
  }

  /** true, solange die Aufnahme vorhandenes Material ersetzt */
  get isOverwriting() {
    return this.mode === 'record' && this.writeSample < this.lengthAtRecordStart;
  }

  /* --- Wiedergabe und Zurückspulen --- */

  startPlayback(dir, rate) {
    const ctx = this.ctx;
    const t = this.track;
    if (!ctx || !t || t.length === 0) return;

    this.playDir = dir;
    this.playRate = rate;
    this.posSec = clamp(this.posSec, 0, t.durationSec);
    this.anchorPos = this.posSec;
    this.anchorCtxTime = ctx.currentTime + START_LAG;
    this.nextStartTime = this.anchorCtxTime;
    this.edgeSec = this.posSec;
    this.sources = [];
    this.playing = true;
    this.endedFired = false;

    this.schedule();
    this.schedTimer = setInterval(() => this.schedule(), 120);
  }

  schedule() {
    if (!this.playing) return;
    const ctx = this.ctx;
    const t = this.track;
    const horizon = ctx.currentTime + LOOKAHEAD;
    const total = t.durationSec;

    while (this.nextStartTime < horizon) {
      let fromSec;
      let lenSec;

      if (this.playDir > 0) {
        if (this.edgeSec >= total - 1e-6) break;
        fromSec = this.edgeSec;
        lenSec = Math.min(SEG_SEC, total - fromSec);
        this.edgeSec = fromSec + lenSec;
      } else {
        if (this.edgeSec <= 1e-6) break;
        lenSec = Math.min(SEG_SEC, this.edgeSec);
        fromSec = this.edgeSec - lenSec;
        this.edgeSec = fromSec;
      }

      const count = Math.max(1, Math.round(lenSec * t.sampleRate));
      const from = Math.round(fromSec * t.sampleRate);
      const data = t.readFloat(from, count);
      if (this.playDir < 0) data.reverse();

      const buf = ctx.createBuffer(1, count, t.sampleRate);
      buf.copyToChannel(data, 0);

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = this.playRate;
      src.connect(this.outGain);
      src.start(this.nextStartTime);
      src.onended = () => {
        const i = this.sources.indexOf(src);
        if (i >= 0) this.sources.splice(i, 1);
      };
      this.sources.push(src);

      this.nextStartTime += (count / t.sampleRate) / this.playRate;
    }

    // Bandende: nichts mehr einzuplanen und das Eingeplante ist durchgelaufen.
    // Hängt bewusst am Takt des Laufwerks, nicht am Bildaufbau der Oberfläche.
    if (!this.endedFired &&
        this.playDir > 0 &&
        this.edgeSec >= total - 1e-6 &&
        ctx.currentTime >= this.nextStartTime) {
      this.endedFired = true;
      this.onEnded();
    }
  }

  stopPlayback() {
    const pos = this.currentPos();
    if (this.schedTimer) { clearInterval(this.schedTimer); this.schedTimer = null; }
    for (const s of this.sources) {
      try { s.onended = null; s.stop(); } catch {}
      try { s.disconnect(); } catch {}
    }
    this.sources = [];
    this.playing = false;
    this.posSec = pos;
  }

  /** Aktuelle Position in Sekunden – beim Abspielen aus der Uhr des Audiokontexts. */
  currentPos() {
    if (!this.track) return 0;
    if (this.playing) {
      const el = Math.max(0, this.ctx.currentTime - this.anchorCtxTime);
      const p = this.anchorPos + this.playDir * this.playRate * el;
      return clamp(p, 0, this.track.durationSec);
    }
    return clamp(this.posSec, 0, this.track.durationSec);
  }

  /** true, wenn beim Vorwärtsabspielen das Ende erreicht ist */
  get hitEnd() {
    return this.playing && this.playDir > 0 &&
           this.currentPos() >= this.track.durationSec - 1e-3;
  }

  seek(sec) {
    if (!this.track) return;
    const target = clamp(sec, 0, this.track.durationSec);
    if (this.mode === 'record') return;
    if (this.playing) {
      const dir = this.playDir;
      const rate = this.playRate;
      this.stopPlayback();
      this.posSec = target;
      this.startPlayback(dir, rate);
    } else {
      this.posSec = target;
    }
    this.emit();
  }

  /* --- Speichern --- */

  startAutosave() {
    this.stopAutosave();
    this.autosaveTimer = setInterval(() => this.queueSave(), 10000);
  }

  stopAutosave() {
    if (this.autosaveTimer) { clearInterval(this.autosaveTimer); this.autosaveTimer = null; }
  }

  queueSave() {
    this.saveChain = this.saveChain.then(() => this.doSave()).catch((e) => this.onError(e));
    return this.saveChain;
  }

  flushSave() { return this.queueSave(); }

  async doSave() {
    const t = this.track;
    const meta = this.meta;
    if (!t || !meta) return;

    const from = t.dirtyFrom;
    const to = t.dirtyTo;
    t.dirtyFrom = Infinity;
    t.dirtyTo = -1;

    meta.length = t.length;
    meta.modified = Date.now();
    meta.sampleRate = t.sampleRate;

    try {
      if (to > from) await saveChunks(meta, t.samples, from, to);
      else await putMeta(meta);
    } catch (err) {
      t.markDirty(from, to); // beim nächsten Versuch erneut schreiben
      throw err;
    }
  }

  /* --- Bildschirm wach halten --- */

  async requestWakeLock() {
    if (this.wakeLock || !navigator.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch { /* nicht überall verfügbar */ }
  }

  releaseWakeLock() {
    if (this.wakeLock) { try { this.wakeLock.release(); } catch {} this.wakeLock = null; }
  }

  emit() { this.onChange(); }
}
