// Draws the screen + camera layers onto a 1920x1080 canvas and turns that canvas
// into a video track for MediaRecorder. Frames are pulled straight from the
// tracks (MediaStreamTrackProcessor) and pushed into a MediaStreamTrackGenerator,
// so recording keeps going while the studio window is minimized.

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
    this.anim = null;
    this.bg = ['#000000', '#000000'];
    this.bgFill = '#000000';
    this.writer = null;
    this.generator = null;
    this.captureTrack = null;
  }

  // 1920x1080 (horizontal) or 1080x1920 (vertical).
  setSize(w, h) {
    if (w === this.W && h === this.H) return;
    this.W = this.canvas.width = w;
    this.H = this.canvas.height = h;
    this.setBackground(this.bg);
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
    ctx.fillStyle = this.bgFill;
    ctx.fillRect(0, 0, this.W, this.H);
    for (const name of this.order) {
      const d = this.display[name];
      const feed = this.feeds[name];
      if (!d || !feed) continue;
      this.drawLayer(d, feed, name === 'camera' && this.mirror, this.crops[name]);
    }
    this.drawLogo();
    ctx.restore();
  }

  drawLayer(d, feed, mirror, crop = null) {
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
    const img = feed.image;
    const ox = crop ? feed.w * crop.x : 0;
    const oy = crop ? feed.h * crop.y : 0;
    const sw = crop ? feed.w * crop.w : feed.w;
    const sh = crop ? feed.h * crop.h : feed.h;
    if (img && sw && sh) {
      const c = cropFor(d, sw, sh);
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
