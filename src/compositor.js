// Draws the screen + camera layers onto a 1920x1080 canvas and turns that canvas
// into a video track for MediaRecorder. Frames are pulled straight from the
// tracks (MediaStreamTrackProcessor) and pushed into a MediaStreamTrackGenerator,
// so recording keeps going while the studio window is minimized.

import { drawItem, itemBounds } from './textstyles.js';
import { Beauty, beautyOn } from './beauty.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// ------------------------------------------------------------------ feeds

export class Feed {
  constructor(stream, { onResize, onEnded } = {}) {
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    this.frame = null;
    this.w = 0;
    this.h = 0;
    this.alive = true;
    this.onResize = onResize;
    this.track.addEventListener('ended', () => onEnded?.());

    if ('MediaStreamTrackProcessor' in window) {
      const processor = new MediaStreamTrackProcessor({ track: this.track });
      this.reader = processor.readable.getReader();
      this.pump();
    } else {
      // Fallback: a detached <video> element.
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.srcObject = stream;
      this.video.play().catch(() => {});
      this.video.addEventListener('resize', () => this.setSize(this.video.videoWidth, this.video.videoHeight));
    }
  }

  async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!this.alive) { value.close(); break; }
        const old = this.frame;
        this.frame = value;
        if (old) old.close();
        this.setSize(value.displayWidth, value.displayHeight);
      }
    } catch { /* track stopped */ }
  }

  setSize(w, h) {
    if (!w || !h || (w === this.w && h === this.h)) return;
    this.w = w;
    this.h = h;
    this.onResize?.(w, h);
  }

  get image() {
    if (this.video) return this.video.readyState >= 2 ? this.video : null;
    return this.frame;
  }

  stop() {
    this.alive = false;
    this.reader?.cancel().catch(() => {});
    this.stream.getTracks().forEach((t) => t.stop());
    if (this.frame) { this.frame.close(); this.frame = null; }
    if (this.video) { this.video.srcObject = null; this.video = null; }
  }
}

// ------------------------------------------------------------------ crop math (shared with the editor)

// Visible part of the source for a layer, in "visual" source coordinates
// (as if the source had already been mirrored when mirroring is on).
export function cropFor(layer, sw, sh) {
  const s = Math.max(layer.w / sw, layer.h / sh) * Math.max(1, layer.zoom);
  const vw = layer.w / s;
  const vh = layer.h / s;
  const cx = sw / 2 + clamp(layer.panX, -1, 1) * (sw - vw) / 2;
  const cy = sh / 2 + clamp(layer.panY, -1, 1) * (sh - vh) / 2;
  return { sx: cx - vw / 2, sy: cy - vh / 2, vw, vh, s };
}

function effectiveRadius(l) {
  return l.shape === 'circle' ? Math.min(l.w, l.h) / 2 : l.radius;
}

function toDisplay(l) {
  return {
    x: l.x, y: l.y, w: l.w, h: l.h,
    zoom: l.zoom, panX: l.panX, panY: l.panY,
    r: effectiveRadius(l),
    op: l.visible ? 1 : 0,
    bw: l.borderWidth,
    sh: l.shadow ? 1 : 0,
    borderColor: l.borderColor,
  };
}

const NUMERIC = ['x', 'y', 'w', 'h', 'zoom', 'panX', 'panY', 'r', 'op', 'bw', 'sh'];

// ------------------------------------------------------------------ compositor

export class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    this.W = canvas.width = 1920;
    this.H = canvas.height = 1080;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.feeds = { screen: null, camera: null };
    this.crops = { screen: null, camera: null }; // part of the source to use, as fractions
    this.logo = null; // { img, pos, size, opacity }
    this.display = { screen: null, camera: null };
    this.order = ['screen', 'camera'];
    this.mirror = false;
    this.camRotate = 0; // 0 | 90 | 180 | 270 (clockwise)
    this.beauty = null; // { smooth, tone, bright, rosy, sharp } applied to the camera
    this.beautyFx = null;
    this.rotCanvas = null;
    this.anim = null;
    this.bg = ['#000000', '#000000'];
    this.bgFill = '#000000';
    this.writer = null;
    this.generator = null;
    this.captureTrack = null;
    this.bgSource = null; // image / pattern background: { img, blur }
    this.bgCanvas = null;
    this.camFilter = 'none';
    this.live = []; // overlays drawn live (texts, images, stickers)
    this.liveRes = null; // (item) -> { img, w, h } | null
    this.liveCache = new Map();
    this.liveAlpha = new Map();
  }

  // 1920x1080 (horizontal) or 1080x1920 (vertical).
  setSize(w, h) {
    if (w === this.W && h === this.H) return;
    this.W = this.canvas.width = w;
    this.H = this.canvas.height = h;
    this.setBackground(this.bg);
    if (this.bgSource) this.setBackgroundImage(this.bgSource.img, this.bgSource.blur);
    this.liveCache.clear();
  }

  setFeed(name, feed) {
    this.feeds[name] = feed;
  }

  setCrop(name, crop) {
    this.crops[name] = crop && crop.w > 0 && crop.h > 0 ? crop : null;
  }

  // Size of the part of a source that is used (the selected screen area).
  sourceSize(name) {
    const f = this.feeds[name];
    if (!f || !f.w) return null;
    if (name === 'camera' && (this.camRotate === 90 || this.camRotate === 270)) return { w: f.h, h: f.w };
    const c = this.crops[name];
    return c ? { w: f.w * c.w, h: f.h * c.h } : { w: f.w, h: f.h };
  }

  setLogo(logo) {
    this.logo = logo && logo.img ? logo : null;
  }

  drawLogo() {
    const l = this.logo;
    const img = l && l.img;
    if (!img || !img.complete || !img.naturalWidth) return;
    const { ctx } = this;
    const w = Math.round(this.W * (l.size || 12) / 100);
    const h = Math.round(w * img.naturalHeight / img.naturalWidth);
    const m = Math.round(Math.min(this.W, this.H) * 0.035);
    const pos = l.pos || 'tr';
    const x = pos.includes('l') ? m : this.W - w - m;
    const y = pos.includes('t') ? m : this.H - h - m;
    ctx.save();
    ctx.globalAlpha = l.opacity ?? 0.9;
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }

  // A picture (or a generated pattern) as background, covering the frame,
  // optionally blurred. Rendered once, then copied on every frame.
  setBackgroundImage(img, blur = 0) {
    if (!img) { this.bgSource = null; this.bgCanvas = null; return; }
    this.bgSource = { img, blur };
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const c = this.bgCanvas && this.bgCanvas.width === this.W && this.bgCanvas.height === this.H ? this.bgCanvas : document.createElement('canvas');
    c.width = this.W;
    c.height = this.H;
    const ctx = c.getContext('2d');
    const s = Math.max(this.W / iw, this.H / ih) * (blur > 0 ? 1.06 : 1);
    const w = iw * s;
    const h = ih * s;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.filter = blur > 0 ? `blur(${blur * (this.H / 1080)}px)` : 'none';
    ctx.drawImage(img, (this.W - w) / 2, (this.H - h) / 2, w, h);
    ctx.filter = 'none';
    this.bgCanvas = c;
  }

  setBackground(colors) {
    this.bg = colors;
    if (colors[0] === colors[1]) {
      this.bgFill = colors[0];
    } else {
      const g = this.ctx.createLinearGradient(0, 0, this.W, this.H);
      g.addColorStop(0, colors[0]);
      g.addColorStop(1, colors[1]);
      this.bgFill = g;
    }
  }

  setScene(scene, { animate = false, duration = 520 } = {}) {
    this.order = scene.order || ['screen', 'camera'];
    const target = { screen: toDisplay(scene.screen), camera: toDisplay(scene.camera) };
    if (!animate || !this.display.screen) {
      this.display = target;
      this.anim = null;
      return;
    }
    const from = { screen: { ...this.display.screen }, camera: { ...this.display.camera } };
    for (const k of ['screen', 'camera']) {
      const f = from[k];
      const t = target[k];
      // Appearing layers fade in at their final spot; disappearing ones fade out in place.
      if (f.op < 0.01) for (const p of NUMERIC) if (p !== 'op') f[p] = t[p];
      if (t.op < 0.01) for (const p of NUMERIC) if (p !== 'op') t[p] = f[p];
    }
    this.anim = { from, to: target, start: performance.now(), duration };
  }

  get animating() {
    return !!this.anim;
  }

  step(now) {
    if (!this.anim) return;
    const { from, to, start, duration } = this.anim;
    const t = clamp((now - start) / duration, 0, 1);
    const e = easeInOut(t);
    for (const k of ['screen', 'camera']) {
      const d = { borderColor: to[k].borderColor };
      for (const p of NUMERIC) d[p] = lerp(from[k][p], to[k][p], e);
      this.display[k] = d;
    }
    if (t >= 1) {
      this.display = to;
      this.anim = null;
    }
  }

  draw(now = performance.now()) {
    this.step(now);
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 1;
    if (this.bgCanvas) ctx.drawImage(this.bgCanvas, 0, 0);
    else {
      ctx.fillStyle = this.bgFill;
      ctx.fillRect(0, 0, this.W, this.H);
    }
    for (const name of this.order) {
      const d = this.display[name];
      const feed = this.feeds[name];
      if (!d || !feed) continue;
      this.drawLayer(d, feed, name === 'camera' && this.mirror, this.crops[name], name === 'camera' ? this.camFilter : 'none', name === 'camera' ? this.camRotate : 0, name === 'camera' ? this.beauty : null);
    }
    this.drawLogo();
    this.drawLive(now);
    ctx.restore();
  }

  // Live overlays: each one is rendered once to its own small canvas and
  // fades in/out over 250 ms when shown or hidden.
  drawLive(now) {
    const { ctx } = this;
    const seen = new Set();
    for (const it of this.live) {
      seen.add(it.id);
      const target = it.visible ? 1 : 0;
      let a = this.liveAlpha.get(it.id);
      if (!a) { a = { v: target, t: now }; this.liveAlpha.set(it.id, a); }
      const dt = Math.min(0.1, (now - a.t) / 1000);
      a.t = now;
      a.v = target > a.v ? Math.min(target, a.v + dt * 4) : Math.max(target, a.v - dt * 4);
      if (a.v <= 0.003) continue;
      const res = this.liveRes ? this.liveRes(it) : null;
      if ((it.kind === 'image' || it.kind === 'sticker') && !(res && res.w)) continue;
      const key = `${JSON.stringify({ ...it, visible: 0 })}|${this.W}x${this.H}|${res ? res.w : 0}`;
      let c = this.liveCache.get(it.id);
      if (!c || c.key !== key) {
        const b = itemBounds(it, this.W, this.H, res);
        const cv = document.createElement('canvas');
        cv.width = Math.max(2, b.w);
        cv.height = Math.max(2, b.h);
        drawItem(cv.getContext('2d'), { ...it, x: cv.width / 2 / this.W, y: cv.height / 2 / this.H, opacity: 1 }, this.W, this.H, res, null);
        c = { key, cv, cx: b.cx, cy: b.cy };
        this.liveCache.set(it.id, c);
      }
      ctx.save();
      ctx.globalAlpha = clamp((it.opacity ?? 1) * a.v, 0, 1);
      ctx.drawImage(c.cv, Math.round(c.cx - c.cv.width / 2), Math.round(c.cy - c.cv.height / 2));
      ctx.restore();
    }
    for (const id of this.liveCache.keys()) if (!seen.has(id)) { this.liveCache.delete(id); this.liveAlpha.delete(id); }
  }

  // The camera picture turned by 90/180/270 degrees (clockwise), on a reused canvas.
  rotated(img, w, h, deg) {
    const side = deg === 90 || deg === 270;
    const c = this.rotCanvas || (this.rotCanvas = document.createElement('canvas'));
    const cw = side ? h : w;
    const ch = side ? w : h;
    if (c.width !== cw) c.width = cw;
    if (c.height !== ch) c.height = ch;
    const x = c.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.translate(cw / 2, ch / 2);
    x.rotate((deg * Math.PI) / 180);
    x.drawImage(img, -w / 2, -h / 2, w, h);
    return c;
  }

  // The camera picture through the beauty treatment (GPU), when it is on.
  beautify(img, w, h, b) {
    if (!beautyOn(b)) return img;
    if (!this.beautyFx) this.beautyFx = new Beauty();
    return this.beautyFx.process(img, w, h, b);
  }

  drawLayer(d, feed, mirror, crop = null, filter = 'none', rotate = 0, beauty = null) {
    if (d.op <= 0.004 || d.w < 2 || d.h < 2) return;
    const { ctx } = this;
    const r = Math.max(0, Math.min(d.r, d.w / 2, d.h / 2));
    const path = new Path2D();
    path.roundRect(d.x, d.y, d.w, d.h, r);

    ctx.save();
    ctx.globalAlpha = d.op;

    if (d.sh > 0.01) {
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${0.55 * d.sh})`;
      ctx.shadowBlur = 50;
      ctx.shadowOffsetY = 18;
      ctx.fillStyle = '#000';
      ctx.fill(path);
      ctx.restore();
    }

    ctx.save();
    ctx.clip(path);
    let img = feed.image;
    let fw = feed.w;
    let fh = feed.h;
    if (img && beauty) img = this.beautify(img, fw, fh, beauty);
    if (img && rotate && fw && fh) {
      img = this.rotated(img, fw, fh, rotate);
      fw = img.width;
      fh = img.height;
    }
    const ox = crop ? fw * crop.x : 0;
    const oy = crop ? fh * crop.y : 0;
    const sw = crop ? fw * crop.w : fw;
    const sh = crop ? fh * crop.h : fh;
    if (img && sw && sh) {
      const c = cropFor(d, sw, sh);
      if (filter && filter !== 'none') ctx.filter = filter;
      if (mirror) {
        ctx.translate(d.x * 2 + d.w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(img, ox + sw - (c.sx + c.vw), oy + c.sy, c.vw, c.vh, d.x, d.y, d.w, d.h);
      } else {
        ctx.drawImage(img, ox + c.sx, oy + c.sy, c.vw, c.vh, d.x, d.y, d.w, d.h);
      }
    } else {
      ctx.fillStyle = '#16181e';
      ctx.fill(path);
    }
    ctx.restore();

    if (d.bw > 0.5) {
      const bw = d.bw;
      const inner = new Path2D();
      inner.roundRect(d.x + bw / 2, d.y + bw / 2, d.w - bw, d.h - bw, Math.max(0, r - bw / 2));
      ctx.lineWidth = bw;
      ctx.strokeStyle = d.borderColor;
      ctx.stroke(inner);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- output

  startOutput(fps) {
    this.stopOutput();
    if ('MediaStreamTrackGenerator' in window && 'VideoFrame' in window) {
      this.generator = new MediaStreamTrackGenerator({ kind: 'video' });
      this.writer = this.generator.writable.getWriter();
      return this.generator;
    }
    this.captureTrack = this.canvas.captureStream(fps).getVideoTracks()[0];
    return this.captureTrack;
  }

  pushFrame() {
    if (!this.writer) return;
    if (this.writer.desiredSize !== null && this.writer.desiredSize <= 0) return; // encoder busy: drop
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(performance.now() * 1000) });
    this.writer.write(frame).catch(() => frame.close());
  }

  stopOutput() {
    if (this.writer) {
      this.writer.close().catch(() => {});
      this.writer = null;
    }
    if (this.generator) {
      this.generator.stop();
      this.generator = null;
    }
    if (this.captureTrack) {
      this.captureTrack.stop();
      this.captureTrack = null;
    }
  }
}

// A timer that is not throttled when the window is minimized.
export function createTicker(onTick) {
  const src = `
    let timer = null, interval = 33.33, next = 0;
    function loop() {
      postMessage(0);
      next += interval;
      const now = performance.now();
      if (next < now - interval) next = now; // fell behind: resync
      timer = setTimeout(loop, Math.max(0, next - now));
    }
    onmessage = (e) => {
      clearTimeout(timer);
      interval = 1000 / e.data;
      next = performance.now();
      loop();
    };`;
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  worker.onmessage = () => onTick(performance.now());
  return { setFps: (fps) => worker.postMessage(fps) };
}

// ------------------------------------------------------------------ generated backgrounds

export const BG_PATTERNS = [
  { id: 'malha', name: 'Malha violeta' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'sol', name: 'Pôr do sol' },
  { id: 'pontos', name: 'Pontos' },
  { id: 'grade', name: 'Grade' },
  { id: 'papel', name: 'Papel' },
];

export function patternCanvas(id, W = 1920, H = 1080) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const blob = (x, y, r, color) => {
    const g = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * Math.max(W, H));
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  const base = (color) => { ctx.fillStyle = color; ctx.fillRect(0, 0, W, H); };
  if (id === 'malha') {
    base('#0f1024');
    blob(0.15, 0.2, 0.55, 'rgba(123,128,255,0.75)');
    blob(0.85, 0.3, 0.5, 'rgba(244,114,182,0.6)');
    blob(0.5, 0.95, 0.6, 'rgba(56,189,248,0.45)');
  } else if (id === 'aurora') {
    base('#04151a');
    blob(0.2, 0.8, 0.6, 'rgba(61,220,151,0.55)');
    blob(0.75, 0.15, 0.55, 'rgba(14,165,233,0.55)');
    blob(0.95, 0.9, 0.4, 'rgba(167,139,250,0.4)');
  } else if (id === 'sol') {
    base('#1d0b14');
    blob(0.5, 1.05, 0.75, 'rgba(255,140,66,0.85)');
    blob(0.1, 0.1, 0.5, 'rgba(255,59,85,0.45)');
    blob(0.9, 0.2, 0.45, 'rgba(245,184,74,0.35)');
  } else if (id === 'pontos') {
    base('#14161c');
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    const step = Math.round(H / 36);
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) { ctx.beginPath(); ctx.arc(x, y, step * 0.09, 0, Math.PI * 2); ctx.fill(); }
    blob(0.5, 0.5, 0.6, 'rgba(123,128,255,0.12)');
  } else if (id === 'grade') {
    base('#101217');
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = Math.max(1, H / 900);
    const step = Math.round(H / 18);
    for (let x = 0; x <= W; x += step) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += step) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
    blob(0.5, 0.45, 0.65, 'rgba(56,189,248,0.10)');
  } else {
    base('#f3efe6');
    blob(0.2, 0.2, 0.6, 'rgba(255,255,255,0.7)');
    blob(0.85, 0.85, 0.55, 'rgba(214,200,175,0.45)');
  }
  return c;
}
