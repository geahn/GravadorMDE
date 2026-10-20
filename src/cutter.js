// Cut editor. Removed spans really disappear: the timeline shows the final
// video (kept pieces back to back, plus "a few moments later" transitions).
// Each seam is a marker you can click to restore what was cut there or to add
// a transition. Playback uses two <video> elements in turns so seams play
// without a stall, and the audio can be delayed to fix lip sync.
//
// On top of the cuts: scenes (recordings appended to the lesson, reorderable),
// speed (whole video and per stretch), zooms (fixed point or following the
// mouse), texts / images / videos / stickers, color filters and audio
// treatment. Lanes under the waveform show each of them on the timeline.

import { icon } from './icons.js';
import { zoomState, followPath, zoompanFilter, ZOOM_DEFAULT } from './zoom.js';
import { cssFilter, vignetteCss, ffmpegChain, isNeutral } from './fx.js';
import { drawItem, itemSize, rasterize, stickerUrl, mergeStyle } from './textstyles.js';
import { CutPanel } from './cutpanel.js';

const $ = (s, root = document) => root.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const RULER = 24;
const MAIN_H = 74;
const LANE_H = 22;
const LANE_GAP = 5;
const MAX_PPS = 400;
const BIN = 0.02; // waveform resolution (s)
const SPEEDS = [1, 1.5, 2, 3, 4];
const MAX_OV_ROWS = 4;
const font = '"Segoe UI Variable Text", "Segoe UI", sans-serif';

export const AUDIO_FX_DEFAULT = { master: 1, mic: 1, sys: 1, media: 1, bass: 0, mid: 0, treble: 0, denoise: 0, gate: false };

const KIND_COLOR = { text: '#7b80ff', image: '#38bdf8', video: '#f472b6', sticker: '#a78bfa', emoji: '#a78bfa' };
const SCENE_COLORS = ['#3b4252', '#2f4858', '#3f3a5a', '#3a4a3a', '#524036', '#33465a'];

let uidN = 0;
export const uid = (p = 'x') => `${p}${Date.now().toString(36)}${(uidN++).toString(36)}`;

export function fmt(t) {
  const s = Math.max(0, Math.floor(t + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

export function fmtLen(t) {
  if (t < 60) return `${t.toFixed(1).replace('.', ',')} s`;
  return fmt(t);
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const fmtSpeed = (s) => `${String(Number(s.toFixed(2))).replace('.', ',')}×`;

export class Cutter {
  constructor(opts) {
    Object.assign(this, opts); // api, toast, confirm, getIntro, getTransition, getFps, getAudioDelay, onAudioDelay, onExport, onClose, onSetupIntro, onSetupTransition, getPrefs, setPrefs, onNewScene, onCameraFilter, onExportAudio
    this.el = $('#cutter');
    this.players = [$('#cut-video'), $('#cut-video-b')];
    this.clip = $('#cut-video-t');
    // Sound comes from one <audio> element that trails the picture by the
    // lip-sync delay; the video players stay muted. (Routing several players
    // through Web Audio made Chromium drop most frames and stall.)
    this.audio = $('#cut-audio');
    for (const v of this.players) v.muted = true;
    this.thumbVideo = $('#cut-thumb-video');
    this.scroller = $('#cut-scroller');
    this.inner = $('#cut-inner');
    this.canvas = $('#cut-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.bubble = $('#cut-bubble');
    this.hoverBox = $('#cut-hover');
    this.thumbCanvas = $('#cut-hover canvas');
    this.pop = $('#cut-pause-pop');
    this.syncPop = $('#cut-sync-pop');
    this.player = $('.cut-player');
    this.fxWrap = $('#cut-fxwrap');
    this.zoomWrap = $('#cut-zoomwrap');
    this.vignette = $('#cut-vignette');
    this.ovCanvas = $('#cut-ov-canvas');
    this.ovCtx = this.ovCanvas.getContext('2d');
    this.ovSel = $('#cut-ov-sel');
    this.zoomRect = $('#cut-zoom-rect');
    this.ovMedia = $('#cut-ov-media');
    this.p = null;
    this.pps = 10;
    this.fitMode = true;
    this.speedIdx = 0;
    this.playing = false;
    this.seq = [];
    this.seams = [];
    this.outDur = 0;
    this.lanes = [];
    this.res = new Map();
    this.paths = new Map();
    this.panel = new CutPanel(this);
    this.bind();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  get active() {
    return this.players[this.cur];
  }

  // ---------------------------------------------------------------- open / close

  async open(project) {
    this.p = project;
    this.history = [];
    this.future = [];
    this.sel = null;
    this.focus = -1;
    this.selItem = null;
    this.candidates = null;
    this.hover = null;
    this.drag = null;
    this.t = 0;
    this.cur = 0;
    this.item = 0;
    this.playing = false;
    this.fps = this.getFps() || 30;
    this.duration = project.duration || 0;
    this.wave = null;
    this.db = null;
    this.sdb = null;
    this.waveState = 'loading';
    const { intro, enabled } = this.getIntro(project);
    this.introApplied = !!project.introApplied;
    this.intro = this.introApplied ? null : intro;
    this.useIntro = !!this.intro && enabled;
    this.trans = this.getTransition(project);
    this.audioDelay = Number.isFinite(project.audioDelay) ? project.audioDelay : this.getAudioDelay();
    this.fitMode = true;
    this.speedIdx = 0;
    this.speeds = Array.isArray(project.speeds) ? clone(project.speeds) : [];
    this.speed = clamp(Number(project.speed) || 1, 0.1, 16);
    this.zooms = Array.isArray(project.zooms) ? clone(project.zooms) : [];
    this.overlays = Array.isArray(project.overlays) ? clone(project.overlays) : [];
    this.fx = Array.isArray(project.fx) ? clone(project.fx) : [];
    this.fxGlobal = project.fxGlobal ? clone(project.fxGlobal) : null;
    this.audioFx = { ...AUDIO_FX_DEFAULT, ...(project.audioFx || {}) };
    this.cursor = null;
    this.paths.clear();
    this.res.clear();
    this.ovMedia.innerHTML = '';
    this.fxKey = null;

    const tracks = (project.tracks || []).length;
    const notes = [];
    if (tracks) notes.push(`+ ${tracks === 2 ? 'câmera e tela separadas' : 'arquivo separado'} com os mesmos cortes`);
    if (project.editingFinal) notes.push('editando o vídeo final (os originais já foram descartados)');
    $('#cut-title-input').value = project.title || project.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    $('#cut-file').textContent = notes.join(' · ');
    $('#cut-file').title = project.path;
    this.player.style.aspectRatio = `${project.width || 16} / ${project.height || 9}`;
    $('#cut-discard').hidden = !project.original;
    $('#cut-speed').textContent = '1×';
    this.closePops();
    this.el.hidden = false;
    document.body.classList.add('editing');

    this.videoUrl = null;
    for (const v of [...this.players, this.thumbVideo, this.audio]) v.src = project.url;
    if (this.trans) this.clip.src = this.trans.url;
    else this.clip.removeAttribute('src');
    for (const v of [...this.players, this.clip, this.audio]) v.playbackRate = 1;
    const A = this.players[0];
    await new Promise((res) => {
      if (A.readyState >= 1) res();
      else A.addEventListener('loadedmetadata', res, { once: true });
      A.addEventListener('error', res, { once: true });
    });
    if (!this.duration && Number.isFinite(A.duration)) this.duration = A.duration;
    this.scenes = this.sanitizeScenes(project.scenes);
    this.removed = this.normalize(project.removed || []);
    this.inserts = [...(project.inserts || [])];
    this.applyDelay();
    this.buildSeq();
    this.layoutLanes();
    this.resize();
    this.show(0);
    this.seek(0);
    if (project.newScene) {
      const sc = this.sceneSpan(project.newScene);
      if (sc) this.seek(sc.o0);
    }
    this.panel.open();
    this.renderAll();
    this.loadWaveform();
    this.applyAudioFx();
    this.pendingPreview = null;
    const useWhenReady = (url) => {
      if (this.p !== project || !url) return;
      this.pendingPreview = url;
      if (!this.playing) this.usePreview();
    };
    this.api.media.previewVideo(project.path).then(useWhenReady)
      .then(() => this.api.media.proxyVideo(project.path)).then(useWhenReady).catch(() => {});
    if (project.folder && !project.editingFinal) {
      this.api.projectCursor(project.folder).then((c) => {
        if (this.p !== project || !Array.isArray(c) || !c.length) return;
        this.cursor = c;
        this.paths.clear();
        this.panel.render();
        this.renderPreview();
      }).catch(() => {});
    }
  }

  sanitizeScenes(list) {
    const D = this.duration;
    let out = Array.isArray(list) ? list.filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end)).map((s) => ({ ...s })) : [];
    if (!out.length) out = [{ id: 's1', name: 'Cena 1', start: 0, end: D }];
    // The last scene in source order runs to the end of the file.
    const bySrc = [...out].sort((a, b) => a.start - b.start);
    bySrc[0].start = 0;
    for (let i = 1; i < bySrc.length; i++) bySrc[i].start = bySrc[i - 1].end;
    bySrc[bySrc.length - 1].end = Math.max(bySrc[bySrc.length - 1].end, D);
    return out;
  }

  usePreview() {
    const url = this.pendingPreview;
    if (!url) return;
    this.pendingPreview = null;
    this.videoUrl = url;
    for (const v of [...this.players, this.thumbVideo]) v.src = url;
    this.players[0].addEventListener('loadedmetadata', () => this.seek(this.t), { once: true });
  }

  close() {
    this.pause();
    clearTimeout(this.saveTimer);
    for (const v of [...this.players, this.clip, this.thumbVideo, this.audio]) {
      v.removeAttribute('src');
      v.load();
    }
    this.dropOverlayMedia();
    this.closePops();
    this.el.hidden = true;
    document.body.classList.remove('editing');
    this.p = null;
  }

  dropOverlayMedia() {
    for (const r of this.res.values()) {
      if (r.video) { r.video.pause(); r.video.removeAttribute('src'); r.video.load(); }
    }
    this.res.clear();
    this.ovMedia.innerHTML = '';
  }

  // Windows keeps files open by a <video> locked: let go of them while the
  // export replaces the final file or moves the originals to the Recycle Bin.
  releaseMedia() {
    this.pause();
    for (const v of [...this.players, this.clip, this.thumbVideo, this.audio]) {
      v.removeAttribute('src');
      v.load();
    }
    this.dropOverlayMedia();
  }

  restoreMedia() {
    if (!this.p) return;
    for (const v of [this.thumbVideo, this.audio]) v.src = this.p.url;
    for (const v of this.players) v.src = this.videoUrl || this.p.url;
    if (this.trans) this.clip.src = this.trans.url;
    this.players[0].addEventListener('loadedmetadata', () => this.seek(this.t), { once: true });
    this.renderPreview();
  }

  refreshIntro() {
    if (!this.p) return;
    if (!this.introApplied) {
      const { intro, enabled } = this.getIntro(this.p);
      const changed = (intro && intro.url) !== (this.intro && this.intro.url);
      this.intro = intro;
      if (!intro) this.useIntro = false;
      else if (changed) this.useIntro = enabled;
    }
    const trans = this.getTransition(this.p);
    if ((trans && trans.url) !== (this.trans && this.trans.url)) {
      this.trans = trans;
      if (trans) this.clip.src = trans.url;
      this.buildSeq();
      this.resize();
    }
    $('#cut-intro').dataset.sig = '';
    this.renderAll();
  }

  async loadWaveform() {
    const project = this.p;
    if (project.hasAudio === false) {
      this.waveState = 'none';
      this.renderAll();
      return;
    }
    try {
      const buf = await this.api.media.waveform(project.path);
      if (this.p !== project) return;
      this.wave = new Float32Array(buf);
      this.db = new Float32Array(this.wave.length);
      for (let i = 0; i < this.wave.length; i++) this.db[i] = 20 * Math.log10(Math.max(this.wave[i], 1e-7));
      this.waveState = 'ready';
    } catch {
      this.waveState = 'none';
    }
    this.renderAll();
  }

  // ---------------------------------------------------------------- audio (lip sync preview + treatment)

  // Keeps the sound trailing the picture by the lip-sync delay.
  syncAudio(force = false) {
    const it = this.seq[this.item];
    const au = this.audio;
    if (!this.playing || !it || it.t !== 's') {
      if (!au.paused) au.pause();
      return;
    }
    const want = this.active.currentTime - this.audioDelay / 1000;
    if (want < 0) {
      if (!au.paused) au.pause(); // the first moments: the delayed audio has not started yet
      return;
    }
    if (force || Math.abs(au.currentTime - want) > 0.08) au.currentTime = want;
    if (au.paused) au.play().catch(() => {});
  }

  applyDelay() {
    if (this.seq && this.seq.length && this.p) setTimeout(() => this.seek(this.t), 0);
    if (this.playing) this.syncAudio(true);
    $('#cut-sync').innerHTML = `${icon('speaker', 15)} ${this.audioDelay} ms`;
    const input = $('#cut-sync-ms');
    input.value = this.audioDelay;
    input.style.setProperty('--p', `${(this.audioDelay / 400) * 100}%`);
    $('#cut-sync-val').textContent = `${this.audioDelay} ms`;
  }

  // Master volume and the 3-band EQ are heard live (one audio element through
  // Web Audio); noise reduction and the mic/computer balance need the
  // "Ouvir prévia" render.
  applyAudioFx() {
    const fx = this.audioFx;
    try {
      if (!this.ac) {
        this.ac = new AudioContext({ latencyHint: 'playback' });
        const srcNode = this.ac.createMediaElementSource(this.audio);
        this.eq = {
          bass: new BiquadFilterNode(this.ac, { type: 'lowshelf', frequency: 110 }),
          mid: new BiquadFilterNode(this.ac, { type: 'peaking', frequency: 1200, Q: 0.9 }),
          treble: new BiquadFilterNode(this.ac, { type: 'highshelf', frequency: 6000 }),
          gain: new GainNode(this.ac),
        };
        srcNode.connect(this.eq.bass).connect(this.eq.mid).connect(this.eq.treble).connect(this.eq.gain).connect(this.ac.destination);
      }
      this.eq.bass.gain.value = Number(fx.bass) || 0;
      this.eq.mid.gain.value = Number(fx.mid) || 0;
      this.eq.treble.gain.value = Number(fx.treble) || 0;
      this.eq.gain.gain.value = clamp(Number(fx.master) || 0, 0, 4);
    } catch {
      this.audio.volume = clamp(Number(fx.master) || 0, 0, 1);
    }
    for (const r of this.res.values()) if (r.video) r.video.volume = clamp((r.vol ?? 1) * fx.media * fx.master, 0, 1);
  }

  // ---------------------------------------------------------------- time math

  snap(t) {
    return clamp(Math.round(t * this.fps) / this.fps, 0, this.duration);
  }

  normalize(list) {
    const minLen = 1 / this.fps;
    const sorted = list
      .map(([a, b]) => [clamp(Math.min(a, b), 0, this.duration), clamp(Math.max(a, b), 0, this.duration)])
      .filter(([a, b]) => b - a >= minLen * 0.5)
      .sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + minLen) last[1] = Math.max(last[1], r[1]);
      else out.push([...r]);
    }
    return out;
  }

  keptRanges() {
    const out = [];
    let cur = 0;
    for (const [a, b] of this.removed) {
      if (a > cur) out.push([cur, a]);
      cur = Math.max(cur, b);
    }
    if (cur < this.duration) out.push([cur, this.duration]);
    return out.filter(([a, b]) => b - a >= 1 / this.fps);
  }

  transDur() {
    return this.trans ? Math.min(3, this.trans.duration) : 0;
  }

  speedAt(src) {
    const r = this.speeds.find(([a, b]) => src >= a && src < b);
    return clamp((r ? r[2] : 1) * this.speed, 0.1, 16);
  }

  // Output sequence: [{ t:'s', a, b, sp, scene, o0, o1 } | { t:'x', at, o0, o1 }]
  // Scenes play in their order; each one's kept pieces in source order.
  buildSeq() {
    const half = 0.5 / this.fps;
    const T = this.transDur();
    const ins = [...this.inserts].sort((x, y) => x - y);
    const bounds = [...new Set(this.speeds.flatMap(([a, b]) => [a, b]))].sort((x, y) => x - y);
    const kept = this.keptRanges();
    const items = [];
    let o = 0;
    for (const sc of this.scenes) {
      for (const [ka, kb] of kept) {
        const a0 = Math.max(ka, sc.start);
        const b0 = Math.min(kb, sc.end);
        if (b0 - a0 < 1 / this.fps) continue;
        const cuts = [...ins, ...bounds].filter((p) => p > a0 + half && p < b0 - half).sort((x, y) => x - y)
          .filter((p, i, arr) => i === 0 || p - arr[i - 1] > half);
        let start = a0;
        for (const p of [...cuts, b0]) {
          if (p - start < 1e-6) continue;
          const sp = this.speedAt((start + p) / 2);
          const len = (p - start) / sp;
          items.push({ t: 's', a: start, b: p, sp, scene: sc.id, o0: o, o1: o + len });
          o += len;
          if (T && ins.some((x) => Math.abs(x - p) < half)) {
            items.push({ t: 'x', at: p, o0: o, o1: o + T });
            o += T;
          }
          start = p;
        }
      }
    }
    while (items.length && items[items.length - 1].t === 'x') {
      o -= T;
      items.pop();
    }
    this.seq = items;
    this.outDur = o;
    // Seams: where a piece ends and the next item is a transition or another part of the recording.
    this.seams = [];
    items.forEach((it, i) => {
      if (it.t !== 's' || i === items.length - 1) return;
      const nx = items[i + 1];
      const continuous = nx.t === 's' && Math.abs(nx.a - it.b) < half;
      if (continuous) return;
      const removedIdx = this.removed.findIndex(([x]) => Math.abs(x - it.b) < half);
      this.seams.push({
        o: it.o1,
        at: it.b,
        removedIdx,
        transIdx: nx.t === 'x' ? i + 1 : -1,
        split: removedIdx < 0, // a seam made by a transition or a scene change
      });
    });
    this.seqVersion = (this.seqVersion || 0) + 1;
  }

  itemIndexAt(t) {
    const s = this.seq;
    if (!s.length) return -1;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].o0 <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  srcOf(t) {
    const it = this.seq[this.itemIndexAt(t)];
    if (!it || it.t !== 's') return null;
    return it.a + clamp((t - it.o0) * it.sp, 0, it.b - it.a);
  }

  outOfSrc(src) {
    for (const it of this.seq) if (it.t === 's' && src >= it.a && src < it.b) return it.o0 + (src - it.a) / it.sp;
    return null;
  }

  // Where an item anchored at source time `at` starts on the timeline (the next
  // kept moment if that instant was cut).
  anchorOut(at) {
    const o = this.outOfSrc(at);
    if (o != null) return o;
    let best = null;
    for (const it of this.seq) if (it.t === 's' && it.a >= at && (!best || it.a < best.a)) best = it;
    return best ? best.o0 : this.outDur;
  }

  // Source anchor for a timeline time (inside a transition: the piece after it).
  srcAtOut(t) {
    const s = this.srcOf(t);
    if (s != null) return s;
    const i = this.itemIndexAt(t);
    for (let k = i; k < this.seq.length; k++) if (this.seq[k].t === 's') return this.seq[k].a;
    return this.duration;
  }

  span(item) {
    const o0 = this.anchorOut(item.at);
    return { o0, o1: Math.min(this.outDur, o0 + Math.max(0.1, item.dur || 1)) };
  }

  sceneSpan(id) {
    let o0 = Infinity;
    let o1 = -Infinity;
    this.seq.forEach((it, i) => {
      if (it.t === 's' && it.scene === id) {
        o0 = Math.min(o0, it.o0);
        o1 = Math.max(o1, it.o1);
        const nx = this.seq[i + 1];
        if (nx && nx.t === 'x') o1 = Math.max(o1, nx.o1);
      }
    });
    return o0 < o1 ? { o0, o1 } : null;
  }

  introDur() {
    return this.useIntro && this.intro ? this.intro.duration : 0;
  }

  finalDuration() {
    return this.introDur() + this.outDur;
  }

  // ---------------------------------------------------------------- edits (with undo)

  snapshot() {
    return JSON.stringify({
      removed: this.removed,
      inserts: this.inserts,
      scenes: this.scenes,
      speeds: this.speeds,
      speed: this.speed,
      zooms: this.zooms,
      overlays: this.overlays,
      fx: this.fx,
      fxGlobal: this.fxGlobal,
      audioFx: this.audioFx,
    });
  }

  restoreSnapshot(json) {
    const s = JSON.parse(json);
    Object.assign(this, s);
    this.sel = null;
    this.focus = -1;
    if (this.selItem && !this.findItem(this.selItem)) this.selItem = null;
    this.paths.clear();
    this.applyAudioFx();
    this.afterEdit(this.t);
  }

  afterEdit(t) {
    this.buildSeq();
    this.layoutLanes();
    const keepFit = this.fitMode;
    if (keepFit) this.setPps(this.fitPps(), 0);
    else this.setPps(this.pps, this.scroller.scrollLeft);
    this.seek(Math.min(t, this.outDur));
    this.renderAll();
    this.autosave();
  }

  pushHistory(snap = this.snapshot()) {
    this.history.push(snap);
    if (this.history.length > 200) this.history.shift();
    this.future = [];
  }

  // Runs `fn` as one undoable change.
  change(fn, message = null, t = this.t) {
    const before = this.snapshot();
    fn();
    if (this.snapshot() === before) return false;
    this.pushHistory(before);
    this.afterEdit(t);
    if (message) this.toast(message, 'ok', 2500);
    return true;
  }

  apply(next, message, t = this.t) {
    const removed = this.normalize(next.removed);
    const keptLen = this.duration - removed.reduce((s, [a, b]) => s + (b - a), 0);
    if (keptLen < 0.5) {
      this.toast('Não dá para remover o vídeo inteiro.', 'error');
      return false;
    }
    this.pushHistory();
    this.removed = removed;
    this.inserts = next.inserts;
    this.sel = null;
    this.focus = -1;
    this.afterEdit(t);
    if (message) this.toast(message, 'ok', 2500);
    return true;
  }

  // Saves the work in progress (lessons recorded by the app), quietly.
  autosave() {
    if (!this.p || !this.p.folder || this.p.editingFinal) return;
    clearTimeout(this.saveTimer);
    const project = this.p;
    this.saveTimer = setTimeout(() => {
      if (this.p !== project) return;
      this.api.saveProject(project.folder, this.editState()).catch(() => {});
    }, 1500);
  }

  editState() {
    return {
      removed: this.removed,
      inserts: this.inserts,
      audioDelay: this.audioDelay,
      title: this.title(),
      scenes: this.scenes,
      speeds: this.speeds,
      speed: this.speed,
      zooms: this.zooms,
      overlays: this.overlays,
      fx: this.fx,
      fxGlobal: this.fxGlobal,
      audioFx: this.audioFx,
    };
  }

  // Removes an output span (it may cross several pieces and transitions).
  removeOut(oa, ob, message) {
    const removed = [...this.removed];
    let inserts = [...this.inserts];
    for (const it of this.seq) {
      const a = Math.max(oa, it.o0);
      const b = Math.min(ob, it.o1);
      if (b - a <= 1e-6) continue;
      if (it.t === 's') removed.push([this.snap(it.a + (a - it.o0) * it.sp), this.snap(it.a + (b - it.o0) * it.sp)]);
      else inserts = inserts.filter((x) => Math.abs(x - it.at) > 0.5 / this.fps);
    }
    this.apply({ removed, inserts }, message, oa);
  }

  // Source ranges covered by an output span (one per piece it crosses).
  srcRangesOf(oa, ob) {
    const out = [];
    for (const it of this.seq) {
      if (it.t !== 's') continue;
      const a = Math.max(oa, it.o0);
      const b = Math.min(ob, it.o1);
      if (b - a <= 1e-6) continue;
      out.push([this.snap(it.a + (a - it.o0) * it.sp), this.snap(it.a + (b - it.o0) * it.sp)]);
    }
    return out;
  }

  removeSelection() {
    if (this.sel) this.removeOut(this.sel.a, this.sel.b);
  }

  removeBefore() {
    if (this.t <= 0) return;
    this.removeOut(0, this.t, `Início cortado (${fmtLen(this.t)}).`);
  }

  removeAfter() {
    if (this.t >= this.outDur) return;
    this.removeOut(this.t, this.outDur, `Final cortado (${fmtLen(this.outDur - this.t)}).`);
  }

  restoreSeam(seam) {
    if (!seam || seam.removedIdx < 0) return;
    const [a, b] = this.removed[seam.removedIdx];
    this.apply({ removed: this.removed.filter((_, i) => i !== seam.removedIdx), inserts: this.inserts }, `Trecho de ${fmtLen(b - a)} restaurado.`, seam.o);
  }

  toggleTransition(seam) {
    if (!this.trans) {
      this.toast('Defina primeiro o vídeo de transição em Configurações.', 'info', 6000, { label: 'Configurar', onClick: () => this.onSetupTransition() });
      return;
    }
    const half = 0.5 / this.fps;
    const has = this.inserts.some((x) => Math.abs(x - seam.at) < half);
    const inserts = has ? this.inserts.filter((x) => Math.abs(x - seam.at) >= half) : [...this.inserts, seam.at];
    this.apply({ removed: this.removed, inserts }, null, seam.o ?? this.t);
  }

  // "Transição" button / T key: on a seam toggles it, elsewhere splits at the playhead.
  transitionAtPlayhead() {
    const near = this.seams.find((s) => Math.abs(s.o - this.t) * this.pps < 8 || Math.abs(s.o - this.t) < 0.05);
    if (near) {
      this.toggleTransition(near);
      return;
    }
    const src = this.srcOf(this.t);
    if (src != null) this.toggleTransition({ at: this.snap(src), o: this.t });
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(this.snapshot());
    this.restoreSnapshot(this.history.pop());
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(this.snapshot());
    this.restoreSnapshot(this.future.pop());
  }

  // ---------------------------------------------------------------- scenes

  moveScene(id, toIndex) {
    const from = this.scenes.findIndex((s) => s.id === id);
    if (from < 0) return;
    this.change(() => {
      const [sc] = this.scenes.splice(from, 1);
      this.scenes.splice(clamp(toIndex, 0, this.scenes.length), 0, sc);
    }, 'Ordem das cenas alterada. Ctrl+Z desfaz.');
  }

  renameScene(id, name) {
    const sc = this.scenes.find((s) => s.id === id);
    const v = String(name || '').trim().slice(0, 40);
    if (!sc || !v || v === sc.name) return;
    this.change(() => { sc.name = v; });
  }

  removeScene(id) {
    const sc = this.scenes.find((s) => s.id === id);
    if (!sc) return;
    this.apply({ removed: [...this.removed, [sc.start, sc.end]], inserts: this.inserts }, `“${sc.name}” removida. Ctrl+Z desfaz.`);
  }

  // ---------------------------------------------------------------- speed

  setGlobalSpeed(v) {
    const s = clamp(Math.round(Number(v) * 100) / 100, 0.1, 16);
    if (!Number.isFinite(s)) return;
    const ratio = this.outDur ? this.t / this.outDur : 0;
    this.change(() => { this.speed = s; }, null, 0);
    this.seek(ratio * this.outDur);
  }

  // Sets the speed of the selected stretch (1 = back to normal).
  setRangeSpeed(oa, ob, v) {
    const s = clamp(Math.round(Number(v) * 100) / 100, 0.1, 16);
    const ranges = this.srcRangesOf(oa, ob);
    if (!ranges.length || !Number.isFinite(s)) return;
    this.change(() => {
      let list = this.speeds;
      for (const [a, b] of ranges) {
        const next = [];
        for (const [x, y, sp] of list) {
          if (y <= a || x >= b) { next.push([x, y, sp]); continue; }
          if (x < a) next.push([x, a, sp]);
          if (y > b) next.push([b, y, sp]);
        }
        if (Math.abs(s - 1) > 1e-3) next.push([a, b, s]);
        list = next;
      }
      this.speeds = list.sort((p, q) => p[0] - q[0]);
      this.sel = null;
    }, `Velocidade do trecho: ${fmtSpeed(s)}`, oa);
  }

  removeSpeedRange(i) {
    this.change(() => { this.speeds.splice(i, 1); });
  }

  // ---------------------------------------------------------------- items (zoom / overlays / filters)

  listOf(lane) {
    return lane === 'zoom' ? this.zooms : lane === 'fx' ? this.fx : this.overlays;
  }

  findItem(ref) {
    if (!ref) return null;
    if (ref.lane === 'fxg') return this.fxGlobal;
    return this.listOf(ref.lane).find((x) => x.id === ref.id) || null;
  }

  get selected() {
    return this.findItem(this.selItem);
  }

  selectItem(ref) {
    this.selItem = ref;
    this.sel = null;
    this.focus = -1;
    this.panel.showFor(ref);
    this.renderAll();
  }

  // New item over the selection, or starting at the playhead.
  newSpan(dur) {
    if (this.sel && this.sel.b - this.sel.a > 0.1) return { o0: this.sel.a, d: this.sel.b - this.sel.a };
    const o0 = clamp(this.t, 0, Math.max(0, this.outDur - 0.2));
    return { o0, d: Math.min(dur, this.outDur - o0) };
  }

  addItem(lane, data, dur = 3) {
    const { o0, d } = this.newSpan(dur);
    const item = { id: uid(lane === 'zoom' ? 'z' : lane === 'fx' ? 'f' : 'o'), at: this.srcAtOut(o0), dur: Math.max(0.2, d), ...data };
    this.change(() => { this.listOf(lane).push(item); });
    this.selectItem({ lane, id: item.id });
    return item;
  }

  addZoom() {
    const it = this.addItem('zoom', { ...ZOOM_DEFAULT, mode: this.cursor ? 'follow' : 'fixed' }, 3);
    if (it && it.mode === 'follow') this.toast('Zoom que segue o mouse. Troque para “Ponto fixo” no painel se preferir.', 'ok', 4000);
  }

  // Live edit of an item (sliders, dragging): one undo step per gesture.
  beginEdit() {
    if (!this.editSnap) this.editSnap = this.snapshot();
  }

  updateItem(ref, patch, { commit = false, rebuild = false } = {}) {
    const it = this.findItem(ref);
    if (!it) return;
    this.beginEdit();
    Object.assign(it, patch);
    if (ref.lane === 'zoom') this.paths.delete(it.id);
    if (rebuild) this.layoutLanes();
    this.requestDraw();
    this.renderPreview();
    if (commit) this.endEdit();
  }

  endEdit() {
    if (this.editSnap && this.editSnap !== this.snapshot()) {
      this.pushHistory(this.editSnap);
      this.autosave();
    }
    this.editSnap = null;
    this.renderAll();
  }

  deleteItem(ref = this.selItem) {
    if (!ref) return;
    if (ref.lane === 'fxg') {
      this.change(() => { this.fxGlobal = null; }, 'Filtro removido.');
    } else {
      const list = this.listOf(ref.lane);
      this.change(() => {
        const i = list.findIndex((x) => x.id === ref.id);
        if (i >= 0) list.splice(i, 1);
      });
    }
    if (this.selItem && this.selItem.id === ref.id) this.selItem = null;
    this.panel.render();
    this.renderAll();
  }

  duplicateItem(ref = this.selItem) {
    const it = this.findItem(ref);
    if (!it || ref.lane === 'fxg') return;
    const { o1 } = this.span(it);
    const copy = { ...clone(it), id: uid('o'), at: this.srcAtOut(Math.min(o1, Math.max(0, this.outDur - it.dur))) };
    this.change(() => { this.listOf(ref.lane).push(copy); });
    this.selectItem({ lane: ref.lane, id: copy.id });
  }

  // Moves an item's start (and optionally its length) on the timeline.
  placeItem(it, o0, dur = it.dur) {
    const s = clamp(o0, 0, Math.max(0, this.outDur - 0.1));
    it.at = this.srcAtOut(s);
    it.dur = clamp(dur, 0.1, Math.max(0.1, this.outDur - s));
    this.paths.delete(it.id);
  }

  // Zooms as the export sees them: sorted, never overlapping, with mouse paths.
  resolvedZooms() {
    const list = this.zooms.map((z) => ({ ...z, ...this.span(z) })).sort((a, b) => a.o0 - b.o0);
    let end = 0;
    const out = [];
    for (const z of list) {
      const o0 = Math.max(z.o0, end);
      if (z.o1 - o0 < 0.15) continue;
      const r = { ...z, o0 };
      if (z.mode === 'follow' && this.cursor) {
        const key = `${this.seqVersion}|${o0.toFixed(3)}|${z.o1.toFixed(3)}|${z.scale}`;
        const cached = this.paths.get(z.id);
        if (cached && cached.key === key) r.path = cached.path;
        else {
          r.path = followPath(r, (s) => this.cursorAt(s), (t) => this.srcOf(t));
          this.paths.set(z.id, { key, path: r.path });
        }
      }
      out.push(r);
      end = z.o1;
    }
    return out;
  }

  // Mouse position (fractions of the frame) at a source time, from the samples taken while recording.
  cursorAt(src) {
    const c = this.cursor;
    if (!c || !c.length) return null;
    let lo = 0;
    let hi = c.length - 1;
    if (src <= c[0][0]) return c[0][1] < 0 ? null : [c[0][1], c[0][2]];
    if (src >= c[hi][0]) return c[hi][1] < 0 ? null : [c[hi][1], c[hi][2]];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid][0] <= src) lo = mid; else hi = mid;
    }
    const a = c[lo];
    const b = c[hi];
    if (b[0] - a[0] > 1.5 || a[1] < 0 || b[1] < 0) return a[1] < 0 ? (b[1] < 0 ? null : [b[1], b[2]]) : [a[1], a[2]];
    const f = (src - a[0]) / Math.max(1e-6, b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  activeFx(t) {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      const { o0, o1 } = this.span(f);
      if (t >= o0 && t < o1) return f;
    }
    return this.fxGlobal;
  }

  // ---------------------------------------------------------------- overlay media

  resFor(item) {
    if (item.kind === 'text' || item.kind === 'emoji') return null;
    const key = item.kind === 'sticker' ? `st|${item.sticker}|${item.color}` : `m|${item.id}|${item.src && item.src.url}`;
    let r = this.res.get(key);
    if (r) return r;
    r = { w: 0, h: 0 };
    this.res.set(key, r);
    if (item.kind === 'sticker' || (item.kind === 'image') || (item.kind === 'video' && /\.gif$/i.test(item.src.path || ''))) {
      const img = new Image();
      img.onload = () => { r.w = img.naturalWidth; r.h = img.naturalHeight; this.renderPreview(); };
      img.src = item.kind === 'sticker' ? stickerUrl(item.sticker, item.color) : item.src.url;
      r.img = img;
    } else if (item.kind === 'video') {
      const v = document.createElement('video');
      v.preload = 'auto';
      v.playsInline = true;
      v.src = item.src.url;
      v.addEventListener('loadedmetadata', () => { r.w = v.videoWidth; r.h = v.videoHeight; this.renderPreview(); });
      v.addEventListener('seeked', () => this.renderPreview());
      this.ovMedia.appendChild(v);
      r.video = v;
      r.vol = item.volume ?? 1;
    }
    return r;
  }

  // Keeps each video overlay playing in step with the timeline.
  syncOverlayVideos(t) {
    const live = new Set();
    for (const o of this.overlays) {
      if (o.kind !== 'video' || /\.gif$/i.test(o.src.path || '')) continue;
      const r = this.resFor(o);
      const v = r.video;
      live.add(v);
      const { o0, o1 } = this.span(o);
      r.vol = o.volume ?? 1;
      v.volume = clamp(r.vol * this.audioFx.media * this.audioFx.master, 0, 1);
      v.muted = r.vol <= 0.001;
      if (t >= o0 && t < o1) {
        const want = (o.trim || 0) + (t - o0);
        if (this.playing) {
          v.playbackRate = SPEEDS[this.speedIdx];
          if (Math.abs(v.currentTime - want) > 0.3) v.currentTime = want;
          if (v.paused) v.play().catch(() => {});
        } else {
          if (!v.paused) v.pause();
          if (Math.abs(v.currentTime - want) > 0.04) v.currentTime = want;
        }
      } else if (!v.paused) v.pause();
    }
    for (const r of this.res.values()) if (r.video && !live.has(r.video) && !r.video.paused) r.video.pause();
  }

  // ---------------------------------------------------------------- preview (zoom, filter, overlays)

  currentT() {
    const it = this.seq[this.item];
    if (!this.playing || !it) return this.t;
    if (it.t === 's') return it.o0 + clamp(this.active.currentTime - this.vOff - it.a, 0, it.b - it.a) / it.sp;
    return it.o0 + this.clip.currentTime;
  }

  renderPreview(t = this.currentT()) {
    if (!this.isOpen || !this.p) return;
    const W = this.p.width || 1920;
    const H = this.p.height || 1080;
    // zoom (while a zoom is selected and paused, the whole frame shows the zoom window instead)
    const zSel = this.selItem && this.selItem.lane === 'zoom' && !this.playing ? this.selected : null;
    const zs = zSel ? { z: 1, x0: 0, y0: 0 } : zoomState(this.resolvedZooms(), t);
    this.zoomWrap.style.transform = zs.z > 1.0001 ? `scale(${zs.z}) translate(${-zs.x0 * 100}%, ${-zs.y0 * 100}%)` : '';
    this.renderZoomRect(zSel);
    // color filter
    const f = this.activeFx(t);
    const key = f ? JSON.stringify(f.p) : '';
    const ph = this.player.clientHeight || 1;
    if (key !== this.fxKey || this.fxH !== ph) {
      this.fxKey = key;
      this.fxH = ph;
      this.fxWrap.style.filter = f && !isNeutral(f.p) ? cssFilter(f.p, 'cut-fx', { blurScale: ph / H }) : '';
      this.vignette.style.background = f ? vignetteCss(f.p) : 'none';
    }
    // overlays
    const cv = this.ovCanvas;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(2, Math.round(this.player.clientWidth * dpr));
    const ch = Math.max(2, Math.round(this.player.clientHeight * dpr));
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    const ctx = this.ovCtx;
    ctx.clearRect(0, 0, cw, ch);
    this.syncOverlayVideos(t);
    for (const o of this.overlays) {
      const { o0, o1 } = this.span(o);
      const selected = this.selItem && this.selItem.id === o.id;
      if (t < o0 || t >= o1) continue;
      drawItem(ctx, o, cw, ch, this.resFor(o), selected && !this.playing ? null : t - o0);
    }
    this.renderOvSelection(t);
  }

  // Selection frame (move / resize / rotate) over the selected overlay.
  renderOvSelection(t = this.t) {
    const box = this.ovSel;
    const o = this.selItem && this.selItem.lane === 'ov' ? this.selected : null;
    if (!o || this.playing) { box.hidden = true; return; }
    const { o0, o1 } = this.span(o);
    if (t < o0 - 1e-3 || t >= o1) { box.hidden = true; return; }
    const pw = this.player.clientWidth;
    const ph = this.player.clientHeight;
    const { w, h } = itemSize(o, pw, ph, this.resFor(o));
    const rot = (o.rot || 0) + (o.kind === 'text' ? mergeStyle(o.style).rot || 0 : 0);
    box.hidden = false;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.style.left = `${o.x * pw - w / 2}px`;
    box.style.top = `${o.y * ph - h / 2}px`;
    box.style.transform = rot ? `rotate(${rot}deg)` : '';
  }

  renderZoomRect(zm) {
    const r = this.zoomRect;
    if (!zm || zm.mode === 'follow') {
      r.hidden = true;
      if (zm && zm.mode === 'follow') {
        this.zoomRect.hidden = true;
      }
      return;
    }
    const z = Math.max(1, zm.scale);
    const x0 = clamp((zm.x ?? 0.5) - 0.5 / z, 0, 1 - 1 / z);
    const y0 = clamp((zm.y ?? 0.5) - 0.5 / z, 0, 1 - 1 / z);
    r.hidden = false;
    r.style.left = `${x0 * 100}%`;
    r.style.top = `${y0 * 100}%`;
    r.style.width = `${100 / z}%`;
    r.style.height = `${100 / z}%`;
    r.querySelector('span').textContent = `${fmtSpeed(z).replace('×', '×')} · arraste para escolher o ponto`;
  }

  // Topmost overlay under a point of the player (px).
  overlayAt(px, py) {
    const pw = this.player.clientWidth;
    const ph = this.player.clientHeight;
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const o = this.overlays[i];
      const { o0, o1 } = this.span(o);
      if (this.t < o0 - 1e-3 || this.t >= o1) continue;
      const { w, h } = itemSize(o, pw, ph, this.resFor(o));
      const rot = (((o.rot || 0) + (o.kind === 'text' ? mergeStyle(o.style).rot || 0 : 0)) * Math.PI) / 180;
      const dx = px - o.x * pw;
      const dy = py - o.y * ph;
      const lx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
      const ly = dx * Math.sin(-rot) + dy * Math.cos(-rot);
      if (Math.abs(lx) <= w / 2 + 4 && Math.abs(ly) <= h / 2 + 4) return o;
    }
    return null;
  }

  bindPreview() {
    const local = (e) => {
      const r = this.player.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, pw: r.width, ph: r.height };
    };
    // click: select an overlay (and drag it) or play/pause
    this.ovCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = local(e);
      if (this.playing) { this.togglePlay(); return; }
      const o = this.overlayAt(p.x, p.y);
      if (!o) {
        this.pdown = { x: p.x, y: p.y };
        return;
      }
      if (!this.selItem || this.selItem.id !== o.id) this.selectItem({ lane: 'ov', id: o.id });
      this.ovDrag = { mode: 'move', id: o.id, sx: p.x, sy: p.y, ox: o.x, oy: o.y };
      this.ovCanvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.ovCanvas.addEventListener('dblclick', (e) => {
      const p = local(e);
      const o = this.overlayAt(p.x, p.y);
      if (o && o.kind === 'text') this.panel.focusText();
    });
    this.ovSel.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('[data-h]');
      const o = this.selected;
      if (!o || e.button !== 0) return;
      const p = local(e);
      const pw = p.pw;
      const ph = p.ph;
      const cx = o.x * pw;
      const cy = o.y * ph;
      if (h && h.dataset.h === 'rot') {
        this.ovDrag = { mode: 'rot', id: o.id, cx, cy, r0: o.rot || 0, a0: Math.atan2(p.y - cy, p.x - cx) };
      } else if (h) {
        this.ovDrag = {
          mode: 'size', id: o.id, cx, cy, d0: Math.hypot(p.x - cx, p.y - cy) || 1,
          size0: o.kind === 'text' ? mergeStyle(o.style).size : (o.w || 0.25),
        };
      } else {
        this.ovDrag = { mode: 'move', id: o.id, sx: p.x, sy: p.y, ox: o.x, oy: o.y };
      }
      this.ovSel.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    const move = (e) => {
      const d = this.ovDrag;
      if (!d) return;
      const o = this.overlays.find((x) => x.id === d.id);
      if (!o) return;
      const p = local(e);
      const ref = { lane: 'ov', id: o.id };
      if (d.mode === 'move') {
        let x = d.ox + (p.x - d.sx) / p.pw;
        let y = d.oy + (p.y - d.sy) / p.ph;
        // snap to the center lines
        if (Math.abs(x - 0.5) * p.pw < 6) x = 0.5;
        if (Math.abs(y - 0.5) * p.ph < 6) y = 0.5;
        this.updateItem(ref, { x: clamp(x, -0.2, 1.2), y: clamp(y, -0.2, 1.2) });
      } else if (d.mode === 'size') {
        const k = Math.hypot(p.x - d.cx, p.y - d.cy) / d.d0;
        if (o.kind === 'text') this.updateItem(ref, { style: { ...o.style, size: Math.round(clamp(d.size0 * k, 8, 400)) } });
        else this.updateItem(ref, { w: clamp(d.size0 * k, 0.02, 2) });
      } else if (d.mode === 'rot') {
        let r = d.r0 + ((Math.atan2(p.y - d.cy, p.x - d.cx) - d.a0) * 180) / Math.PI;
        r = ((r + 540) % 360) - 180;
        if (Math.abs(r) < 3) r = 0;
        this.updateItem(ref, { rot: Math.round(r) });
      }
      this.panel.syncSelected();
    };
    const up = (e) => {
      if (this.pdown) {
        const p = local(e);
        if (Math.hypot(p.x - this.pdown.x, p.y - this.pdown.y) < 5) {
          if (this.selItem && this.selItem.lane === 'ov') this.selectItem(null);
          else this.togglePlay();
        }
        this.pdown = null;
      }
      if (!this.ovDrag) return;
      this.ovDrag = null;
      this.endEdit();
    };
    for (const el of [this.ovCanvas, this.ovSel]) {
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
    // zoom window: drag to choose the point
    this.zoomRect.addEventListener('pointerdown', (e) => {
      const zm = this.selected;
      if (!zm || e.button !== 0) return;
      const p = local(e);
      this.zDrag = { sx: p.x, sy: p.y, x: zm.x ?? 0.5, y: zm.y ?? 0.5 };
      this.zoomRect.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.zoomRect.addEventListener('pointermove', (e) => {
      const d = this.zDrag;
      const zm = this.selected;
      if (!d || !zm) return;
      const p = local(e);
      const z = Math.max(1, zm.scale);
      const half = 0.5 / z;
      this.updateItem(this.selItem, {
        x: clamp(d.x + (p.x - d.sx) / p.pw, half, 1 - half),
        y: clamp(d.y + (p.y - d.sy) / p.ph, half, 1 - half),
      });
    });
    const zUp = () => { if (this.zDrag) { this.zDrag = null; this.endEdit(); } };
    this.zoomRect.addEventListener('pointerup', zUp);
    this.zoomRect.addEventListener('pointercancel', zUp);
    new ResizeObserver(() => { if (this.isOpen) { this.fxKey = null; this.renderPreview(); } }).observe(this.player);
  }

  // ---------------------------------------------------------------- pause detection

  // Loudness over a 240 ms window: short dips between syllables don't count as
  // pauses, and quiet background (room noise, a faint video) does.
  smoothedDb() {
    if (this.sdb) return this.sdb;
    const rms = this.wave;
    const n = rms.length;
    const half = 6;
    const acc = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) acc[i + 1] = acc[i] + rms[i] * rms[i];
    this.sdb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(n, i + half);
      this.sdb[i] = 10 * Math.log10(Math.max((acc[b] - acc[a]) / (b - a), 1e-14));
    }
    return this.sdb;
  }

  detectPauses(minPause) {
    if (!this.wave || this.wave.length < 10) return [];
    const db = this.smoothedDb();
    const sorted = Float32Array.from(db).sort();
    const noise = sorted[Math.floor(sorted.length * 0.1)];
    const speech = sorted[Math.floor(sorted.length * 0.9)];
    if (speech - noise < 10) return [];
    const thr = Math.max(noise + 8, speech - 14);
    const pad = 0.2;
    const out = [];
    let start = -1;
    const n = db.length;
    for (let i = 0; i <= n; i++) {
      const loud = i < n && db[i] > thr;
      if (!loud && start < 0 && i < n) start = i;
      if ((loud || i === n) && start >= 0) {
        const t0 = start * BIN;
        const t1 = Math.min(i * BIN, this.duration);
        if (t1 - t0 >= minPause) {
          // Word endings (a final "s", breath-out) trail off quietly: keep 300 ms
          // after speech and 150 ms before it starts again.
          const a = t0 <= 0.05 ? 0 : t0 + pad + 0.1;
          const b = t1 >= this.duration - 0.05 ? this.duration : t1 - 0.15;
          if (b - a >= 0.2) out.push([this.snap(a), this.snap(b)]);
        }
        start = -1;
      }
    }
    return out.filter(([a, b]) => !this.removed.some(([x, y]) => a >= x && b <= y));
  }

  openPausePop() {
    if (this.waveState !== 'ready') {
      this.toast(this.waveState === 'loading' ? 'Aguarde: analisando o áudio…' : 'Este vídeo não tem áudio para detectar pausas.');
      return;
    }
    this.syncPop.hidden = true;
    this.pop.hidden = false;
    this.updatePop();
  }

  closePops() {
    this.pop.hidden = true;
    this.syncPop.hidden = true;
    this.candidates = null;
    this.requestDraw();
  }

  updatePop() {
    const input = $('#cut-pause-min');
    const min = Number(input.value);
    input.style.setProperty('--p', `${((min - 0.5) / 2.5) * 100}%`);
    $('#cut-pause-val').textContent = `${min.toFixed(1).replace('.', ',')} s`;
    this.candidates = this.detectPauses(min);
    const total = this.candidates.reduce((s, [a, b]) => s + (b - a), 0);
    $('#cut-pause-result').innerHTML = this.candidates.length
      ? `<b>${this.candidates.length}</b> ${this.candidates.length === 1 ? 'pausa encontrada' : 'pausas encontradas'} · <b>−${fmtLen(total)}</b>`
      : 'Nenhuma pausa desse tamanho.';
    $('#cut-pause-apply').disabled = !this.candidates.length;
    this.requestDraw();
  }

  applyPauses() {
    const list = this.candidates || [];
    if (!list.length) return;
    const total = list.reduce((s, [a, b]) => s + (b - a), 0);
    this.closePops();
    this.apply(
      { removed: [...this.removed, ...list], inserts: this.inserts },
      `${list.length} ${list.length === 1 ? 'pausa removida' : 'pausas removidas'} (−${fmtLen(total)}). Ctrl+Z desfaz.`,
      0,
    );
  }

  // ---------------------------------------------------------------- playback (two players in turns)

  show(el) {
    const target = typeof el === 'number' ? this.players[el] : el;
    for (const v of [...this.players, this.clip]) v.classList.toggle('on', v === target);
  }

  // Cuts live in audio time (the waveform). The camera delivers frames late by
  // the lip-sync delay, so the picture is read that much ahead of the sound.
  get vOff() {
    return this.audioDelay / 1000;
  }

  vt(src) {
    return Math.max(0, src + this.vOff);
  }

  rateOf(it) {
    return SPEEDS[this.speedIdx] * (it && it.t === 's' ? it.sp : 1);
  }

  // Playback rate of the current piece (shuttle speed x the piece's own speed).
  applyRate() {
    const it = this.seq[this.item];
    const r = clamp(this.rateOf(it), 0.0625, 16);
    if (this.active.playbackRate !== r) this.active.playbackRate = r;
    if (this.audio.playbackRate !== r) this.audio.playbackRate = r;
    this.clip.playbackRate = SPEEDS[this.speedIdx];
  }

  // Cue the idle player at the start of the next piece, so the seam is instant.
  prepareNext() {
    const idle = this.players[1 - this.cur];
    const cur = this.seq[this.item];
    for (let i = this.item + 1; i < this.seq.length; i++) {
      const it = this.seq[i];
      if (it.t !== 's') continue;
      if (cur && cur.t === 's' && Math.abs(it.a - cur.b) < 1 / this.fps) return; // continuous: same player
      if (Math.abs(idle.currentTime - this.vt(it.a)) > 0.04) idle.currentTime = this.vt(it.a);
      return;
    }
  }

  seek(t) {
    this.stopReverse();
    if (this.prerolled) { this.prerolled.pause(); this.prerolled = null; }
    this.t = clamp(t, 0, this.outDur);
    const idx = Math.max(0, this.itemIndexAt(Math.min(this.t, Math.max(0, this.outDur - 1e-3))));
    const it = this.seq[idx];
    this.item = idx;
    if (it) {
      if (it.t === 's') {
        const v = this.active;
        v.currentTime = this.vt(it.a + clamp((this.t - it.o0) * it.sp, 0, it.b - it.a));
        this.show(v);
        if (this.playing) {
          this.clip.pause();
          v.play().catch(() => {});
        }
      } else {
        this.clip.currentTime = clamp(this.t - it.o0, 0, it.o1 - it.o0);
        this.show(this.clip);
        if (this.playing) {
          this.active.pause();
          this.clip.play().catch(() => {});
        }
      }
      this.applyRate();
      this.prepareNext();
      if (this.playing) {
        this.watchFrames();
        this.syncAudio(true);
      }
    }
    this.renderTime();
    this.requestDraw(false);
    this.renderPreview(this.t);
  }

  togglePlay() {
    if (this.playing || this.reverseTimer) this.pause();
    else this.play();
  }

  play() {
    if (!this.seq.length) return;
    this.stopReverse();
    if (this.ac && this.ac.state !== 'running') this.ac.resume().catch(() => {});
    if (this.t >= this.outDur - 0.05) this.seek(0);
    this.playing = true;
    const it = this.seq[this.item];
    this.applyRate();
    (it && it.t === 'x' ? this.clip : this.active).play().catch(() => {});
    this.syncAudio(true);
    this.watchFrames();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 40);
    const loop = () => {
      if (!this.playing) return;
      this.renderPreview();
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
    this.renderPlay();
  }

  pause() {
    this.stopReverse();
    this.playing = false;
    this.prerolled = null;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    for (const v of [...this.players, this.clip, this.audio]) v.pause();
    for (const r of this.res.values()) if (r.video) r.video.pause();
    this.clip.volume = 1;
    this.renderPlay();
    this.renderTime();
    if (this.pendingPreview) this.usePreview();
    if (this.p) this.renderPreview(this.t);
  }

  // ---- J / K / L (shuttle): L plays faster on each press, J plays backwards, K stops.
  setSpeed(idx, flash = true) {
    this.speedIdx = clamp(idx, 0, SPEEDS.length - 1);
    const rate = SPEEDS[this.speedIdx];
    this.applyRate();
    $('#cut-speed').textContent = `${String(rate).replace('.', ',')}×`;
    if (flash) this.flashRate(`${String(rate).replace('.', ',')}×`);
  }

  flashRate(text) {
    const el = $('#cut-rate-flag');
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { el.hidden = true; }, 900);
  }

  shuttleForward() {
    if (this.reverseTimer) { this.stopReverse(); this.setSpeed(0); this.play(); return; }
    if (!this.playing) { this.setSpeed(0); this.play(); return; }
    this.setSpeed(this.speedIdx + 1);
  }

  shuttleBack() {
    if (this.playing) this.pause();
    this.reverseRate = this.reverseTimer ? Math.min(8, this.reverseRate * 2) : 2;
    this.flashRate(`◀◀ ${this.reverseRate}×`);
    if (this.reverseTimer) return;
    this.reverseTimer = setInterval(() => {
      const t = this.t - 0.1 * this.reverseRate;
      if (t <= 0) { this.seek(0); return; }
      const keep = this.reverseTimer;
      this.reverseTimer = null; // seek() would stop the shuttle
      this.seek(t);
      this.reverseTimer = keep;
    }, 100);
    this.renderPlay();
  }

  stopReverse() {
    if (!this.reverseTimer) return;
    clearInterval(this.reverseTimer);
    this.reverseTimer = null;
    this.renderPlay();
  }

  // Frame-accurate seams: switch right after the last kept frame is shown.
  watchFrames() {
    const v = this.active;
    if (!v.requestVideoFrameCallback || this.watching === v) return;
    this.watching = v;
    const onFrame = (_now, meta) => {
      if (!this.playing || v !== this.active) { this.watching = null; return; }
      const it = this.seq[this.item];
      if (it && it.t === 's' && meta.mediaTime - this.vOff >= it.b - 1.5 / this.fps) {
        this.watching = null;
        this.advance();
        return;
      }
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  advance() {
    const nextIdx = this.item + 1;
    const cur = this.seq[this.item];
    const nx = this.seq[nextIdx];
    if (!nx) {
      this.pause();
      this.t = this.outDur;
      return;
    }
    if (nx.t === 's') {
      if (cur.t === 's' && Math.abs(nx.a - cur.b) < 1 / this.fps) {
        this.item = nextIdx; // continuous: keep playing on the same player (maybe at another speed)
        this.applyRate();
        if (this.active.requestVideoFrameCallback && !this.watching) this.watchFrames();
      } else {
        const idle = this.players[1 - this.cur];
        if (Math.abs(idle.currentTime - this.vt(nx.a)) > 0.04) idle.currentTime = this.vt(nx.a);
        idle.playbackRate = clamp(this.rateOf(nx), 0.0625, 16);
        idle.play().catch(() => {});
        this.prerolled = null;
        this.show(idle);
        this.active.pause();
        this.clip.pause();
        this.cur = 1 - this.cur;
        this.item = nextIdx;
        this.applyRate();
        this.watchFrames();
      }
      this.syncAudio(true);
    } else {
      this.clip.currentTime = 0;
      this.clip.volume = 1;
      this.clip.play().catch(() => {});
      this.prerolled = null;
      this.show(this.clip);
      this.active.pause();
      this.item = nextIdx;
      this.applyRate();
      this.syncAudio();
    }
    this.prepareNext();
  }

  // Wake the next player shortly before the seam (Chromium lets idle players
  // sleep): play it briefly at the first frame of the next piece and park it
  // there, so it starts instantly when the current piece ends.
  preroll(it, remaining) {
    const lead = 0.4 + 0.5 * SPEEDS[this.speedIdx];
    if (this.prerolled || remaining > lead) return;
    const nx = this.seq[this.item + 1];
    if (nx && nx.t === 'x') {
      this.prerolled = this.clip;
      this.clip.volume = 0;
      this.clip.currentTime = 0;
      this.clip.play().catch(() => {});
      return;
    }
    if (!nx || nx.t !== 's' || Math.abs(nx.a - it.b) < 1 / this.fps) return;
    const idle = this.players[1 - this.cur];
    const start = this.vt(nx.a);
    this.prerolled = idle;
    if (remaining < 0.25) {
      if (Math.abs(idle.currentTime - start) > 0.04) idle.currentTime = start; // no time to warm: just cue
      return;
    }
    idle.currentTime = start;
    idle.play().catch(() => {});
    const park = () => {
      if (this.prerolled !== idle || idle === this.active) return;
      idle.pause();
      idle.currentTime = start;
    };
    if (idle.requestVideoFrameCallback) idle.requestVideoFrameCallback(park);
    else setTimeout(park, 120);
  }

  // Runs on a timer (keeps going even if the window is covered); the
  // frame callback above handles seams precisely while the video is visible.
  tick() {
    if (!this.playing || !this.isOpen) return;
    const it = this.seq[this.item];
    if (it) {
      if (it.t === 's') {
        const src = this.active.currentTime - this.vOff;
        this.t = it.o0 + clamp(src - it.a, 0, it.b - it.a) / it.sp;
        if (src >= it.b - 0.5 / this.fps || this.active.ended) this.advance();
        else {
          this.syncAudio();
          this.preroll(it, (it.b - src) / it.sp / SPEEDS[this.speedIdx]);
        }
      } else {
        this.t = it.o0 + this.clip.currentTime;
        if (this.clip.currentTime >= it.o1 - it.o0 - 0.03 || this.clip.ended) this.advance();
      }
    }
    const x = (this.t - this.viewStart) * this.pps;
    if (x > this.viewW - 40 || x < 0) this.scroller.scrollLeft = Math.max(0, this.t * this.pps - this.viewW * 0.2);
    this.renderTime();
    this.requestDraw(false);
  }

  // ---------------------------------------------------------------- lanes / zoom / layout

  // Lanes under the waveform: scenes, zooms, texts & media (as many rows as
  // needed so nothing overlaps), filters.
  layoutLanes() {
    const spans = this.overlays.map((o) => ({ id: o.id, ...this.span(o) })).sort((a, b) => a.o0 - b.o0);
    const ends = [];
    this.ovRow = new Map();
    for (const s of spans) {
      let r = ends.findIndex((e) => e <= s.o0 + 1e-3);
      if (r < 0) {
        if (ends.length < MAX_OV_ROWS) r = ends.length;
        else r = ends.indexOf(Math.min(...ends));
      }
      ends[r] = s.o1;
      this.ovRow.set(s.id, r);
    }
    const rows = Math.max(1, ends.length);
    const lanes = [];
    let y = RULER + 4 + MAIN_H + 8;
    const add = (key, label, extra = {}) => {
      lanes.push({ key, label, y, h: LANE_H, ...extra });
      y += LANE_H + LANE_GAP;
    };
    add('scene', 'Cenas');
    add('zoom', 'Zoom');
    for (let r = 0; r < rows; r++) add('ov', r === 0 ? 'Textos e mídias' : '', { row: r });
    add('fx', 'Filtros');
    this.lanes = lanes;
    const total = y + 2;
    if (this.laneTotal !== total) {
      this.laneTotal = total;
      this.inner.style.height = `${total}px`;
      this.scroller.style.height = `${total + 12}px`;
      if (this.isOpen) requestAnimationFrame(() => this.resize());
    }
  }

  laneAt(y) {
    return this.lanes.find((l) => y >= l.y - 2 && y < l.y + l.h + 2) || null;
  }

  // Item of a lane under x (with which edge, if near one).
  laneItemAt(lane, x) {
    const list = lane.key === 'zoom' ? this.zooms : lane.key === 'fx' ? this.fx : this.overlays.filter((o) => this.ovRow.get(o.id) === lane.row);
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      const { o0, o1 } = this.span(it);
      const x0 = this.xOf(o0);
      const x1 = this.xOf(o1);
      if (x >= x0 - 5 && x <= x1 + 5) {
        const edge = x1 - x0 > 16 && Math.abs(x - x0) < 7 ? 'a' : x1 - x0 > 16 && Math.abs(x - x1) < 7 ? 'b' : null;
        return { it, edge, o0, o1 };
      }
    }
    return null;
  }

  sceneAt(x) {
    const t = this.tOf(x);
    for (const sc of this.scenes) {
      const s = this.sceneSpan(sc.id);
      if (s && t >= s.o0 && t <= s.o1) return { sc, ...s };
    }
    return null;
  }

  resize() {
    const w = this.scroller.clientWidth;
    const h = this.canvas.parentElement.clientHeight || 120;
    const dpr = window.devicePixelRatio || 1;
    this.viewW = w;
    this.viewH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.fitMode || this.pps < this.fitPps()) this.setPps(this.fitPps(), 0);
    else this.setPps(this.pps, this.t * this.pps - w / 2);
  }

  fitPps() {
    return this.outDur > 0 ? Math.max(0.01, (this.viewW - 2) / this.outDur) : 10;
  }

  setPps(pps, scrollLeft) {
    this.pps = clamp(pps, this.fitPps(), Math.max(MAX_PPS, this.fitPps()));
    this.fitMode = Math.abs(this.pps - this.fitPps()) < 1e-6;
    this.inner.style.width = `${Math.ceil(this.outDur * this.pps)}px`;
    this.scroller.scrollLeft = scrollLeft;
    this.onScroll();
  }

  zoomAt(factor, x) {
    const t = this.viewStart + x / this.pps;
    const pps = clamp(this.pps * factor, this.fitPps(), MAX_PPS);
    this.setPps(pps, t * pps - x);
  }

  onScroll() {
    this.viewStart = this.scroller.scrollLeft / this.pps;
    this.canvas.style.left = `${this.scroller.scrollLeft}px`;
    this.requestDraw();
    this.renderBubble();
  }

  xOf(t) {
    return (t - this.viewStart) * this.pps;
  }

  tOf(x) {
    return clamp(this.viewStart + x / this.pps, 0, this.outDur);
  }

  snapOut(t) {
    return clamp(Math.round(t * this.fps) / this.fps, 0, this.outDur);
  }

  seamAt(x) {
    let best = -1;
    let dist = 7;
    this.seams.forEach((s, i) => {
      const d = Math.abs(this.xOf(s.o) - x);
      if (d < dist) { dist = d; best = i; }
    });
    if (best >= 0) return best;
    // clicking a transition block focuses its seam
    const t = this.tOf(x);
    return this.seams.findIndex((s) => s.transIdx >= 0 && t >= this.seq[s.transIdx].o0 && t <= this.seq[s.transIdx].o1);
  }

  // ---------------------------------------------------------------- events

  bind() {
    this.scroller.addEventListener('scroll', () => this.onScroll());
    new ResizeObserver(() => { if (this.isOpen) this.resize(); }).observe(this.scroller);
    this.bindPreview();
    this.clip.addEventListener('click', () => this.togglePlay());

    const c = this.scroller;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e));
    c.addEventListener('dblclick', (e) => this.dbl(e));
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.hoverBox.hidden = true; this.requestDraw(); } });
    c.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        this.zoomAt(Math.exp(-e.deltaY * 0.002), this.local(e).x);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !this.fitMode) {
        e.preventDefault();
        c.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    this.thumbVideo.addEventListener('seeked', () => {
      this.thumbCanvas.getContext('2d').drawImage(this.thumbVideo, 0, 0, this.thumbCanvas.width, this.thumbCanvas.height);
      if (this.pendingThumb != null) {
        const t = this.pendingThumb;
        this.pendingThumb = null;
        this.thumbVideo.currentTime = t;
      }
    });

    this.bubble.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.bubble.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const seam = this.seams[this.focus];
      if (act === 'remove') this.removeSelection();
      else if (act === 'clear') { this.sel = null; this.renderAll(); }
      else if (act === 'restore') this.restoreSeam(seam);
      else if (act === 'transition' && seam) this.toggleTransition(seam);
      else if (act === 'zoom') this.addZoom();
      else if (act === 'text') this.panel.addText();
      else if (act === 'fx') this.panel.setTab('filtros');
      else if (act === 'speed') this.panel.setTab('velocidade');
    });

    $('#cut-play').addEventListener('click', () => this.togglePlay());
    $('#cut-speed').addEventListener('click', () => {
      this.setSpeed((this.speedIdx + 1) % SPEEDS.length);
    });
    $('#cut-sync').addEventListener('click', () => {
      const open = this.syncPop.hidden;
      this.closePops();
      this.syncPop.hidden = !open;
    });
    $('#cut-sync-ms').addEventListener('input', (e) => {
      this.audioDelay = Number(e.target.value);
      this.applyDelay();
    });
    $('#cut-sync-ms').addEventListener('change', () => { this.onAudioDelay(this.audioDelay); this.autosave(); });
    $('#cut-sync-reset').addEventListener('click', () => {
      this.audioDelay = 0;
      this.applyDelay();
      this.onAudioDelay(0);
    });
    $('#cut-remove').addEventListener('click', () => this.removeSelection());
    $('#cut-trim-start').addEventListener('click', () => this.removeBefore());
    $('#cut-trim-end').addEventListener('click', () => this.removeAfter());
    $('#cut-transition').addEventListener('click', () => this.transitionAtPlayhead());
    $('#cut-pauses').addEventListener('click', () => (this.pop.hidden ? this.openPausePop() : this.closePops()));
    $('#cut-pause-min').addEventListener('input', () => this.updatePop());
    $('#cut-pause-apply').addEventListener('click', () => this.applyPauses());
    $('#cut-pause-cancel').addEventListener('click', () => this.closePops());
    $('#cut-undo').addEventListener('click', () => this.undo());
    $('#cut-redo').addEventListener('click', () => this.redo());
    $('#cut-zoom-in').addEventListener('click', () => this.zoomAt(1.8, this.xOf(this.t)));
    $('#cut-zoom-out').addEventListener('click', () => this.zoomAt(1 / 1.8, this.xOf(this.t)));
    $('#cut-zoom-fit').addEventListener('click', () => this.setPps(this.fitPps(), 0));

    $('#cut-export').addEventListener('click', () => this.exportNow());
    $('#cut-back').addEventListener('click', () => this.leave());
    $('#cut-discard').addEventListener('click', () => this.discard());
    $('#cut-intro').addEventListener('click', (e) => {
      if (e.target.closest('[data-intro-setup]')) { this.onSetupIntro(); return; }
      const sw = e.target.closest('input[type=checkbox]');
      if (sw) { this.useIntro = sw.checked; this.renderAll(); }
    });

    document.addEventListener('keydown', (e) => this.key(e));
  }

  local(e) {
    const r = this.scroller.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  down(e) {
    if (e.button !== 0 || !this.outDur) return;
    const { x, y } = this.local(e);
    if (y > this.viewH) return; // native scrollbar
    this.closePops();
    const t = this.tOf(x);
    const lane = y >= RULER + 4 + MAIN_H + 4 ? this.laneAt(y) : null;
    if (y < RULER) {
      this.drag = { mode: 'scrub' };
      this.seek(t);
    } else if (lane) {
      this.laneDown(lane, x, t);
      if (!this.drag) return;
    } else if (y > RULER + 4 + MAIN_H + 4) {
      return;
    } else if (this.sel && Math.abs(x - this.xOf(this.sel.a)) < 7) {
      this.drag = { mode: 'edge', edge: 'a' };
    } else if (this.sel && Math.abs(x - this.xOf(this.sel.b)) < 7) {
      this.drag = { mode: 'edge', edge: 'b' };
    } else {
      if (this.selItem) { this.selItem = null; this.panel.showFor(null); }
      this.drag = { mode: 'select', anchor: this.snapOut(t), startX: x, moved: false };
    }
    this.scroller.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  laneDown(lane, x, t) {
    if (lane.key === 'scene') {
      const hit = this.sceneAt(x);
      if (!hit) return;
      this.drag = { mode: 'scene', id: hit.sc.id, startX: x, moved: false, target: null };
      return;
    }
    const hit = this.laneItemAt(lane, x);
    if (!hit) {
      // empty spot: move the playhead there (and drop the item selection)
      if (this.selItem) this.selectItem(null);
      this.seek(t);
      return;
    }
    const laneKey = lane.key === 'ov' ? 'ov' : lane.key;
    const ref = { lane: laneKey, id: hit.it.id };
    if (!this.selItem || this.selItem.id !== hit.it.id) this.selectItem(ref);
    this.beginEdit();
    this.drag = { mode: 'item', ref, edge: hit.edge, grab: t - hit.o0, o0: hit.o0, o1: hit.o1, startX: x, moved: false };
    if (!hit.edge) this.seek(clamp(t, hit.o0, hit.o1 - 0.01));
  }

  dbl(e) {
    const { x, y } = this.local(e);
    const lane = this.laneAt(y);
    if (!lane || y < RULER + 4 + MAIN_H) return;
    if (this.laneItemAt(lane, x)) return;
    this.seek(this.tOf(x));
    if (lane.key === 'zoom') this.addZoom();
    else if (lane.key === 'ov') this.panel.addText();
    else if (lane.key === 'fx') this.panel.setTab('filtros');
  }

  move(e) {
    const { x, y } = this.local(e);
    const t = this.tOf(x);
    this.hover = { x, t };
    if (y < RULER + 4 + MAIN_H + 4) this.showThumb(x, t);
    else this.hoverBox.hidden = true;
    const d = this.drag;
    if (!d) {
      const lane = y >= RULER + 4 + MAIN_H + 4 ? this.laneAt(y) : null;
      let cursor = 'text';
      if (y < RULER) cursor = 'pointer';
      else if (lane) {
        if (lane.key === 'scene') cursor = this.sceneAt(x) ? 'grab' : 'default';
        else {
          const hit = this.laneItemAt(lane, x);
          cursor = hit ? (hit.edge ? 'ew-resize' : 'grab') : 'default';
        }
      } else if (y > RULER + 4 + MAIN_H + 4) cursor = 'default';
      else {
        const nearEdge = this.sel && (Math.abs(x - this.xOf(this.sel.a)) < 7 || Math.abs(x - this.xOf(this.sel.b)) < 7);
        const nearSeam = this.seamAt(x) >= 0;
        cursor = nearEdge ? 'ew-resize' : nearSeam ? 'pointer' : 'text';
      }
      this.scroller.style.cursor = cursor;
      this.requestDraw(false);
      return;
    }
    if (d.mode === 'scrub') {
      this.seek(t);
    } else if (d.mode === 'edge') {
      const v = this.snapOut(t);
      if (d.edge === 'a') this.sel.a = v;
      else this.sel.b = v;
      if (this.sel.a > this.sel.b) {
        [this.sel.a, this.sel.b] = [this.sel.b, this.sel.a];
        d.edge = d.edge === 'a' ? 'b' : 'a';
      }
      this.renderSelection();
    } else if (d.mode === 'select') {
      if (!d.moved && Math.abs(x - d.startX) < 4) return;
      d.moved = true;
      const v = this.snapOut(t);
      this.sel = { a: Math.min(d.anchor, v), b: Math.max(d.anchor, v) };
      this.focus = -1;
      if (this.playing) this.pause();
      this.seek(v);
      this.renderSelection();
    } else if (d.mode === 'item') {
      if (!d.moved && Math.abs(x - d.startX) < 3) return;
      d.moved = true;
      const it = this.findItem(d.ref);
      if (!it) return;
      const snapT = (v) => {
        // magnet: playhead and the edges of the selection
        for (const m of [this.t, 0, this.outDur]) if (Math.abs(this.xOf(m) - this.xOf(v)) < 6) return m;
        return this.snapOut(v);
      };
      if (d.edge === 'a') {
        const o0 = clamp(snapT(t), 0, d.o1 - 0.1);
        this.placeItem(it, o0, d.o1 - o0);
      } else if (d.edge === 'b') {
        const o1 = clamp(snapT(t), d.o0 + 0.1, this.outDur);
        this.placeItem(it, d.o0, o1 - d.o0);
      } else {
        const len = d.o1 - d.o0;
        const o0 = clamp(snapT(t - d.grab), 0, Math.max(0, this.outDur - len));
        this.placeItem(it, o0, len);
      }
      this.layoutLanes();
      this.requestDraw();
      this.renderPreview(this.t);
      this.panel.syncSelected();
    } else if (d.mode === 'scene') {
      if (!d.moved && Math.abs(x - d.startX) < 5) return;
      d.moved = true;
      // insertion point: before the first scene whose middle is right of the pointer
      let idx = this.scenes.length;
      for (let i = 0; i < this.scenes.length; i++) {
        const s = this.sceneSpan(this.scenes[i].id);
        if (s && t < (s.o0 + s.o1) / 2) { idx = i; break; }
      }
      d.target = idx;
      d.x = x;
      this.scroller.style.cursor = 'grabbing';
      this.requestDraw();
    }
  }

  up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.scroller.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (d.mode === 'select' && !d.moved) {
      const { x } = this.local(e);
      this.sel = null;
      this.focus = this.seamAt(x);
      this.seek(this.focus >= 0 ? this.seams[this.focus].o : this.tOf(x));
    } else if (d.mode === 'item') {
      this.endEdit();
      return;
    } else if (d.mode === 'scene') {
      if (d.moved && d.target != null) {
        const from = this.scenes.findIndex((s) => s.id === d.id);
        const to = d.target > from ? d.target - 1 : d.target;
        if (to !== from) { this.moveScene(d.id, to); return; }
      } else if (!d.moved) {
        const s = this.sceneSpan(d.id);
        if (s) this.seek(s.o0);
        this.panel.setTab('cenas');
      }
    } else if (this.sel && this.sel.b - this.sel.a < 1 / this.fps) {
      this.sel = null;
    }
    this.renderAll();
  }

  key(e) {
    if (!this.isOpen) return;
    if (document.querySelector('.backdrop:not([hidden]), .busy:not([hidden])')) return;
    if (e.target.matches('input[type=text], input[type=number], textarea, select, [contenteditable]')) return;
    const k = e.key;
    const lower = k.toLowerCase();
    const frame = 1 / this.fps;
    let handled = true;
    // A focused button would also "click" on Space; the editor owns that key.
    if (e.target instanceof HTMLButtonElement) e.target.blur();
    if (k === ' ') this.togglePlay();
    else if (!e.ctrlKey && lower === 'l') this.shuttleForward();
    else if (!e.ctrlKey && lower === 'k') { this.pause(); this.setSpeed(0, false); }
    else if (!e.ctrlKey && lower === 'j') this.shuttleBack();
    else if (k === 'ArrowLeft') this.seek(this.t - (e.shiftKey ? 5 : 1));
    else if (k === 'ArrowRight') this.seek(this.t + (e.shiftKey ? 5 : 1));
    else if (k === ',') this.seek(this.t - frame);
    else if (k === '.') this.seek(this.t + frame);
    else if (k === 'Home') this.seek(0);
    else if (k === 'End') this.seek(this.outDur);
    else if (k === 'Delete' || k === 'Backspace') {
      if (this.sel) this.removeSelection();
      else if (this.selItem) this.deleteItem();
      else if (this.focus >= 0) this.restoreSeam(this.seams[this.focus]);
    } else if (e.ctrlKey && lower === 'z' && !e.shiftKey) this.undo();
    else if (e.ctrlKey && (lower === 'y' || (lower === 'z' && e.shiftKey))) this.redo();
    else if (e.ctrlKey && lower === 'd' && this.selItem) this.duplicateItem();
    else if (!e.ctrlKey && lower === 'q') this.removeBefore();
    else if (!e.ctrlKey && lower === 'w') this.removeAfter();
    else if (!e.ctrlKey && lower === 't') this.transitionAtPlayhead();
    else if (!e.ctrlKey && lower === 'z') this.addZoom();
    else if (!e.ctrlKey && lower === 'x') this.panel.addText();
    else if (!e.ctrlKey && lower === 'i') this.markSel('a');
    else if (!e.ctrlKey && lower === 'o') this.markSel('b');
    else if (k === 'Escape') {
      if (!this.pop.hidden || !this.syncPop.hidden) this.closePops();
      else if (this.selItem) this.selectItem(null);
      else { this.sel = null; this.focus = -1; this.renderAll(); }
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  markSel(edge) {
    const t = this.snapOut(this.t);
    if (!this.sel) this.sel = edge === 'a' ? { a: t, b: this.outDur } : { a: 0, b: t };
    else this.sel[edge] = t;
    if (this.sel.a > this.sel.b) [this.sel.a, this.sel.b] = [this.sel.b, this.sel.a];
    this.focus = -1;
    this.renderAll();
  }

  showThumb(x, t) {
    if (!this.outDur) return;
    const box = this.hoverBox;
    box.hidden = false;
    const w = 168;
    box.style.left = `${clamp(x - w / 2, 0, this.viewW - w)}px`;
    const src = this.srcOf(t);
    $('#cut-hover-time').textContent = src == null ? `${fmt(t)} · transição` : fmt(t);
    if (src == null || this.playing) return; // seeking a second decoder while playing costs frames
    const now = performance.now();
    if (this.thumbVideo.seeking || now - (this.lastThumb || 0) < 90) { this.pendingThumb = this.vt(src); return; }
    this.lastThumb = now;
    this.thumbVideo.currentTime = this.vt(src);
  }

  // ---------------------------------------------------------------- actions

  title() {
    return $('#cut-title-input').value.trim().slice(0, 180) || (this.p && this.p.title) || 'Aula';
  }

  exportSeq() {
    return this.seq.map((it) => (it.t === 's'
      ? { t: 's', a: Number(it.a.toFixed(4)), b: Number(it.b.toFixed(4)), sp: Number(it.sp.toFixed(4)) }
      : { t: 'x' }));
  }

  // Data URL images for the export (file images would make the canvas unexportable).
  async exportRes(o) {
    if (o.kind === 'sticker') {
      const r = this.resFor(o);
      if (r.img && !r.img.complete) await new Promise((res) => { r.img.onload = res; r.img.onerror = res; });
      return r;
    }
    if (o.kind !== 'image') return null;
    const url = await this.api.media.dataUrl(o.src.path);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    return { img, w: img.naturalWidth, h: img.naturalHeight };
  }

  // Everything drawn over the picture, rendered for the export (times on the final file).
  async exportPost(offset, { W, H }, { videoOnly = false } = {}) {
    const zooms = this.resolvedZooms();
    const vf = [];
    const zp = zoompanFilter(zooms, { W, H, fps: this.fps, offset });
    if (zp) vf.push(zp);
    if (this.fxGlobal && !isNeutral(this.fxGlobal.p)) vf.push(...ffmpegChain(this.fxGlobal.p, { H, a: offset, b: offset + this.outDur + 1 }));
    for (const f of this.fx) {
      const { o0, o1 } = this.span(f);
      if (o1 - o0 > 0.05) vf.push(...ffmpegChain(f.p, { H, a: offset + o0, b: offset + o1 }));
    }
    const overlays = [];
    for (const o of this.overlays) {
      const { o0, o1 } = this.span(o);
      if (o1 - o0 < 0.05 || (videoOnly && o.kind !== 'video')) continue;
      const base = { kind: o.kind, o0: offset + o0, o1: offset + o1, anim: o.anim || null, opacity: o.opacity ?? 1 };
      if (o.kind === 'video') {
        const r = this.resFor(o);
        const { w, h } = itemSize(o, W, H, r);
        const ew = Math.max(2, Math.round(w / 2) * 2);
        const eh = Math.max(2, Math.round(h / 2) * 2);
        const x = Math.round(o.x * W - ew / 2);
        const y = Math.round(o.y * H - eh / 2);
        let mask = null;
        if ((o.radius || 0) > 0) {
          const cv = document.createElement('canvas');
          cv.width = ew;
          cv.height = eh;
          const c = cv.getContext('2d');
          c.fillStyle = '#000';
          c.fillRect(0, 0, ew, eh);
          c.fillStyle = '#fff';
          c.beginPath();
          c.roundRect(0, 0, ew, eh, (o.radius || 0) * Math.min(ew, eh));
          c.fill();
          mask = cv.toDataURL('image/png');
        }
        overlays.push({
          ...base, x, y, w: ew, h: eh, mask,
          video: { path: o.src.path, trim: o.trim || 0, volume: o.volume ?? 1, hasAudio: !!o.src.hasAudio },
        });
        if ((o.border || 0) > 0) {
          const ring = rasterize({ ...o, kind: 'image', ringOnly: true, shadow: false, src: { ...o.src, w: r.w || o.src.w, h: r.h || o.src.h } }, W, H, { img: null, w: r.w || o.src.w, h: r.h || o.src.h });
          overlays.push({ ...base, kind: 'image', png: ring.png, x: ring.x, y: ring.y, w: ring.w, h: ring.h });
        }
        continue;
      }
      const res = await this.exportRes(o);
      const r = rasterize(o, W, H, res);
      overlays.push({ ...base, png: r.png, x: r.x, y: r.y, w: r.w, h: r.h });
    }
    return { vf: vf.join(',') || null, overlays };
  }

  // The same edits as the export, for the audio-only renders.
  async audioJob(extra = {}) {
    return {
      seq: this.exportSeq(),
      audioDelay: this.audioDelay,
      audioFx: this.audioFx,
      transition: this.seq.some((it) => it.t === 'x') ? this.trans : null,
      post: { overlays: (await this.exportPost(0, { W: this.p.width || 1920, H: this.p.height || 1080 }, { videoOnly: true })).overlays.filter((o) => o.video) },
      ...extra,
    };
  }

  async exportNow() {
    let post;
    try {
      post = await this.exportPost(this.introDur(), { W: this.p.width || 1920, H: this.p.height || 1080 });
    } catch (err) {
      this.toast(`Não consegui preparar os textos e mídias para a exportação. ${err.message || ''}`, 'error', 8000);
      return;
    }
    this.releaseMedia();
    const ok = await this.onExport(this.p, {
      seq: this.exportSeq(),
      removed: this.removed,
      inserts: this.inserts,
      audioDelay: this.audioDelay,
      title: this.title(),
      intro: this.useIntro ? this.intro : null,
      transition: this.seq.some((it) => it.t === 'x') ? this.trans : null,
      post,
      audioFx: this.audioFx,
      sidecars: this.p.sidecars || null,
      edits: (({ audioDelay, removed, inserts, title, ...rest }) => rest)(this.editState()),
    });
    if (!ok && this.isOpen) this.restoreMedia();
  }

  async leave() {
    // Recordings keep their edits as a draft: nothing to lose, no question asked.
    if (this.p.folder) {
      clearTimeout(this.saveTimer);
      await this.api.saveProject(this.p.folder, this.editState()).catch(() => {});
      this.close();
      this.onClose('draft');
      return;
    }
    const ok = await this.confirm({
      title: 'Sair sem exportar?',
      text: 'Os cortes e efeitos serão perdidos. O vídeo original continua intacto.',
      ok: 'Sair sem exportar',
      cancel: 'Continuar editando',
    });
    if (!ok) return;
    this.close();
    this.onClose('left');
  }

  // "Gravar nova cena": saves the draft and goes back to the studio to record more.
  async newScene() {
    if (!this.p.folder || !this.p.original) {
      this.toast('Só dá para gravar novas cenas em aulas gravadas por este app que ainda têm os arquivos originais.', 'info', 7000);
      return;
    }
    clearTimeout(this.saveTimer);
    await this.api.saveProject(this.p.folder, this.editState()).catch(() => {});
    const project = this.p;
    this.close();
    this.onNewScene(project);
  }

  async discard() {
    const ok = await this.confirm({
      title: 'Descartar esta gravação?',
      text: 'Os arquivos vão para a Lixeira do Windows.',
      ok: 'Descartar',
      cancel: 'Cancelar',
      danger: true,
    });
    if (!ok) return;
    const { path: file, folder } = this.p;
    this.close();
    if (folder) await this.api.gallery.trash({ kind: 'project', folder }).catch(() => {});
    else await this.api.trash(file).catch(() => {});
    this.onClose('discarded');
  }

  // ---------------------------------------------------------------- rendering

  renderAll() {
    this.renderTime();
    this.renderPlay();
    this.renderSelection();
    this.renderSummary();
    this.renderIntro();
    $('#cut-undo').disabled = !this.history.length;
    $('#cut-redo').disabled = !this.future.length;
    $('#cut-transition').classList.toggle('muted', !this.trans);
    this.requestDraw();
    this.renderPreview(this.t);
    this.panel.render();
  }

  renderPlay() {
    $('#cut-play').innerHTML = icon(this.playing || this.reverseTimer ? 'pause' : 'play', 18);
    $('#cut-play').title = this.playing ? 'Pausar (Espaço)' : 'Reproduzir (Espaço)';
  }

  renderTime() {
    if (!this.p) return;
    $('#cut-time').textContent = `${fmt(this.introDur() + this.t)} / ${fmt(this.finalDuration())}`;
  }

  renderSummary() {
    const rem = this.removed.reduce((s, [a, b]) => s + (b - a), 0);
    const nT = this.seq.filter((it) => it.t === 'x').length;
    const parts = [`Duração final <b>${fmt(this.finalDuration())}</b>`];
    if (rem > 0) parts.push(`<span class="neg">−${fmtLen(rem)} cortados</span>`);
    if (Math.abs(this.speed - 1) > 1e-3) parts.push(`velocidade ${fmtSpeed(this.speed)}`);
    if (this.scenes.length > 1) parts.push(`${this.scenes.length} cenas`);
    if (nT) parts.push(`${nT} ${nT === 1 ? 'transição' : 'transições'}`);
    if (this.introDur()) parts.push(`intro ${fmtLen(this.introDur())}`);
    $('#cut-summary').innerHTML = parts.join(' · ');
  }

  renderSelection() {
    $('#cut-remove').disabled = !this.sel;
    this.renderBubble();
    this.requestDraw();
  }

  renderBubble() {
    const b = this.bubble;
    const seam = this.seams && this.seams[this.focus];
    if (this.sel && !(this.drag && this.drag.mode === 'scrub')) {
      b.innerHTML = `
        <span class="bub-len">${fmtLen(this.sel.b - this.sel.a)}</span>
        <button class="bub danger" data-act="remove">${icon('scissors', 14)} Remover <kbd>Del</kbd></button>
        <button class="bub" data-act="zoom" title="Zoom neste trecho (Z)">${icon('zoomIn', 14)} Zoom</button>
        <button class="bub" data-act="text" title="Texto neste trecho (X)">${icon('type', 14)} Texto</button>
        <button class="bub" data-act="speed" title="Velocidade deste trecho">${icon('gauge', 14)} Velocidade</button>
        <button class="bub" data-act="fx" title="Filtro neste trecho">${icon('palette', 14)} Filtro</button>
        <button class="bub-x" data-act="clear" title="Cancelar seleção (Esc)">${icon('x', 14)}</button>`;
      this.placeBubble((this.xOf(this.sel.a) + this.xOf(this.sel.b)) / 2);
    } else if (seam) {
      const hasT = seam.transIdx >= 0;
      const removed = seam.removedIdx >= 0 ? this.removed[seam.removedIdx] : null;
      b.innerHTML = `
        ${removed ? `<span class="bub-len">Cortados ${fmtLen(removed[1] - removed[0])}</span>
        <button class="bub" data-act="restore">${icon('undo', 14)} Restaurar</button>` : ''}
        <button class="bub ${hasT ? '' : 'accent'}" data-act="transition">${icon(hasT ? 'x' : 'plus', 14)} ${hasT ? 'Tirar transição' : 'Transição'}</button>`;
      this.placeBubble(this.xOf(seam.o));
    } else {
      b.hidden = true;
    }
  }

  placeBubble(cx) {
    const b = this.bubble;
    if (cx < -20 || cx > this.viewW + 20) {
      b.hidden = true;
      return;
    }
    b.hidden = false;
    const w = b.offsetWidth || 260;
    b.style.left = `${clamp(cx - w / 2, 0, Math.max(0, this.viewW - w))}px`;
  }

  renderIntro() {
    const box = $('#cut-intro');
    if (!this.p) return;
    if (this.introApplied) {
      box.className = 'cut-intro empty';
      box.dataset.sig = '';
      box.innerHTML = `<div class="intro-add" title="A intro já faz parte deste vídeo">${icon('check', 16)}<span>Intro já incluída</span></div>`;
      return;
    }
    if (!this.intro) {
      box.className = 'cut-intro empty';
      box.dataset.sig = '';
      box.innerHTML = `<button class="intro-add" data-intro-setup title="Definir uma intro em Configurações">${icon('plus', 16)}<span>Intro</span></button>`;
      return;
    }
    const sig = `${this.intro.url}|${this.useIntro}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.className = `cut-intro ${this.useIntro ? 'on' : 'off'}`;
    const media = this.intro.isImage
      ? `<img src="${this.intro.url}" alt="" />`
      : `<video src="${this.intro.url}#t=0.5" muted preload="metadata"></video>`;
    box.innerHTML = `
      <div class="intro-media">${media}</div>
      <label class="intro-row"><input type="checkbox" class="switch sm" ${this.useIntro ? 'checked' : ''} /><span>Intro · ${fmtLen(this.intro.duration)}</span></label>`;
  }

  requestDraw(base = true) {
    if (base) this.baseDirty = true;
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  // Static layer (ruler, waveform, seams, selection, lanes) is cached; each frame only
  // the hover line and the playhead are drawn on top.
  draw() {
    if (!this.isOpen || !this.viewW) return;
    const dpr = window.devicePixelRatio || 1;
    if (!this.base) this.base = document.createElement('canvas');
    const base = this.base;
    if (base.width !== this.canvas.width || base.height !== this.canvas.height) {
      base.width = this.canvas.width;
      base.height = this.canvas.height;
      this.baseDirty = true;
    }
    if (this.baseDirty || this.baseView !== `${this.viewStart}|${this.pps}`) {
      const bctx = base.getContext('2d');
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawBase(bctx);
      this.baseDirty = false;
      this.baseView = `${this.viewStart}|${this.pps}`;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const top = RULER + 4;
    if (this.hover && !this.drag) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillRect(Math.round(this.hover.x), top, 1, this.viewH - top - 4);
    }
    const d = this.drag;
    if (d && d.mode === 'scene' && d.moved && d.target != null) {
      const lane = this.lanes.find((l) => l.key === 'scene');
      const tgt = this.scenes[d.target];
      const s = tgt ? this.sceneSpan(tgt.id) : { o0: this.outDur };
      const x = Math.round(this.xOf(s ? s.o0 : this.outDur));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 1.5, lane.y - 3, 3, lane.h + 6);
      const sc = this.scenes.find((q) => q.id === d.id);
      const gx = clamp(d.x - 45, 0, Math.max(0, this.viewW - 90));
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#7b80ff';
      ctx.beginPath();
      ctx.roundRect(gx, lane.y, 90, lane.h, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.font = `600 11px ${font}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(sc ? sc.name : '', gx + 8, lane.y + lane.h / 2);
    }
    const px = Math.round((this.t - this.viewStart) * this.pps);
    if (px >= -8 && px <= this.viewW + 8) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px - 1, 2, 2, this.viewH - 4);
      ctx.beginPath();
      ctx.moveTo(px - 6, 2);
      ctx.lineTo(px + 6, 2);
      ctx.lineTo(px, 10);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawBase(ctx) {
    const W = this.viewW;
    const H = this.viewH;
    const pps = this.pps;
    const v0 = this.viewStart;
    const top = RULER + 4;
    const th = MAIN_H;
    const mid = top + th / 2;
    ctx.clearRect(0, 0, W, H);

    // ruler (final-video time)
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    const step = steps.find((s) => s * pps >= 80) || 3600;
    ctx.fillStyle = '#626a7a';
    ctx.font = `11px ${font}`;
    ctx.textBaseline = 'middle';
    const first = Math.floor(v0 / step) * step;
    for (let t = first; t <= v0 + W / pps + step; t += step) {
      const x = Math.round((t - v0) * pps) + 0.5;
      if (x < -50 || x > W + 50) continue;
      ctx.fillRect(x, RULER - 7, 1, 7);
      ctx.fillText(fmt(t), x + 4, RULER / 2 - 1);
      for (let k = 1; k < 5; k++) ctx.fillRect(Math.round((t + (k * step) / 5 - v0) * pps) + 0.5, RULER - 3, 1, 3);
    }

    ctx.fillStyle = '#16191f';
    ctx.beginPath();
    ctx.roundRect(0, top, W, th, 8);
    ctx.fill();

    // pieces: waveform (mapped back to the source audio), speed bands and transition blocks
    const wave = new Path2D();
    const db = this.db;
    for (const it of this.seq) {
      const x0 = Math.max(0, Math.floor((it.o0 - v0) * pps));
      const x1 = Math.min(W, Math.ceil((it.o1 - v0) * pps));
      if (x1 <= 0 || x0 >= W) continue;
      if (it.t === 'x') {
        ctx.fillStyle = 'rgba(123,128,255,0.25)';
        ctx.beginPath();
        ctx.roundRect(x0 + 1, top + 3, Math.max(2, x1 - x0 - 2), th - 6, 6);
        ctx.fill();
        if (x1 - x0 > 50) {
          ctx.fillStyle = '#c6c8ff';
          ctx.font = `600 11px ${font}`;
          ctx.fillText('Transição', x0 + 8, mid);
        }
        continue;
      }
      if (Math.abs(it.sp - 1) > 1e-3) {
        ctx.fillStyle = it.sp > 1 ? 'rgba(61,220,151,0.10)' : 'rgba(245,184,74,0.10)';
        ctx.fillRect(x0, top, x1 - x0, th);
        ctx.fillStyle = it.sp > 1 ? '#3ddc97' : '#f5b84a';
        ctx.fillRect(x0, top + th - 3, x1 - x0, 3);
        if (x1 - x0 > 34) {
          ctx.font = `700 10.5px ${font}`;
          ctx.fillText(fmtSpeed(it.sp), x0 + 5, top + th - 11);
        }
      }
      if (this.waveState !== 'ready') continue;
      for (let x = x0; x < x1; x++) {
        const s0 = it.a + (v0 + x / pps - it.o0) * it.sp;
        const i0 = Math.floor(s0 / BIN);
        const i1 = Math.max(i0 + 1, Math.ceil((s0 + it.sp / pps) / BIN));
        let peak = -200;
        for (let i = i0; i < i1 && i < db.length; i++) if (db[i] > peak) peak = db[i];
        const h = Math.max(1, clamp((peak + 54) / 54, 0, 1) * (th / 2 - 6));
        wave.rect(x, mid - h, 1, h * 2);
      }
    }
    ctx.fillStyle = '#8b90ff';
    ctx.fill(wave);
    if (this.waveState !== 'ready') {
      ctx.fillStyle = '#9aa1b1';
      ctx.font = `12px ${font}`;
      ctx.fillText(this.waveState === 'loading' ? 'Analisando o áudio…' : 'Sem áudio', 12, mid - 12);
    }

    // pause candidates (while "Remover pausas" is open)
    if (this.candidates) {
      for (const [a, b] of this.candidates) {
        const o = this.outOfSrc(a);
        if (o == null) continue;
        const sp = this.speedAt(a);
        const x0 = (o - v0) * pps;
        const x1 = (o + (b - a) / sp - v0) * pps;
        if (x1 < 0 || x0 > W) continue;
        ctx.fillStyle = 'rgba(245,184,74,0.24)';
        ctx.fillRect(x0, top, Math.max(1, x1 - x0), th);
        ctx.fillStyle = '#f5b84a';
        ctx.fillRect(x0, top, Math.max(1, x1 - x0), 3);
      }
    }

    // seams: where something was cut (red) or a transition / another scene follows (blue)
    this.seams.forEach((s, i) => {
      const x = Math.round((s.o - v0) * pps);
      if (x < -10 || x > W + 10) return;
      const on = i === this.focus;
      ctx.fillStyle = s.split ? '#7b80ff' : '#ff3b55';
      ctx.globalAlpha = on ? 1 : 0.85;
      ctx.fillRect(x - (on ? 1.5 : 1), top, on ? 3 : 2, th);
      ctx.beginPath();
      ctx.arc(x, top + 9, on ? 7 : 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 2.5, top + 8.25, 5, 1.5);
    });

    // selection
    if (this.sel) {
      const x0 = (this.sel.a - v0) * pps;
      const x1 = (this.sel.b - v0) * pps;
      ctx.fillStyle = 'rgba(255,59,85,0.18)';
      ctx.fillRect(x0, top, x1 - x0, th);
      ctx.fillStyle = '#ff5c72';
      ctx.fillRect(x0 - 1, top, 2, th);
      ctx.fillRect(x1 - 1, top, 2, th);
      for (const x of [x0, x1]) {
        ctx.beginPath();
        ctx.roundRect(x - 4, mid - 12, 8, 24, 3);
        ctx.fill();
      }
      // the selection also shows across the lanes
      if (this.lanes.length) {
        const l0 = this.lanes[0].y;
        const l1 = this.lanes[this.lanes.length - 1].y + LANE_H;
        ctx.fillStyle = 'rgba(255,59,85,0.07)';
        ctx.fillRect(x0, l0, x1 - x0, l1 - l0);
      }
    }

    this.drawLanes(ctx, W, v0, pps);
  }

  drawLanes(ctx, W, v0, pps) {
    const sel = this.selItem;
    const block = (x0, x1, y, h, color, label, on, opts = {}) => {
      const a = Math.max(-4, x0);
      const b = Math.min(W + 4, x1);
      if (b <= a) return;
      ctx.globalAlpha = opts.alpha ?? 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(a + 0.5, y + 1, Math.max(3, b - a - 1), h - 2, 5);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (on) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        if (x1 - x0 > 16) {
          ctx.fillRect(Math.max(a, x0) + 3, y + 6, 2, h - 12);
          ctx.fillRect(Math.min(b, x1) - 5, y + 6, 2, h - 12);
        }
      }
      if (label && b - a > 28) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(a + 6, y, b - a - 12, h);
        ctx.clip();
        ctx.fillStyle = opts.text || '#0c0d11';
        ctx.font = `600 11px ${font}`;
        ctx.textBaseline = 'middle';
        ctx.fillText(label, Math.max(a + 8, Math.min(x0 + 8, b - 40)), y + h / 2 + 0.5);
        ctx.restore();
      }
    };
    for (const lane of this.lanes) {
      ctx.fillStyle = '#121419';
      ctx.beginPath();
      ctx.roundRect(0, lane.y, W, lane.h, 6);
      ctx.fill();
      let empty = true;
      if (lane.key === 'scene') {
        this.scenes.forEach((sc, i) => {
          const s = this.sceneSpan(sc.id);
          if (!s) return;
          empty = false;
          const dragging = this.drag && this.drag.mode === 'scene' && this.drag.moved && this.drag.id === sc.id;
          block((s.o0 - v0) * pps, (s.o1 - v0) * pps, lane.y, lane.h, SCENE_COLORS[i % SCENE_COLORS.length], `${sc.name} · ${fmt(s.o1 - s.o0)}`, false, { text: '#e5e7eb', alpha: dragging ? 0.4 : 1 });
        });
      } else if (lane.key === 'zoom') {
        const res = this.resolvedZooms();
        for (const z of this.zooms) {
          const r = res.find((q) => q.id === z.id);
          const { o0, o1 } = r || this.span(z);
          empty = false;
          block((o0 - v0) * pps, (o1 - v0) * pps, lane.y, lane.h, '#f5b84a', `${fmtSpeed(z.scale)} ${z.mode === 'follow' ? '· mouse' : ''}`, sel && sel.id === z.id, { alpha: r ? 1 : 0.4 });
        }
      } else if (lane.key === 'ov') {
        for (const o of this.overlays) {
          if (this.ovRow.get(o.id) !== lane.row) continue;
          const { o0, o1 } = this.span(o);
          empty = false;
          const label = o.kind === 'text' ? String(o.text || '').split('\n')[0]
            : o.kind === 'emoji' ? o.emoji : o.kind === 'sticker' ? 'Sticker' : (o.src && o.src.name) || 'Mídia';
          block((o0 - v0) * pps, (o1 - v0) * pps, lane.y, lane.h, KIND_COLOR[o.kind] || '#7b80ff', label, sel && sel.id === o.id);
        }
      } else if (lane.key === 'fx') {
        if (this.fxGlobal && !isNeutral(this.fxGlobal.p)) {
          ctx.fillStyle = 'rgba(61,220,151,0.13)';
          ctx.beginPath();
          ctx.roundRect(0, lane.y, Math.min(W, (this.outDur - v0) * pps), lane.h, 6);
          ctx.fill();
          if (sel && sel.lane === 'fxg') {
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
          empty = false;
        }
        for (const f of this.fx) {
          const { o0, o1 } = this.span(f);
          empty = false;
          block((o0 - v0) * pps, (o1 - v0) * pps, lane.y, lane.h, '#3ddc97', f.name || 'Filtro', sel && sel.id === f.id);
        }
        if (this.fxGlobal && !isNeutral(this.fxGlobal.p)) {
          // label at the right end, where range filters rarely are
          const label = `Vídeo inteiro: ${this.fxGlobal.name || 'filtro'}`;
          ctx.font = `600 10.5px ${font}`;
          const w = ctx.measureText(label).width;
          const xr = Math.min(W, (this.outDur - v0) * pps) - w - 10;
          ctx.fillStyle = 'rgba(18,20,25,0.85)';
          ctx.fillRect(xr - 6, lane.y + 3, w + 12, lane.h - 6);
          ctx.fillStyle = '#3ddc97';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, xr, lane.y + lane.h / 2 + 0.5);
        }
      }
      if (empty && lane.label) {
        ctx.fillStyle = '#4a505d';
        ctx.font = `11px ${font}`;
        ctx.textBaseline = 'middle';
        const hint = { zoom: 'Zoom · clique duplo ou Z para adicionar', ov: 'Textos e mídias · clique duplo ou X para adicionar texto', fx: 'Filtros · escolha no painel Filtros' }[lane.key] || lane.label;
        ctx.fillText(hint, 10, lane.y + lane.h / 2 + 0.5);
      }
    }
  }
}
