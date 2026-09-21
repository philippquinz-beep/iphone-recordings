/* Bedienung: Liste, Anzeige und der vierstufige Schieberegler. */

import { Engine } from './audio.js';
import {
  listMeta, createMeta, putMeta, removeRecording,
  loadSamples, usage, requestPersistence,
} from './db.js';
import { encodeWav, exportWav, safeFileName } from './wav.js';

/* ---------- Regler-Stufen ---------- */

const MODES = ['record', 'stop', 'play', 'rewind'];
const FRACS = [0.125, 0.375, 0.625, 0.875];
const I_REC = 0, I_STOP = 1, I_PLAY = 2, I_REW = 3;

const STATE_TEXT = { record: 'Aufnahme', stop: 'Stopp', play: 'Wiedergabe', rewind: 'Rücklauf' };

/* ---------- DOM ---------- */

const $ = (id) => document.getElementById(id);

const screens   = { list: $('screen-list'), rec: $('screen-rec') };
const listEl    = $('list');
const emptyEl   = $('list-empty');
const storageEl = $('storage-info');

const badgeEl   = $('state-badge');
const stateEl   = $('state-text');
const owFlag    = $('overwrite-flag');
const tCurMain  = $('t-cur-main');
const tCurFrac  = $('t-cur-frac');
const tTotal    = $('t-total');
const barEl     = $('bar');
const barFill   = $('bar-fill');
const barHead   = $('bar-head');
const hintEl    = $('hint');
const nameBtn   = $('btn-name');

const sliderEl  = $('slider');
const trackEl   = $('track');
const knobEl    = $('knob');
const labels    = Array.from(document.querySelectorAll('.lab'));

/* ---------- Zustand ---------- */

const engine = new Engine();
let index = I_STOP;          // aktuelle Reglerstufe
let modeChain = Promise.resolve();
let dragging = false;
let holdingKey = false;
let currentScreen = 'list';

const dateFmt = new Intl.DateTimeFormat('de-AT', { dateStyle: 'short', timeStyle: 'short' });

/* ---------- Hilfen ---------- */

function fmtTime(sec) {
  sec = Math.max(0, sec || 0);
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- Dialog ---------- */

const sheet = $('sheet');
let sheetResolve = null;

function openSheet({ title, text = '', value = null, ok = 'OK' }) {
  $('sheet-title').textContent = title;
  $('sheet-text').textContent = text;
  const input = $('sheet-input');
  input.hidden = value === null;
  input.value = value ?? '';
  $('sheet-ok').textContent = ok;
  sheet.hidden = false;
  if (value !== null) setTimeout(() => { input.focus(); input.select(); }, 30);
  return new Promise((resolve) => { sheetResolve = resolve; });
}

function closeSheet(result) {
  sheet.hidden = true;
  const r = sheetResolve;
  sheetResolve = null;
  if (r) r(result);
}

$('sheet-cancel').addEventListener('click', () => closeSheet(null));
$('sheet-ok').addEventListener('click', () => {
  const input = $('sheet-input');
  closeSheet(input.hidden ? true : input.value.trim());
});
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(null); });
$('sheet-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('sheet-ok').click(); }
  if (e.key === 'Escape') closeSheet(null);
});

const askText = (title, value) => openSheet({ title, value, ok: 'Speichern' });
const askYes  = (title, text, ok) => openSheet({ title, text, ok });

/* ---------- Bildschirmwechsel ---------- */

function show(name) {
  currentScreen = name;
  for (const [key, el] of Object.entries(screens)) el.classList.toggle('is-active', key === name);
}

/* ---------- Liste ---------- */

async function renderList() {
  const metas = await listMeta();
  listEl.innerHTML = '';
  emptyEl.hidden = metas.length > 0;

  for (const meta of metas) {
    const li = document.createElement('li');
    li.className = 'item';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'item__main';
    const dur = meta.sampleRate ? meta.length / meta.sampleRate : 0;
    main.innerHTML =
      `<span class="item__name"></span>` +
      `<span class="item__meta">${dateFmt.format(meta.created)} · ${fmtTime(dur)} · ${fmtBytes(meta.length * 2)}</span>`;
    main.querySelector('.item__name').textContent = meta.name;
    main.addEventListener('click', () => openRecorder(meta));

    const acts = document.createElement('div');
    acts.className = 'item__acts';
    acts.append(
      actBtn('✎', 'Umbenennen', () => renameFromList(meta)),
      actBtn('↧', 'Als WAV exportieren', () => exportFromList(meta)),
      actBtn('✕', 'Löschen', () => deleteFromList(meta), true),
    );

    li.append(main, acts);
    listEl.append(li);
  }

  renderStorage();
}

function actBtn(glyph, label, fn, danger = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'item__act' + (danger ? ' btn--danger' : '');
  b.textContent = glyph;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', fn);
  return b;
}

async function renderStorage() {
  const est = await usage();
  storageEl.textContent = est && est.usage != null
    ? `Lokal belegt: ${fmtBytes(est.usage)}${est.quota ? ` von ${fmtBytes(est.quota)}` : ''}`
    : 'Aufnahmen liegen nur auf diesem Gerät.';
}

async function renameFromList(meta) {
  const name = await askText('Diktat umbenennen', meta.name);
  if (!name) return;
  meta.name = name;
  meta.modified = Date.now();
  await putMeta(meta);
  renderList();
}

async function deleteFromList(meta) {
  const yes = await askYes('Diktat löschen?', `„${meta.name}“ wird dauerhaft entfernt.`, 'Löschen');
  if (!yes) return;
  await removeRecording(meta.id);
  toast('Gelöscht');
  renderList();
}

async function exportFromList(meta) {
  if (!meta.length) { toast('Diktat ist leer'); return; }
  const samples = await loadSamples(meta);
  await doExport(samples, meta);
}

async function doExport(samples, meta) {
  try {
    const blob = encodeWav(samples, meta.length, meta.sampleRate);
    const res = await exportWav(blob, safeFileName(meta.name));
    if (res === 'downloaded') toast('WAV gespeichert');
    if (res === 'shared') toast('Geteilt');
  } catch (err) {
    toast('Export fehlgeschlagen');
    console.error(err);
  }
}

/* ---------- Diktiergerät ---------- */

async function openRecorder(meta) {
  try {
    await engine.openRecording(meta);
  } catch (err) {
    toast('Diktat konnte nicht geladen werden');
    console.error(err);
    return;
  }
  nameBtn.textContent = meta.name;
  setIndex(I_STOP, true);
  show('rec');
  layoutKnob(true);
  renderFrame();
}

async function newRecording() {
  try {
    const ctx = await engine.ensureContext();
    const name = 'Diktat ' + dateFmt.format(Date.now());
    const meta = await createMeta(name, ctx.sampleRate);
    await openRecorder(meta);
  } catch (err) {
    toast(err.message || 'Anlegen fehlgeschlagen');
    console.error(err);
  }
}

async function leaveRecorder() {
  setIndex(I_STOP, true);
  await modeChain;                     // erst anhalten lassen, dann schließen
  const meta = engine.meta;
  const leer = !!engine.track && engine.track.length === 0;
  try { await engine.close(); } catch (err) { console.error(err); }
  // nie Benutztes nicht in der Liste stehen lassen
  if (leer && meta) { try { await removeRecording(meta.id); } catch (err) { console.error(err); } }
  show('list');
  renderList();
}

/* ---------- Regler ---------- */

function applyMode(mode) {
  modeChain = modeChain
    .then(() => engine.setMode(mode))
    .catch((err) => { toast(err.message || 'Fehler'); console.error(err); });
}

function layoutKnob(instant = false) {
  const h = trackEl.clientHeight;
  const kh = knobEl.offsetHeight;
  if (!h || !kh) return;
  if (instant) knobEl.classList.add('no-anim');
  const raw = FRACS[index] * h - kh / 2;
  knobEl.style.top = Math.max(4, Math.min(h - kh - 4, raw)) + 'px';
  if (instant) {
    void knobEl.offsetHeight;          // Stand festschreiben, dann wieder animieren
    knobEl.classList.remove('no-anim');
  }
}

function setIndex(i, force = false) {
  if (i === index && !force) return;

  // Abspielen und Zurückspulen brauchen Material
  if ((i === I_PLAY || i === I_REW) && (!engine.track || engine.track.length === 0)) {
    if (!force) { toast('Noch nichts aufgenommen'); i = I_STOP; }
  }

  index = i;
  layoutKnob();

  labels.forEach((el) => el.classList.toggle('is-on', Number(el.dataset.i) === index));
  trackEl.className = 'slider__track m-' + index;
  trackEl.setAttribute('aria-valuenow', String(index));
  trackEl.setAttribute('aria-valuetext', STATE_TEXT[MODES[index]]);

  applyMode(MODES[index]);
}

function idxFromPoint(clientY) {
  const r = trackEl.getBoundingClientRect();
  const f = (clientY - r.top) / r.height;
  if (f < 0.25) return I_REC;
  if (f < 0.50) return I_STOP;
  if (f < 0.75) return I_PLAY;
  return I_REW;
}

sliderEl.addEventListener('pointerdown', (e) => {
  dragging = true;
  knobEl.classList.add('is-grabbed');
  sliderEl.setPointerCapture(e.pointerId);
  trackEl.focus({ preventScroll: true });
  setIndex(idxFromPoint(e.clientY));
  e.preventDefault();
});

sliderEl.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  setIndex(idxFromPoint(e.clientY));
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  knobEl.classList.remove('is-grabbed');
  try { sliderEl.releasePointerCapture(e.pointerId); } catch {}
  // Zurückspulen ist eine Federstellung: loslassen heißt abspielen
  if (index === I_REW) setIndex(I_PLAY);
}

sliderEl.addEventListener('pointerup', endDrag);
sliderEl.addEventListener('pointercancel', endDrag);

window.addEventListener('resize', () => layoutKnob(true));

/* Tastatur (nur für den Test am PC) */
trackEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp')   { e.preventDefault(); setIndex(Math.max(I_REC, index - 1)); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(Math.min(I_PLAY, index + 1)); }
  else if (e.key === ' ')    { e.preventDefault(); setIndex(index === I_PLAY ? I_STOP : I_PLAY); }
  else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (!holdingKey) { holdingKey = true; setIndex(I_REW); }
  }
});

trackEl.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' && holdingKey) { holdingKey = false; setIndex(I_PLAY); }
});

trackEl.addEventListener('blur', () => {
  if (holdingKey) { holdingKey = false; setIndex(I_PLAY); }
});

/* ---------- Positionsbalken ---------- */

let scrubbing = false;

function seekFromPoint(clientX) {
  if (!engine.track) return;
  const r = barEl.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  engine.seek(f * engine.track.durationSec);
}

barEl.addEventListener('pointerdown', (e) => {
  if (engine.mode === 'record') { toast('Während der Aufnahme nicht möglich'); return; }
  scrubbing = true;
  barEl.setPointerCapture(e.pointerId);
  seekFromPoint(e.clientX);
  e.preventDefault();
});
barEl.addEventListener('pointermove', (e) => { if (scrubbing) seekFromPoint(e.clientX); });
barEl.addEventListener('pointerup', (e) => {
  scrubbing = false;
  try { barEl.releasePointerCapture(e.pointerId); } catch {}
});
barEl.addEventListener('keydown', (e) => {
  if (!engine.track || engine.mode === 'record') return;
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowLeft')  { e.preventDefault(); engine.seek(engine.currentPos() - step); }
  if (e.key === 'ArrowRight') { e.preventDefault(); engine.seek(engine.currentPos() + step); }
});

/* ---------- Anzeige ---------- */

function hintFor(pos, dur) {
  switch (engine.mode) {
    case 'record':
      return engine.isOverwriting ? 'Vorhandenes wird ersetzt' : 'Neue Aufnahme läuft';
    case 'play':
      return 'Wiedergabe';
    case 'rewind':
      return 'Rückwärts, doppelte Geschwindigkeit';
    default:
      if (dur === 0) return 'Regler auf Aufnehmen schieben';
      if (pos >= dur - 0.05) return 'Aufnahme setzt am Ende fort';
      return 'Aufnahme überschreibt ab dieser Stelle';
  }
}

function renderFrame() {
  if (currentScreen === 'rec' && engine.track) {
    const dur = engine.track.durationSec;
    const pos = engine.currentPos();

    // Ende der Wiedergabe: zurück in Stopp
    if (engine.hitEnd && index === I_PLAY) setIndex(I_STOP);

    const mode = engine.mode;
    tCurMain.textContent = fmtTime(pos);
    tCurFrac.textContent = '.' + Math.floor((pos % 1) * 10);
    tTotal.textContent = fmtTime(dur);

    const pct = dur > 0 ? (pos / dur) * 100 : 0;
    barFill.style.width = pct + '%';
    barHead.style.left = pct + '%';
    barEl.className = 'bar is-' + mode;
    barEl.setAttribute('aria-valuemax', dur.toFixed(1));
    barEl.setAttribute('aria-valuenow', pos.toFixed(1));

    badgeEl.className = 'badge badge--' + mode;
    stateEl.textContent = STATE_TEXT[mode];
    owFlag.hidden = !engine.isOverwriting;
    hintEl.textContent = hintFor(pos, dur);
  }
  requestAnimationFrame(renderFrame);
}

/* ---------- Kopfleiste im Diktiergerät ---------- */

$('btn-back').addEventListener('click', leaveRecorder);
$('btn-new').addEventListener('click', newRecording);

nameBtn.addEventListener('click', async () => {
  if (!engine.meta) return;
  const name = await askText('Diktat umbenennen', engine.meta.name);
  if (!name) return;
  engine.meta.name = name;
  nameBtn.textContent = name;
  await engine.queueSave();
});

$('btn-export').addEventListener('click', async () => {
  if (!engine.track || engine.track.length === 0) { toast('Diktat ist leer'); return; }
  setIndex(I_STOP);
  await modeChain;                     // eine laufende Aufnahme zuerst abschließen
  await engine.flushSave();
  await doExport(engine.track.samples, engine.meta);
});

/* ---------- Sicherheitsnetze ---------- */

engine.onError = (err) => { toast(err.message || 'Fehler'); console.error(err); };
engine.onEnded = () => { if (index === I_PLAY) setIndex(I_STOP); };
engine.onSilence = () => toast('Kein Signal vom Mikrofon — Aufnahme ist stumm');

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  if (engine.mode === 'record') {
    setIndex(I_STOP);
    toast('Aufnahme gestoppt – iOS pausiert das Mikrofon im Hintergrund');
  } else if (engine.mode !== 'stop') {
    setIndex(I_STOP);
  }
  engine.queueSave();
});

window.addEventListener('pagehide', () => { engine.queueSave(); });

/* ---------- Start ---------- */

requestPersistence();
renderList();
requestAnimationFrame(renderFrame);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW:', err));
  });
}
