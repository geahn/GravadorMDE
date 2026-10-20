// Interactive overlay on top of the preview canvas: select, move, resize,
// zoom (mouse wheel) and reframe (Alt/right-drag) the screen and camera layers.
// Everything here is HTML on top of the canvas, so none of it is recorded.

import { cropFor } from './compositor.js';
import { icon } from './icons.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const LABEL = { screen: 'Tela', camera: 'Câmera' };
const EMPTY = { screen: 'Nenhuma tela selecionada', camera: 'Nenhuma câmera selecionada' };
const MIN = 60;
const MAX_ZOOM = 6;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pct = (v, total) => `${(v / total) * 100}%`;

function inside(l, p) {
  if (l.shape === 'circle') {
    const rx = l.w / 2;
    const ry = l.h / 2;
    const nx = (p.x - (l.x + rx)) / rx;
    const ny = (p.y - (l.y + ry)) / ry;
    return nx * nx + ny * ny <= 1;
  }
  return p.x >= l.x && p.x <= l.x + l.w && p.y >= l.y && p.y <= l.y + l.h;
}

export class Editor {
  constructor({ overlay, getScene, getSourceSize, hasFeed, onBegin, onChange, onCommit, onSelect }) {
    this.el = overlay;
    this.getScene = getScene;
    this.getSourceSize = getSourceSize;
    this.hasFeed = hasFeed;
    this.onBegin = onBegin;
    this.onChange = onChange;
    this.onCommit = onCommit;
    this.onSelect = onSelect;
    this.selected = null;
    this.hover = null;
    this.drag = null;
    this.wheelTimer = null;
    this.W = 1920;
    this.H = 1080;
    this.build();
    this.bind();
  }

  build() {
    this.el.innerHTML = `
      <div class="ov-ghost" data-name="screen"><span>${icon('monitor', 16)} ${EMPTY.screen}</span></div>
      <div class="ov-ghost" data-name="camera"><span>${icon('camera', 16)} ${EMPTY.camera}</span></div>
      <div class="ov-hover"></div>
      <div class="ov-sel">
        <span class="ov-tag"></span>
        ${HANDLES.map((h) => `<span class="ov-h ${h}" data-handle="${h}"></span>`).join('')}
        <div class="zoom-pill" title="Zoom do conteúdo (roda do mouse)">
          <button data-zoom="out" title="Diminuir zoom">${icon('minus', 14)}</button>
          <span class="zoom-val">100%</span>
          <button data-zoom="in" title="Aumentar zoom">${icon('plus', 14)}</button>
          <span class="sep"></span>
          <button data-zoom="reset" title="Mostrar tudo (duplo clique)">${icon('fit', 14)}</button>
        </div>
      </div>
      <div class="ov-guide v"></div>
      <div class="ov-guide h"></div>`;
    this.ghosts = {
      screen: this.el.querySelector('.ov-ghost[data-name="screen"]'),
      camera: this.el.querySelector('.ov-ghost[data-name="camera"]'),
    };
    this.hoverBox = this.el.querySelector('.ov-hover');
    this.sel = this.el.querySelector('.ov-sel');
    this.tag = this.el.querySelector('.ov-tag');
    this.pill = this.el.querySelector('.zoom-pill');
    this.zoomVal = this.el.querySelector('.zoom-val');
    this.guideV = this.el.querySelector('.ov-guide.v');
    this.guideH = this.el.querySelector('.ov-guide.h');
  }

  bind() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.render(); } });
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dblclick', (e) => {
      const name = this.hit(this.toCanvas(e));
      if (name) this.resetZoom(name);
    });
    this.pill.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.pill.addEventListener('dblclick', (e) => e.stopPropagation());
    this.pill.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-zoom]');
      if (!btn || !this.selected) return;
      const kind = btn.dataset.zoom;
      if (kind === 'reset') this.resetZoom(this.selected);
      else this.zoomStep(this.selected, kind === 'in' ? 1.25 : 0.8);
    });
  }

  // ---------------------------------------------------------------- helpers

  setDims(w, h) {
    this.W = w;
    this.H = h;
    this.render();
  }

  toCanvas(e) {
    const r = this.el.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * this.W,
      y: ((e.clientY - r.top) / r.height) * this.H,
      scale: r.width / this.W,
    };
  }

  hit(p) {
    const scene = this.getScene();
    for (const name of [...scene.order].reverse()) {
      const l = scene[name];
      if (l.visible && this.hasFeed(name) && inside(l, p)) return name;
    }
    for (const name of [...scene.order].reverse()) {
      const l = scene[name];
      if (l.visible && inside(l, p)) return name;
    }
    return null;
  }

  select(name) {
    if (this.selected === name) return;
    this.selected = name;
    this.onSelect(name);
    this.render();
  }

  snapTargets(axis, except) {
    const scene = this.getScene();
    const size = axis === 'x' ? this.W : this.H;
    const t = [0, size / 2, size];
    for (const name of ['screen', 'camera']) {
      if (name === except) continue;
      const l = scene[name];
      if (!l.visible) continue;
      const a = axis === 'x' ? l.x : l.y;
      const s = axis === 'x' ? l.w : l.h;
      t.push(a, a + s / 2, a + s);
    }
    return t;
  }

  snap(points, targets, scale) {
    const threshold = 8 / scale;
    let best = null;
    for (const p of points) {
      for (const t of targets) {
        const delta = t - p;
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
          best = { delta, at: t };
        }
      }
    }
    return best || { delta: 0, at: null };
  }

  showGuides(x, y) {
    this.guideV.style.display = x == null ? 'none' : 'block';
    this.guideH.style.display = y == null ? 'none' : 'block';
    if (x != null) this.guideV.style.left = pct(x, this.W);
    if (y != null) this.guideH.style.top = pct(y, this.H);
  }

  // ---------------------------------------------------------------- pointer

  down(e) {
    if (e.target.closest('.zoom-pill')) return;
    const p = this.toCanvas(e);
    const handle = e.target.closest('[data-handle]')?.dataset.handle;
    const scene = this.getScene();
    let name;
    let mode;
    if (handle && this.selected) {
      name = this.selected;
      mode = 'resize';
    } else {
      name = this.hit(p);
      if (!name) {
        this.select(null);
        return;
      }
      this.select(name);
      mode = e.altKey || e.button === 1 || e.button === 2 ? 'pan' : 'move';
    }
    this.drag = { mode, name, handle, start: p, orig: { ...scene[name] }, moved: false };
    this.el.setPointerCapture(e.pointerId);
    this.el.classList.toggle('panning', mode === 'pan');
    this.onBegin();
    e.preventDefault();
  }

  move(e) {
    const p = this.toCanvas(e);
    if (!this.drag) {
      const name = e.target.closest('[data-handle]') ? this.selected : this.hit(p);
      if (name !== this.hover) {
        this.hover = name;
        this.render();
      }
      this.el.style.cursor = name ? (e.altKey ? 'grab' : 'move') : 'default';
      return;
    }
    const d = this.drag;
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) * p.scale < 2) return;
    d.moved = true;
    let patch;
    if (d.mode === 'move') patch = this.moveRect(d, dx, dy, e, p.scale);
    else if (d.mode === 'resize') patch = this.resizeRect(d, dx, dy, e, p.scale);
    else patch = this.panLayer(d, dx, dy);
    if (patch) this.onChange(d.name, patch);
  }

  up(e) {
    if (!this.drag) return;
    const { moved } = this.drag;
    this.drag = null;
    this.el.classList.remove('panning');
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    this.showGuides(null, null);
    this.onCommit(moved);
    this.render();
  }

  moveRect(d, dx, dy, e, scale) {
    const o = d.orig;
    let x = o.x + dx;
    let y = o.y + dy;
    let gx = null;
    let gy = null;
    if (!e.ctrlKey) {
      const sx = this.snap([x, x + o.w / 2, x + o.w], this.snapTargets('x', d.name), scale);
      const sy = this.snap([y, y + o.h / 2, y + o.h], this.snapTargets('y', d.name), scale);
      x += sx.delta;
      y += sy.delta;
      gx = sx.at;
      gy = sy.at;
    }
    this.showGuides(gx, gy);
    return { x: Math.round(x), y: Math.round(y) };
  }

  resizeRect(d, dx, dy, e, scale) {
    const o = d.orig;
    const hd = d.handle;
    const corner = hd.length === 2;
    const lock = o.shape === 'circle' || (corner && !e.shiftKey);
    let x1 = o.x;
    let y1 = o.y;
    let x2 = o.x + o.w;
    let y2 = o.y + o.h;
    if (hd.includes('w')) x1 += dx;
    if (hd.includes('e')) x2 += dx;
    if (hd.includes('n')) y1 += dy;
    if (hd.includes('s')) y2 += dy;

    let gx = null;
    let gy = null;
    if (!e.ctrlKey) {
      const tx = this.snapTargets('x', d.name);
      const ty = this.snapTargets('y', d.name);
      if (hd.includes('w')) { const s = this.snap([x1], tx, scale); x1 += s.delta; gx = s.at; }
      if (hd.includes('e')) { const s = this.snap([x2], tx, scale); x2 += s.delta; gx = s.at; }
      if (!lock || !corner) {
        if (hd.includes('n')) { const s = this.snap([y1], ty, scale); y1 += s.delta; gy = s.at; }
        if (hd.includes('s')) { const s = this.snap([y2], ty, scale); y2 += s.delta; gy = s.at; }
      }
    }

    let w = Math.max(MIN, x2 - x1);
    let h = Math.max(MIN, y2 - y1);
    if (lock) {
      const a = o.w / o.h;
      if (corner) {
        if (Math.abs(w / o.w - 1) >= Math.abs(h / o.h - 1)) h = w / a;
        else w = h * a;
      } else if (hd === 'e' || hd === 'w') {
        h = w / a;
      } else {
        w = h * a;
      }
      if (w < MIN) { w = MIN; h = w / a; }
      if (h < MIN) { h = MIN; w = h * a; }
    }
    let x;
    if (hd.includes('w')) x = o.x + o.w - w;
    else if (hd.includes('e')) x = o.x;
    else x = o.x + (o.w - w) / 2;
    let y;
    if (hd.includes('n')) y = o.y + o.h - h;
    else if (hd.includes('s')) y = o.y;
    else y = o.y + (o.h - h) / 2;

    this.showGuides(gx, gy);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  panLayer(d, dx, dy) {
    const size = this.getSourceSize(d.name);
    if (!size) return null;
    const o = d.orig;
    const s = Math.max(o.w / size.w, o.h / size.h) * Math.max(1, o.zoom);
    const slackX = size.w * s - o.w;
    const slackY = size.h * s - o.h;
    return {
      panX: slackX > 0.5 ? clamp(o.panX - dx / (slackX / 2), -1, 1) : o.panX,
      panY: slackY > 0.5 ? clamp(o.panY - dy / (slackY / 2), -1, 1) : o.panY,
    };
  }

  // ---------------------------------------------------------------- zoom

  zoomPatch(layer, name, factor, p) {
    const zoom = clamp(layer.zoom * factor, 1, MAX_ZOOM);
    const size = this.getSourceSize(name);
    if (!size) return { zoom };
    const { w: sw, h: sh } = size;
    const point = p || { x: layer.x + layer.w / 2, y: layer.y + layer.h / 2 };
    const c0 = cropFor(layer, sw, sh);
    const u = clamp(point.x - layer.x, 0, layer.w);
    const v = clamp(point.y - layer.y, 0, layer.h);
    const srcX = c0.sx + u / c0.s;
    const srcY = c0.sy + v / c0.s;
    const s1 = Math.max(layer.w / sw, layer.h / sh) * zoom;
    const vw = layer.w / s1;
    const vh = layer.h / s1;
    const cx = srcX - u / s1 + vw / 2;
    const cy = srcY - v / s1 + vh / 2;
    return {
      zoom,
      panX: sw - vw > 0.5 ? clamp((cx - sw / 2) / ((sw - vw) / 2), -1, 1) : 0,
      panY: sh - vh > 0.5 ? clamp((cy - sh / 2) / ((sh - vh) / 2), -1, 1) : 0,
    };
  }

  wheel(e) {
    e.preventDefault();
    const p = this.toCanvas(e);
    const name = this.hit(p) || this.selected;
    if (!name) return;
    this.select(name);
    if (!this.wheelTimer) this.onBegin();
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = null;
      this.onCommit(true);
    }, 450);

    const layer = this.getScene()[name];
    const factor = Math.exp(-e.deltaY * 0.0015);
    if (e.ctrlKey) {
      // Ctrl + wheel: resize the frame around the cursor.
      const w = clamp(layer.w * factor, MIN, this.W * 3);
      const k = w / layer.w;
      const h = layer.h * k;
      this.onChange(name, {
        x: Math.round(p.x - (p.x - layer.x) * k),
        y: Math.round(p.y - (p.y - layer.y) * k),
        w: Math.round(w),
        h: Math.round(h),
      });
    } else {
      this.onChange(name, this.zoomPatch(layer, name, factor, p));
    }
  }

  zoomStep(name, factor) {
    const layer = this.getScene()[name];
    this.onBegin();
    this.onChange(name, this.zoomPatch(layer, name, factor));
    this.onCommit(true);
  }

  setZoom(name, zoom) {
    const layer = this.getScene()[name];
    return this.zoomPatch(layer, name, zoom / layer.zoom);
  }

  resetZoom(name) {
    this.onBegin();
    this.onChange(name, { zoom: 1, panX: 0, panY: 0 });
    this.onCommit(true);
  }

  // ---------------------------------------------------------------- render

  place(el, l) {
    el.style.left = pct(l.x, this.W);
    el.style.top = pct(l.y, this.H);
    el.style.width = pct(l.w, this.W);
    el.style.height = pct(l.h, this.H);
    el.style.borderRadius = l.shape === 'circle' ? '50%' : '';
  }

  render() {
    const scene = this.getScene();
    for (const name of ['screen', 'camera']) {
      const l = scene[name];
      const g = this.ghosts[name];
      const show = l.visible && !this.hasFeed(name);
      g.style.display = show ? 'flex' : 'none';
      if (show) this.place(g, l);
    }

    const hv = this.hover && this.hover !== this.selected && !this.drag ? scene[this.hover] : null;
    this.hoverBox.style.display = hv && hv.visible ? 'block' : 'none';
    if (hv) this.place(this.hoverBox, hv);

    const sl = this.selected ? scene[this.selected] : null;
    if (!sl || !sl.visible) {
      this.sel.style.display = 'none';
      return;
    }
    this.sel.style.display = 'block';
    this.place(this.sel, sl);
    this.sel.style.borderRadius = '';
    this.sel.classList.toggle('circle', sl.shape === 'circle');
    this.tag.textContent = LABEL[this.selected];
    this.zoomVal.textContent = `${Math.round(sl.zoom * 100)}%`;
    // Keep the zoom pill inside the canvas when the layer reaches the bottom edge.
    const nearBottom = sl.y + sl.h > this.H - 90;
    const nearTop = sl.y < 40;
    this.sel.classList.toggle('pill-inside', nearBottom);
    this.sel.classList.toggle('tag-inside', nearTop);
  }
}
