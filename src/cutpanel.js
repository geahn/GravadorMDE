// Side panel of the editor: texts (with the style collection), media and
// stickers, zoom, filters, audio, speed and scenes. Every control edits the
// selected item live; one gesture = one undo step.

import { icon } from './icons.js';
import {
  TEXT_STYLES, FONT_LIST, STICKERS, EMOJIS, ANIMS, BASE_STYLE, mergeStyle, drawItem, stickerUrl, layoutText,
} from './textstyles.js';
import { FX_KEYS, FX_PRESETS, cssFilter, isNeutral } from './fx.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (v) => JSON.parse(JSON.stringify(v));
const dec = (v, n = 1) => String(Number(Number(v).toFixed(n))).replace('.', ',');

function fmtClock(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0').replace('.', ',')}`;
}

// ---------------------------------------------------------------- generic fields

export function getK(obj, k) {
  return k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj);
}

// Top-level patch that sets a nested key (copies the objects on the way).
export function patchK(obj, k, v) {
  const parts = k.split('.');
  if (parts.length === 1) return { [k]: v };
  const top = parts[0];
  const root = { ...(obj[top] || {}) };
  let cur = root;
  for (let i = 1; i < parts.length - 1; i++) {
    cur[parts[i]] = { ...(cur[parts[i]] || {}) };
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = v;
  return { [top]: root };
}

const FMT = {
  px: (v) => `${Math.round(v)} px`,
  pct: (v) => `${Math.round(v * 100)}%`,
  pct100: (v) => `${Math.round(v)}%`,
  deg: (v) => `${Math.round(v)}°`,
  s: (v) => `${dec(v, 2)} s`,
  x: (v) => `${dec(v, 2)}×`,
  db: (v) => `${v > 0 ? '+' : ''}${dec(v, 1)} dB`,
  em: (v) => dec(v, 2),
  int: (v) => String(Math.round(v)),
  signed: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
};
const fmtV = (v, f) => (FMT[f] ? FMT[f](Number(v) || 0) : String(v ?? ''));

function parse(el) {
  const t = el.dataset.t || 'num';
  if (t === 'num') return Number(el.value);
  if (t === 'bool') return !!el.checked;
  return el.value;
}

export function range(k, label, val, min, max, step, f = '', { num = false, hint = '' } = {}) {
  const v = Number.isFinite(Number(val)) ? Number(val) : 0;
  return `<div class="cs-field" ${hint ? `title="${esc(hint)}"` : ''}>
    <div class="cs-lab"><span>${label}</span>${num
    ? `<input type="number" class="cs-num" data-k="${k}" data-t="num" min="${min}" max="${max}" step="${num === true ? step : num}" value="${v}" />`
    : `<output data-out="${k}" data-f="${f}">${fmtV(v, f)}</output>`}</div>
    <input type="range" data-k="${k}" data-t="num" min="${min}" max="${max}" step="${step}" value="${v}" style="--p:${((v - min) / (max - min)) * 100}%" />
  </div>`;
}

const SWATCHES = ['#ffffff', '#0c0d11', '#ffd43b', '#ff3b55', '#7b80ff', '#3ddc97', '#38bdf8', '#f472b6', '#ff8c42'];
const hex = (c, fb = '#000000') => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : fb);

export function color(k, label, val) {
  return `<div class="cs-field cs-colorrow">
    <div class="cs-lab"><span>${label}</span></div>
    <div class="cs-colors">
      <label class="cs-cpick" style="--c:${esc(val)}"><input type="color" data-k="${k}" data-t="str" value="${hex(val)}" /></label>
      ${SWATCHES.map((c) => `<button class="cs-sw ${String(val).toLowerCase() === c ? 'on' : ''}" data-set="${k}" data-v="${c}" style="--c:${c}" title="${c}"></button>`).join('')}
    </div>
  </div>`;
}

export function seg(k, label, val, opts) {
  return `<div class="cs-field">${label ? `<div class="cs-lab"><span>${label}</span></div>` : ''}
    <div class="cs-seg">${opts.map(([v, l, t]) => `<button data-set="${k}" data-v="${esc(v)}" class="${String(val) === String(v) ? 'on' : ''}" ${t ? `title="${esc(t)}"` : ''}>${l}</button>`).join('')}</div></div>`;
}

const sec = (id, title, body, open) => `<details class="cs-sec" data-sec="${id}" ${open ? 'open' : ''}><summary>${title}</summary><div class="cs-sec-body">${body}</div></details>`;

// Binds every [data-k] / [data-set] / [data-toggle] under root.
//   get(): the object being edited; patch(p): apply a patch live; commit(): end of the gesture
export function bindFields(root, { get, patch, commit }) {
  const sync = (k, v, except) => {
    for (const el of $$(`[data-k="${CSS.escape(k)}"]`, root)) {
      if (el === except) {
        if (el.type === 'range') el.style.setProperty('--p', `${((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100}%`);
        continue;
      }
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'color') el.value = hex(v, el.value);
      else el.value = v;
      if (el.type === 'range') el.style.setProperty('--p', `${((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100}%`);
    }
    for (const o of $$(`[data-out="${CSS.escape(k)}"]`, root)) o.textContent = fmtV(v, o.dataset.f);
  };
  root.addEventListener('input', (e) => {
    const el = e.target.closest('[data-k]');
    const obj = get();
    if (!el || !obj || el.dataset.k.startsWith('__')) return;
    let v = parse(el);
    if (el.type === 'number') {
      if (!Number.isFinite(v)) return;
      v = clamp(v, Number(el.min), Number(el.max));
    }
    patch(patchK(obj, el.dataset.k, v), el.dataset.k);
    sync(el.dataset.k, v, el);
  });
  root.addEventListener('change', (e) => {
    const el = e.target.closest('[data-k]');
    if (el && !el.dataset.k.startsWith('__')) commit();
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-set], [data-toggle]');
    const obj = get();
    if (!b || !obj) return;
    if (b.dataset.toggle) {
      const k = b.dataset.toggle;
      patch(patchK(obj, k, !getK(obj, k)), k);
    } else {
      const k = b.dataset.set;
      let v = b.dataset.v;
      if (v !== '' && Number.isFinite(Number(v)) && !/^#/.test(v)) v = Number(v);
      if (v === 'null') v = null;
      patch(patchK(obj, k, v), k);
    }
    commit(true);
  });
}

// ---------------------------------------------------------------- style cards (shared with the studio)

export function styleCardsHTML(userStyles = []) {
  const card = (s, user) => `<button class="cs-style" data-style="${esc(s.id)}" ${user ? 'data-user="1"' : ''} title="${esc(s.name)}">
      <canvas width="232" height="104"></canvas>${user ? `<span class="cs-del" data-del-style="${esc(s.id)}" title="Excluir estilo">${icon('x', 12)}</span>` : ''}</button>`;
  return `${userStyles.length ? `<div class="cs-subtitle">Meus estilos <span>${userStyles.length}</span></div><div class="cs-styles">${userStyles.map((s) => card(s, true)).join('')}</div>` : ''}
    <div class="cs-subtitle">Estilos <span>${TEXT_STYLES.length}</span></div>
    <div class="cs-styles">${TEXT_STYLES.map((s) => card(s, false)).join('')}</div>`;
}

const cardCache = new Map();
export function paintStyleCards(root, userStyles = []) {
  const all = [...userStyles, ...TEXT_STYLES];
  for (const btn of $$('.cs-style', root)) {
    const s = all.find((x) => x.id === btn.dataset.style);
    const cv = btn.querySelector('canvas');
    if (!s || !cv) continue;
    const key = JSON.stringify(s.style) + s.name;
    const ctx = cv.getContext('2d');
    const W = cv.width;
    const H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const cached = cardCache.get(key);
    if (cached) { ctx.drawImage(cached, 0, 0); continue; }
    // The style's own look with its name, scaled so every card reads the same size.
    const item = { kind: 'text', text: s.name, style: s.style, x: 0.5, y: 0.5, scale: 1, rot: 0 };
    const L = layoutText(item, W, H);
    const k = Math.min((H * 0.44) / Math.max(1, L.h), (W * 0.84) / Math.max(1, L.w));
    drawItem(ctx, { ...item, scale: k }, W, H, null, null);
    const copy = document.createElement('canvas');
    copy.width = W;
    copy.height = H;
    copy.getContext('2d').drawImage(cv, 0, 0);
    cardCache.set(key, copy);
  }
}

// ---------------------------------------------------------------- text properties (shared with the studio)

export function textPropsHTML(o, { fonts = [], open = new Set(['fonte', 'cor']), timing = '', anim = true } = {}) {
  const s = mergeStyle(o.style);
  const fontOpts = FONT_LIST.map(([n]) => `<option ${n === s.font ? 'selected' : ''}>${esc(n)}</option>`).join('')
    + (fonts.length ? `<optgroup label="Instaladas no computador">${fonts.map((n) => `<option ${n === s.font ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>` : '')
    + (!FONT_LIST.some(([n]) => n === s.font) && !fonts.includes(s.font) ? `<option selected>${esc(s.font)}</option>` : '');
  const tog = (k, ic, title) => `<button class="cs-ibtn ${getK({ style: s }, k) ? 'on' : ''}" data-toggle="${k}" title="${title}">${icon(ic, 15)}</button>`;
  return `
    <textarea class="cs-text" data-k="text" data-t="str" rows="3" spellcheck="false" placeholder="Digite o texto">${esc(o.text)}</textarea>
    ${sec('fonte', 'Fonte', `
      <div class="cs-row">
        <select class="cs-select" data-k="style.font" data-t="str">${fontOpts}</select>
        <button class="cs-ibtn" data-act="fonts" title="Carregar as fontes instaladas no computador">${icon('plus', 15)}</button>
      </div>
      ${range('style.size', 'Tamanho', s.size, 8, 300, 1, 'px', { num: 1 })}
      <div class="cs-row">
        <select class="cs-select sm" data-k="style.weight" data-t="num" title="Peso">
          ${[[100, 'Fino'], [200, 'Extra leve'], [300, 'Leve'], [400, 'Normal'], [500, 'Médio'], [600, 'Seminegrito'], [700, 'Negrito'], [800, 'Extra negrito'], [900, 'Black']].map(([v, l]) => `<option value="${v}" ${Number(s.weight) === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        ${tog('style.italic', 'italic', 'Itálico')}${tog('style.underline', 'underline', 'Sublinhado')}${tog('style.upper', 'caseUp', 'MAIÚSCULAS')}
      </div>
      <div class="cs-seg icons">
        ${[['left', 'alignLeft'], ['center', 'alignCenter'], ['right', 'alignRight']].map(([v, ic]) => `<button data-set="style.align" data-v="${v}" class="${s.align === v ? 'on' : ''}">${icon(ic, 15)}</button>`).join('')}
      </div>
      ${range('style.letter', 'Espaço entre letras', s.letter, -0.1, 0.6, 0.01, 'em')}
      ${range('style.line', 'Altura da linha', s.line, 0.8, 2.2, 0.05, 'em')}
      ${seg('style.stretch', 'Largura', s.stretch, [['normal', 'Normal'], ['semi-condensed', 'Estreita'], ['condensed', 'Condensada']])}
    `, open.has('fonte'))}
    ${sec('cor', 'Cor', `
      ${color('style.color', 'Texto', s.color)}
      <label class="cs-check"><input type="checkbox" class="switch sm" data-act="gradient" ${Array.isArray(s.gradient) ? 'checked' : ''} /><span>Degradê</span></label>
      ${Array.isArray(s.gradient) ? `<div class="cs-row">
        <label class="cs-cpick big" style="--c:${esc(s.gradient[0])}"><input type="color" data-k="style.gradient.0" data-t="str" value="${hex(s.gradient[0])}" /></label>
        <span class="cs-arrow">→</span>
        <label class="cs-cpick big" style="--c:${esc(s.gradient[1])}"><input type="color" data-k="style.gradient.1" data-t="str" value="${hex(s.gradient[1])}" /></label></div>` : ''}
    `, open.has('cor'))}
    ${sec('fundo', 'Fundo', `
      ${seg('style.bg', '', s.bg, [['none', 'Nenhum'], ['box', 'Caixa'], ['lines', 'Por linha']])}
      ${s.bg !== 'none' ? `${color('style.bgColor', 'Cor do fundo', s.bgColor)}
      ${range('style.bgOpacity', 'Opacidade do fundo', s.bgOpacity, 0, 1, 0.01, 'pct')}
      ${range('style.padX', 'Margem lateral', s.padX, 0, 2, 0.01, 'em')}
      ${range('style.padY', 'Margem vertical', s.padY, 0, 1.5, 0.01, 'em')}
      ${range('style.radius', 'Cantos', Math.min(s.radius, 2), 0, 2, 0.01, 'em', { hint: 'No máximo vira uma pílula' })}` : ''}
    `, open.has('fundo'))}
    ${sec('contorno', 'Contorno e borda', `
      ${range('style.stroke', 'Contorno das letras', s.stroke, 0, 0.25, 0.005, 'em')}
      ${s.stroke > 0 ? color('style.strokeColor', 'Cor do contorno', s.strokeColor) : ''}
      ${range('style.border', 'Borda da caixa', s.border, 0, 0.2, 0.005, 'em')}
      ${s.border > 0 ? color('style.borderColor', 'Cor da borda', s.borderColor) : ''}
    `, open.has('contorno'))}
    ${sec('sombra', 'Sombra e brilho', `
      ${range('style.shadow', 'Sombra (desfoque)', s.shadow, 0, 1, 0.01, 'em')}
      ${range('style.shadowX', 'Sombra · horizontal', s.shadowX, -0.3, 0.3, 0.005, 'em')}
      ${range('style.shadowY', 'Sombra · vertical', s.shadowY, -0.3, 0.3, 0.005, 'em')}
      ${color('style.shadowColor', 'Cor da sombra', s.shadowColor)}
      ${range('style.glow', 'Brilho (neon)', s.glow, 0, 1, 0.01, 'em')}
      ${s.glow > 0 ? color('style.glowColor', 'Cor do brilho', s.glowColor) : ''}
    `, open.has('sombra'))}
    ${posHTML(o, open, { anim })}
    ${timing}`;
}

export function posHTML(o, open, { anim = true } = {}) {
  const P = [0.15, 0.5, 0.85];
  return sec('pos', 'Posição e animação', `
    <div class="cs-posgrid">${P.map((y) => P.map((x) => `<button data-pos="${x},${y}" class="${Math.abs(o.x - x) < 0.01 && Math.abs(o.y - y) < 0.01 ? 'on' : ''}"><i></i></button>`).join('')).join('')}</div>
    ${range('opacity', 'Opacidade', o.opacity ?? 1, 0, 1, 0.01, 'pct')}
    ${range('rot', 'Rotação', o.rot || 0, -180, 180, 1, 'deg')}
    ${anim ? `<div class="cs-row two">
      <label class="cs-mini"><span>Entrada</span><select class="cs-select" data-k="anim.in" data-t="str">${ANIMS.map(([v, l]) => `<option value="${v}" ${(o.anim && o.anim.in) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="cs-mini"><span>Saída</span><select class="cs-select" data-k="anim.out" data-t="str">${ANIMS.map(([v, l]) => `<option value="${v}" ${(o.anim && o.anim.out) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    ${range('anim.d', 'Duração da animação', (o.anim && o.anim.d) || 0.35, 0.1, 2, 0.05, 's')}` : ''}
  `, open.has('pos'));
}

// ---------------------------------------------------------------- the panel

const TABS = [
  ['texto', 'Texto', 'type'], ['midia', 'Mídia', 'image'], ['layout', 'Layout', 'layout'], ['filtros', 'Filtros', 'palette'],
  ['audio', 'Áudio', 'headphones'], ['velocidade', 'Veloc.', 'gauge'], ['cenas', 'Cenas', 'clapper'],
];

const EQ_PRESETS = [
  ['Natural', { bass: 0, mid: 0, treble: 0 }],
  ['Voz clara', { bass: -2, mid: 2, treble: 4 }],
  ['Voz encorpada', { bass: 4, mid: 0, treble: 1.5 }],
  ['Podcast', { bass: 3, mid: 1.5, treble: 3 }],
  ['Menos chiado', { bass: 0, mid: 0, treble: -5 }],
  ['Rádio', { bass: -6, mid: 5, treble: -2 }],
];

export class CutPanel {
  constructor(cut) {
    this.c = cut;
    this.root = $('#cut-side');
    this.tab = 'texto';
    this.open_ = new Set(['fonte', 'cor', 'pos']);
    this.fxScope = 'global';
    this.stickerColor = '#ff3b55';
    this.localFonts = [];
    this.root.innerHTML = `
      <nav class="cs-tabs">${TABS.map(([id, label, ic]) => `<button data-tab="${id}" title="${label}">${icon(ic, 17)}<span>${label}</span></button>`).join('')}</nav>
      <div class="cs-body" id="cs-body"></div>`;
    this.body = $('#cs-body', this.root);
    this.bind();
  }

  get sel() {
    return this.c.selected;
  }

  open() {
    this.dirty = false;
    this.render();
  }

  setTab(tab) {
    this.tab = tab;
    this.render(true);
  }

  showFor(ref) {
    const it = this.c.findItem(ref);
    if (ref && it) {
      if (ref.lane === 'zoom' || ref.lane === 'layout') this.tab = 'layout';
      else if (ref.lane === 'fx' || ref.lane === 'fxg') {
        this.tab = 'filtros';
        this.fxScope = ref.lane === 'fx' ? 'range' : 'global';
      }
      else this.tab = it.kind === 'text' ? 'texto' : 'midia';
    }
    this.render(true);
  }

  focusText() {
    this.tab = 'texto';
    this.render(true);
    const ta = $('.cs-text', this.body);
    if (ta) { ta.focus(); ta.select(); }
  }

  // Re-rendering while a control is being used would drop it from under the mouse.
  busy() {
    const a = document.activeElement;
    return a && this.body.contains(a) && a.matches('input, textarea, select');
  }

  render(force = false) {
    if (!this.c.p) return;
    $$('.cs-tabs button', this.root).forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    if (!force && this.busy()) { this.dirty = true; return; }
    this.dirty = false;
    const scroll = this.body.scrollTop;
    const html = this[`tab_${this.tab}`]();
    this.body.innerHTML = html;
    this.body.scrollTop = force ? 0 : scroll;
    if (this.tab === 'texto') paintStyleCards(this.body, this.userStyles());
    if (this.tab === 'filtros') this.paintFxThumbs();
  }

  // Keeps the fields of the selected item in step while it is dragged in the preview / timeline.
  syncSelected() {
    if (this.syncQueued) return;
    this.syncQueued = true;
    requestAnimationFrame(() => {
      this.syncQueued = false;
      if (!this.busy()) this.render();
    });
  }

  userStyles() {
    return (this.c.getPrefs().userTextStyles || []).filter((s) => s && s.style);
  }

  userFilters() {
    return (this.c.getPrefs().userFilters || []).filter((f) => f && f.p);
  }

  timingHTML(it, lane) {
    const { o0, o1 } = this.c.span(it);
    return sec('tempo', 'Tempo', `
      <div class="cs-row two">
        <label class="cs-mini"><span>Começa em (s)</span><input type="number" class="cs-num wide" data-k="__o0" min="0" max="${this.c.outDur.toFixed(2)}" step="0.1" value="${o0.toFixed(2)}" /></label>
        <label class="cs-mini"><span>Duração (s)</span><input type="number" class="cs-num wide" data-k="__dur" min="0.1" max="${Math.max(0.1, this.c.outDur - o0).toFixed(2)}" step="0.1" value="${(o1 - o0).toFixed(2)}" /></label>
      </div>
      <div class="cs-row"><button class="btn sm" data-act="to-playhead" title="Começar na agulha">${icon('chevron', 14)} Começar na agulha</button>
      <button class="btn sm" data-act="to-sel" ${this.c.sel ? '' : 'disabled'} title="Ocupar o trecho selecionado">Usar seleção</button></div>
      <p class="cs-note">${lane === 'zoom' || lane === 'layout' ? 'Dica: arraste o bloco na faixa “Layout” ou as pontas dele.' : 'Dica: arraste o bloco na linha do tempo ou as pontas dele.'}</p>
    `, true);
  }

  actionsHTML(dup = true) {
    return `<div class="cs-actions">
      ${dup ? `<button class="btn sm" data-act="dup" title="Duplicar (Ctrl+D)">${icon('duplicate', 14)} Duplicar</button>` : ''}
      <button class="btn sm danger-ghost" data-act="del" title="Excluir (Del)">${icon('trash', 14)} Excluir</button></div>`;
  }

  // ---------------------------------------------------------------- tabs

  tab_texto() {
    const o = this.sel && this.c.selItem.lane === 'ov' && this.sel.kind === 'text' ? this.sel : null;
    return `
      <div class="cs-head"><h4>${o ? 'Texto selecionado' : 'Textos'}</h4>
        <button class="btn sm primary" data-act="add-text" title="Novo texto na agulha (X)">${icon('plus', 14)} Novo texto</button></div>
      ${o ? `<div class="cs-props">${textPropsHTML(o, { fonts: this.localFonts, open: this.open_, timing: this.timingHTML(o, 'ov') })}
        <div class="cs-actions"><button class="btn sm" data-act="save-style">${icon('save', 14)} Salvar como estilo</button></div>
        ${this.actionsHTML()}</div>` : '<p class="cs-note">Escolha um estilo para inserir um texto na agulha (ou no trecho selecionado). Depois é só editar o texto, arrastar na prévia e ajustar o tempo na linha do tempo.</p>'}
      ${o ? '<div class="cs-subtitle">Trocar o estilo</div>' : ''}
      ${styleCardsHTML(this.userStyles())}`;
  }

  tab_midia() {
    const o = this.sel && this.c.selItem.lane === 'ov' && this.sel.kind !== 'text' ? this.sel : null;
    let props = '';
    if (o) {
      const isMedia = o.kind === 'image' || o.kind === 'video';
      props = `<div class="cs-props">
        ${range('w', 'Tamanho', o.w || 0.25, 0.03, 1.5, 0.005, 'pct')}
        ${o.kind === 'sticker' ? color('color', 'Cor', o.color || '#ff3b55') : ''}
        ${isMedia ? range('radius', 'Cantos arredondados', o.radius || 0, 0, 0.5, 0.01, 'pct') : ''}
        ${isMedia ? range('border', 'Borda', o.border || 0, 0, 30, 1, 'px') : ''}
        ${isMedia && o.border > 0 ? color('borderColor', 'Cor da borda', o.borderColor || '#ffffff') : ''}
        ${o.kind !== 'video' ? `<label class="cs-check"><input type="checkbox" class="switch sm" data-k="shadow" data-t="bool" ${o.shadow ? 'checked' : ''} /><span>Sombra</span></label>` : ''}
        ${o.kind === 'video' ? `${o.src.hasAudio ? range('volume', 'Volume do vídeo', o.volume ?? 1, 0, 2, 0.01, 'pct') : '<p class="cs-note">Este vídeo não tem som.</p>'}
          ${o.src.duration ? range('trim', 'Começar o clipe em', o.trim || 0, 0, Math.max(0, o.src.duration - 0.2), 0.05, 's') : ''}` : ''}
        ${posHTML(o, this.open_)}
        ${this.timingHTML(o, 'ov')}
        ${this.actionsHTML()}
      </div>`;
    }
    return `
      <div class="cs-head"><h4>${o ? ({ image: 'Imagem', video: 'Vídeo', sticker: 'Sticker', emoji: 'Emoji' }[o.kind]) : 'Imagens, vídeos e stickers'}</h4>
        <button class="btn sm primary" data-act="add-media">${icon('plus', 14)} Arquivo…</button></div>
      ${props || '<p class="cs-note">Insira uma imagem, um GIF ou um vídeo (com o som dele), ou um sticker. Ele entra na agulha e você posiciona arrastando na prévia.</p>'}
      <div class="cs-subtitle">Stickers</div>
      <div class="cs-colors small">${SWATCHES.map((c) => `<button class="cs-sw ${this.stickerColor === c ? 'on' : ''}" data-sticker-color="${c}" style="--c:${c}"></button>`).join('')}</div>
      <div class="cs-stickers">${STICKERS.map((s) => `<button data-sticker="${s.id}" title="${esc(s.name)}"><img src="${stickerUrl(s.id, this.stickerColor)}" alt="" /></button>`).join('')}</div>
      <div class="cs-subtitle">Emojis</div>
      <div class="cs-emojis">${EMOJIS.map((e) => `<button data-emoji="${e}">${e}</button>`).join('')}</div>`;
  }

  // Layout: zooms (whole picture, or inside the screen / the camera) and the
  // layout of each stretch (the formats registered in the studio, adjustable here).
  tab_layout() {
    const c = this.c;
    const ref = c.selItem;
    const z = this.sel && ref && ref.lane === 'zoom' ? this.sel : null;
    const lay = this.sel && ref && ref.lane === 'layout' ? this.sel : null;
    const canLayer = c.canLayerZoom();
    const canRe = c.canRecompose();
    const list = [...c.zooms].map((x) => ({ x, ...c.span(x) })).sort((a, b) => a.o0 - b.o0);
    const TG = { all: 'tudo', screen: 'tela', camera: 'câmera' };
    const zoomProps = z ? `<div class="cs-props">
        ${seg('target', 'Zoom em', z.target || 'all', [['all', 'Tudo', 'O vídeo inteiro'], ['screen', `${icon('monitor', 14)} Tela`, 'Só dentro da tela'], ['camera', `${icon('camera', 14)} Câmera`, 'Só dentro da câmera']])}
        ${!canLayer && (z.target || 'all') !== 'all' ? '<p class="cs-warn">Esta aula não tem o registro do layout da gravação: o zoom vale para o vídeo inteiro.</p>' : ''}
        ${!canLayer ? '<p class="cs-note">Zoom só na tela ou só na câmera: em gravações feitas a partir desta versão (com a câmera e a tela em arquivos separados).</p>' : ''}
        ${range('scale', 'Aproximação', z.scale, 1.1, 5, 0.05, 'x', { num: 0.01 })}
        ${(z.target || 'all') !== 'camera' ? seg('mode', 'Foco', z.mode, [['fixed', `${icon('crop', 14)} Ponto fixo`], ['follow', `${icon('mouse', 14)} Seguir o mouse`]]) : ''}
        ${z.mode === 'follow' && !c.cursor ? '<p class="cs-warn">Esta gravação não tem o movimento do mouse. Usando o ponto fixo.</p>' : ''}
        ${z.mode === 'fixed' || (z.target || 'all') === 'camera' ? `<p class="cs-note">Arraste o retângulo na prévia para escolher o ponto, ou use:</p>
          <div class="cs-posgrid">${[0.25, 0.5, 0.75].map((y) => [0.25, 0.5, 0.75].map((x) => `<button data-zpos="${x},${y}"><i></i></button>`).join('')).join('')}</div>` : '<p class="cs-note">A câmera acompanha o mouse com suavidade e só se mexe quando ele sai do centro.</p>'}
        ${range('ease', 'Suavidade da entrada e saída', z.ease ?? 0.6, 0.1, 2, 0.05, 's')}
        ${this.timingHTML(z, 'zoom')}
        ${this.actionsHTML(false)}
      </div>` : '';
    return `
      <div class="cs-head"><h4>Zoom</h4><button class="btn sm primary" data-act="add-zoom" data-target="all" title="Zoom no trecho selecionado ou na agulha (Z)">${icon('plus', 14)} Zoom</button></div>
      <div class="cs-row">
        <button class="btn sm" data-act="add-zoom" data-target="screen" ${canLayer ? '' : 'disabled'} title="Aproxima só a tela, sem mexer na câmera">${icon('monitor', 14)} Zoom na tela</button>
        <button class="btn sm" data-act="add-zoom" data-target="camera" ${canLayer ? '' : 'disabled'} title="Aproxima só a câmera">${icon('camera', 14)} Zoom na câmera</button>
      </div>
      ${zoomProps || (c.sel ? '<p class="cs-note">O zoom vai cobrir o trecho selecionado.</p>' : '<p class="cs-note">Selecione um trecho na linha do tempo (ou deixe a agulha onde o zoom começa) e adicione.</p>')}
      ${list.length ? `<div class="cs-list">${list.map(({ x, o0, o1 }) => `<button class="cs-li ${z && z.id === x.id ? 'on' : ''}" data-pick-zoom="${x.id}">
          <span class="cs-dot" style="--c:#f5b84a"></span><span>${fmtClock(o0)} – ${fmtClock(o1)}</span><b>${dec(x.scale, 2)}× · ${TG[x.target || 'all']}${x.mode === 'follow' && x.target !== 'camera' ? ' · mouse' : ''}</b></button>`).join('')}</div>` : ''}
      <div class="cs-head cs-head2"><h4>Formato</h4></div>
      ${canRe ? `<p class="cs-note">${lay ? 'Escolha outro formato para este trecho ou ajuste abaixo.' : (c.sel ? 'Clique em um formato para usá-lo no trecho selecionado.' : 'Clique em um formato: ele entra na agulha por 5 s (ou selecione o trecho antes).')}</p>
        ${this.formatsHTML(lay)}
        ${lay ? this.layoutPropsHTML(lay) : ''}`
    : '<p class="cs-note">Trocar o formato depois de gravar precisa dos arquivos separados da câmera e da tela, que as gravações feitas a partir desta versão sempre têm.</p>'}`;
  }

  orientation() {
    const p = this.c.p;
    return p.orientation || ((p.height || 0) > (p.width || 1) ? 'v' : 'h');
  }

  formats() {
    return this.c.getLayoutFormats(this.orientation()) || [];
  }

  // Little drawing of a layout: the screen (blue) and the camera (pink).
  formatThumb(sc) {
    const W = this.c.p.width || 1920;
    const H = this.c.p.height || 1080;
    const r = (L, color) => {
      if (!L || L.visible === false) return '';
      const rad = L.shape === 'circle' ? Math.min(L.w, L.h) / 2 : (L.radius || 0);
      return `<rect x="${L.x}" y="${L.y}" width="${L.w}" height="${L.h}" rx="${rad}" fill="${color}" ${L.borderWidth > 0 ? `stroke="${esc(L.borderColor || '#fff')}" stroke-width="${L.borderWidth * 2}"` : ''}/>`;
    };
    const order = sc.order || ['screen', 'camera'];
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><rect width="${W}" height="${H}" fill="#1b1e26"/>${order.map((k) => r(sc[k], k === 'screen' ? '#5b8def' : '#f472b6')).join('')}</svg>`;
  }

  formatsHTML(lay) {
    const list = this.formats();
    const cur = lay ? JSON.stringify(lay.scene) : '';
    const v = this.orientation() === 'v';
    return `<div class="cs-formats ${v ? 'v' : ''}">${list.map((f) => {
      const sc = { order: f.order, screen: f.screen, camera: f.camera };
      return `<button class="cs-format ${cur === JSON.stringify(sc) ? 'on' : ''}" data-format="${esc(f.id)}" title="${esc(f.name)}">${this.formatThumb(sc)}<span>${esc(f.name)}</span></button>`;
    }).join('')}</div>`;
  }

  layoutPropsHTML(lay) {
    const W = this.c.p.width || 1920;
    const H = this.c.p.height || 1080;
    const sc = lay.scene;
    const layer = (k, title) => {
      const L = sc[k] || {};
      const pre = `scene.${k}`;
      return sec(`lay-${k}`, title, `
        <label class="cs-check"><input type="checkbox" class="switch sm" data-k="${pre}.visible" data-t="bool" ${L.visible !== false ? 'checked' : ''} /><span>Mostrar</span></label>
        ${L.visible !== false ? `
        <div class="cs-row two">${range(`${pre}.x`, 'Esquerda', L.x, -W / 2, W, 1, 'px', { num: 1 })}${range(`${pre}.y`, 'Topo', L.y, -H / 2, H, 1, 'px', { num: 1 })}</div>
        <div class="cs-row two">${range(`${pre}.w`, 'Largura', L.w, 40, W * 1.2, 1, 'px', { num: 1 })}${range(`${pre}.h`, 'Altura', L.h, 40, H * 1.2, 1, 'px', { num: 1 })}</div>
        ${seg(`${pre}.shape`, 'Forma', L.shape || 'rect', [['rect', 'Retângulo'], ['circle', 'Círculo']])}
        ${L.shape !== 'circle' ? range(`${pre}.radius`, 'Cantos', L.radius || 0, 0, 300, 1, 'px') : ''}
        ${range(`${pre}.zoom`, 'Aproximar a imagem', L.zoom || 1, 1, 3, 0.01, 'x')}
        ${(L.zoom || 1) > 1.001 ? `${range(`${pre}.panX`, 'Mover na horizontal', L.panX || 0, -1, 1, 0.01, 'em')}${range(`${pre}.panY`, 'Mover na vertical', L.panY || 0, -1, 1, 0.01, 'em')}` : ''}
        ${range(`${pre}.borderWidth`, 'Borda', L.borderWidth || 0, 0, 24, 1, 'px')}
        ${(L.borderWidth || 0) > 0 ? color(`${pre}.borderColor`, 'Cor da borda', L.borderColor || '#ffffff') : ''}
        <label class="cs-check"><input type="checkbox" class="switch sm" data-k="${pre}.shadow" data-t="bool" ${L.shadow ? 'checked' : ''} /><span>Sombra</span></label>` : ''}
      `, this.open_.has(`lay-${k}`));
    };
    const camFront = (sc.order || ['screen', 'camera'])[1] === 'camera';
    return `<div class="cs-props">
      <div class="cs-subtitle">Ajustar “${esc(lay.name || 'Layout')}” neste trecho</div>
      ${layer('screen', 'Tela')}
      ${layer('camera', 'Câmera')}
      <div class="cs-row"><button class="btn sm" data-act="swap-order">${camFront ? 'Pôr a tela na frente' : 'Pôr a câmera na frente'}</button></div>
      <div class="cs-row"><input type="text" class="cs-input" id="cs-format-name" placeholder="Nome do novo formato" maxlength="40" value="" />
        <button class="btn sm" data-act="save-format" title="Cadastra este layout nos formatos do estúdio">${icon('save', 14)} Salvar formato</button></div>
      ${this.timingHTML(lay, 'layout')}
      ${this.actionsHTML()}
    </div>`;
  }

  tab_filtros() {
    const c = this.c;
    if (this.fxScope === 'global' && c.fxGlobal && (!c.selItem || c.selItem.lane !== 'fxg')) c.selItem = { lane: 'fxg', id: 'global' };
    const ref = c.selItem;
    const f = ref && (ref.lane === 'fx' || ref.lane === 'fxg') ? this.sel : null;
    const user = this.userFilters();
    const cam = c.getPrefs().cameraFilter;
    const scope = this.fxScope;
    const cur = scope === 'camera' ? cam : scope === 'global' ? c.fxGlobal : f;
    const card = (id, name, p, userId = null) => `<button class="cs-fx ${cur && cur.name === name && JSON.stringify(cur.p) === JSON.stringify(p) ? 'on' : ''}" data-fx="${esc(id)}" ${userId ? `data-user-fx="${esc(userId)}"` : ''}>
        <canvas width="112" height="64" data-fx-thumb="${esc(id)}"></canvas><span>${esc(name)}</span>
        ${userId ? `<i class="cs-del" data-del-fx="${esc(userId)}" title="Excluir filtro">${icon('x', 11)}</i>` : ''}</button>`;
    const editing = scope === 'camera' ? null : f;
    return `
      <div class="cs-head"><h4>Filtros</h4></div>
      <div class="cs-seg wide" data-scope>
        <button data-fx-scope="global" class="${scope === 'global' ? 'on' : ''}">Vídeo inteiro</button>
        <button data-fx-scope="range" class="${scope === 'range' ? 'on' : ''}">Trecho</button>
      </div>
      <p class="cs-note">${scope === 'global' ? 'O filtro vale para a aula toda. Filtros de trecho ficam por cima dele.'
    : scope === 'range' ? (c.sel ? 'Vai cobrir o trecho selecionado.' : 'Vai entrar na agulha com 5 s; ajuste na faixa “Filtros” da linha do tempo.')
      : `Aplicado direto na câmera durante as próximas gravações (fica gravado no vídeo). ${cam ? `Atual: <b>${esc(cam.name)}</b>.` : 'Nenhum agora.'}`}</p>
      <div class="cs-fxgrid">
        ${card('none', 'Original', {})}
        ${FX_PRESETS.map((p) => card(p.id, p.name, p.p)).join('')}
      </div>
      ${user.length ? `<div class="cs-subtitle">Meus filtros <span>${user.length}</span></div><div class="cs-fxgrid">${user.map((u) => card(`u-${u.id}`, u.name, u.p, u.id)).join('')}</div>` : ''}
      ${editing ? `<div class="cs-props">
        <div class="cs-subtitle">Ajustar “${esc(editing.name || 'filtro')}” ${ref.lane === 'fxg' ? '· vídeo inteiro' : '· trecho'}</div>
        ${FX_KEYS.map((k) => range(`p.${k.key}`, k.label, (editing.p || {})[k.key] || 0, k.min, k.max, 1, k.unit === '°' ? 'deg' : 'signed')).join('')}
        <div class="cs-row"><input type="text" class="cs-input" id="cs-fx-name" placeholder="Nome do filtro" maxlength="30" value="${esc(editing.name && !FX_PRESETS.some((p) => p.name === editing.name) && editing.name !== 'Original' ? editing.name : '')}" />
          <button class="btn sm" data-act="save-fx">${icon('save', 14)} Salvar</button></div>
        <div class="cs-actions"><button class="btn sm" data-act="reset-fx">Zerar ajustes</button>
          <button class="btn sm danger-ghost" data-act="del">${icon('trash', 14)} Remover filtro</button></div>
        ${ref.lane === 'fx' ? this.timingHTML(f, 'fx') : ''}
      </div>` : ''}
      ${scope === 'camera' && cam ? `<div class="cs-actions"><button class="btn sm" data-act="cam-off">Tirar o filtro da câmera</button></div>` : ''}`;
  }

  tab_audio() {
    const a = this.c.audioFx;
    const side = !!(this.c.p.sidecars);
    return `
      <div class="cs-head"><h4>Áudio</h4></div>
      <div class="cs-props" data-audio>
        <div class="cs-subtitle">Volumes</div>
        ${range('master', 'Master (volume final)', a.master, 0, 2, 0.01, 'pct')}
        ${range('mic', 'Microfone', a.mic, 0, 2, 0.01, 'pct')}
        ${side ? range('sys', 'Áudio do computador (tela)', a.sys, 0, 2, 0.01, 'pct')
    : '<p class="cs-note">O áudio do computador não foi gravado separado nesta aula. Nas próximas, com “áudio do computador” ligado, dá para equilibrar microfone e computador aqui.</p>'}
        ${range('media', 'Vídeos inseridos', a.media, 0, 2, 0.01, 'pct')}
        <div class="cs-subtitle">Equalizador</div>
        <div class="cs-chips">${EQ_PRESETS.map(([n, v]) => `<button data-eq='${JSON.stringify(v)}' class="${a.bass === v.bass && a.mid === v.mid && a.treble === v.treble ? 'on' : ''}">${n}</button>`).join('')}</div>
        ${range('bass', 'Grave', a.bass, -12, 12, 0.5, 'db')}
        ${range('mid', 'Médio', a.mid, -12, 12, 0.5, 'db')}
        ${range('treble', 'Agudo', a.treble, -12, 12, 0.5, 'db')}
        <div class="cs-subtitle">Ruído</div>
        ${seg('denoise', 'Redução de ruído', a.denoise, [[0, 'Desligada'], [1, 'Leve'], [2, 'Média'], [3, 'Forte']])}
        <label class="cs-check"><input type="checkbox" class="switch sm" data-k="gate" data-t="bool" ${a.gate ? 'checked' : ''} /><span>Silenciar o ruído entre as falas</span></label>
        <p class="cs-note">Master, grave, médio e agudo você ouve na hora. Redução de ruído e o equilíbrio entre microfone e computador: use “Ouvir prévia”. Com o nivelamento de áudio ligado (Configurações), o volume final é ajustado pelo Master.</p>
        <div class="cs-actions"><button class="btn sm" data-act="audio-preview">${icon('headphones', 14)} Ouvir prévia (10 s)</button></div>
        <audio id="cs-audio-prev" controls hidden></audio>
        <div class="cs-subtitle">Baixar só o áudio</div>
        ${seg('__fmt', '', this.audioFmt || 'mp3', [['mp3', 'MP3'], ['wav', 'WAV'], ['m4a', 'M4A']])}
        <div class="cs-actions"><button class="btn sm primary" data-act="audio-export">${icon('download', 14)} Baixar áudio editado</button></div>
        <p class="cs-note">Com todos os cortes, velocidade, volumes, equalizador e redução de ruído. Bom para transcrever em outra ferramenta ou publicar como podcast.</p>
      </div>`;
  }

  tab_velocidade() {
    const c = this.c;
    const before = c.seq.reduce((s, it) => s + (it.t === 's' ? it.b - it.a : it.o1 - it.o0), 0);
    return `
      <div class="cs-head"><h4>Velocidade</h4></div>
      <div class="cs-props" data-speed>
        ${range('speed', 'Vídeo inteiro', c.speed, 0.25, 4, 0.05, 'x', { num: 0.01 })}
        <div class="cs-chips">${[0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 3].map((v) => `<button data-speed="${v}" class="${Math.abs(c.speed - v) < 1e-3 ? 'on' : ''}">${dec(v, 2)}×</button>`).join('')}</div>
        <p class="cs-note">Duração da aula: <b>${fmtClock(c.outDur)}</b>${Math.abs(c.outDur - before) > 0.05 ? ` (em 1×: ${fmtClock(before)})` : ''}. Vale para a prévia e para a exportação; a voz não fica fina nem grossa.</p>
        <div class="cs-subtitle">Trecho selecionado</div>
        ${c.sel ? `<div class="cs-row"><input type="number" class="cs-num wide" id="cs-range-speed" min="0.1" max="16" step="0.01" value="${this.rangeSpeed || 1.5}" />
          <button class="btn sm primary" data-act="range-speed">Aplicar ao trecho</button></div>
          <div class="cs-chips">${[0.5, 0.75, 1.25, 1.5, 2, 4].map((v) => `<button data-range-speed="${v}">${dec(v, 2)}×</button>`).join('')}</div>
          <p class="cs-note">Use 1× para voltar o trecho ao normal. Esse valor multiplica a velocidade do vídeo inteiro.</p>`
    : '<p class="cs-note">Selecione um trecho na linha do tempo para acelerar ou desacelerar só ele (ex.: uma instalação demorada a 4×).</p>'}
        ${c.speeds.length ? `<div class="cs-list">${c.speeds.map(([a, b, s], i) => {
    const o = c.outOfSrc(a);
    return `<div class="cs-li"><span class="cs-dot" style="--c:${s > 1 ? '#3ddc97' : '#f5b84a'}"></span>
            <button class="link" data-seek="${o ?? ''}">${o == null ? 'trecho cortado' : fmtClock(o)}</button><span>${dec(b - a, 1)} s</span><b>${dec(s, 2)}×</b>
            <button class="cs-x" data-del-speed="${i}" title="Voltar ao normal">${icon('x', 12)}</button></div>`;
  }).join('')}</div>` : ''}
      </div>`;
  }

  tab_cenas() {
    const c = this.c;
    const can = !!(c.p.folder && c.p.original);
    return `
      <div class="cs-head"><h4>Cenas</h4>
        <div class="cs-head-btns"><button class="btn sm primary" data-act="new-scene" ${can ? '' : 'disabled'}>${icon('rec', 14)} Gravar nova cena</button>
        <button class="btn sm" data-act="upload-scene" ${can ? '' : 'disabled'} title="Um vídeo ou uma imagem do computador como nova cena (ocupa a tela toda)">${icon('download', 14)} Upload</button></div></div>
      <p class="cs-note">${can ? 'Grave uma nova cena ou envie um vídeo / imagem (ocupa a tela toda). Ela entra no fim da aula e pode ser arrastada para qualquer posição, aqui ou na faixa “Cenas”. Uma imagem fica 5 s: arraste o fim dela na faixa “Cenas” para mudar a duração.'
    : 'Novas cenas só podem ser adicionadas em aulas feitas por este app que ainda têm os arquivos originais.'}</p>
      <div class="cs-list" data-scenes>${c.scenes.map((sc, i) => {
    const s = c.sceneSpan(sc.id);
    return `<div class="cs-scene" draggable="true" data-scene="${sc.id}">
          <span class="cs-grip">${icon('grip', 14)}</span><span class="cs-num-badge">${i + 1}</span>
          ${sc.kind ? `<span class="cs-kind" title="${sc.kind === 'image' ? 'Imagem' : 'Vídeo enviado'}">${icon(sc.kind === 'image' ? 'image' : 'film', 13)}</span>` : ''}
          <input type="text" class="cs-input" data-rename-scene="${sc.id}" value="${esc(sc.name)}" maxlength="40" />
          <span class="cs-dim">${s ? fmtClock(s.o1 - s.o0) : 'cortada'}</span>
          <button class="cs-x" data-scene-up="${i}" ${i === 0 ? 'disabled' : ''} title="Mover para cima">↑</button>
          <button class="cs-x" data-scene-down="${i}" ${i === c.scenes.length - 1 ? 'disabled' : ''} title="Mover para baixo">↓</button>
          ${c.scenes.length > 1 ? `<button class="cs-x" data-scene-del="${sc.id}" title="Remover esta cena (Ctrl+Z desfaz)">${icon('trash', 12)}</button>` : ''}
        </div>`;
  }).join('')}</div>`;
  }

  // ---------------------------------------------------------------- filter thumbnails

  paintFxThumbs() {
    const v = this.c.active;
    const frame = document.createElement('canvas');
    frame.width = 112;
    frame.height = 64;
    const fctx = frame.getContext('2d');
    try {
      if (v && v.readyState >= 2) fctx.drawImage(v, 0, 0, 112, 64);
      else {
        // the player is seeking / loading: paint again as soon as there is a frame
        if (v && !this.thumbRetry) {
          this.thumbRetry = true;
          const again = () => {
            v.removeEventListener('seeked', again);
            v.removeEventListener('loadeddata', again);
            this.thumbRetry = false;
            if (this.tab === 'filtros' && v.readyState >= 2) this.paintFxThumbs();
          };
          v.addEventListener('seeked', again);
          v.addEventListener('loadeddata', again);
        }
        throw new Error('no frame');
      }
    } catch {
      const g = fctx.createLinearGradient(0, 0, 112, 64);
      g.addColorStop(0, '#f6a35a');
      g.addColorStop(0.5, '#5b8def');
      g.addColorStop(1, '#2c3e50');
      fctx.fillStyle = g;
      fctx.fillRect(0, 0, 112, 64);
    }
    const all = [{ id: 'none', p: {} }, ...FX_PRESETS, ...this.userFilters().map((u) => ({ id: `u-${u.id}`, p: u.p }))];
    for (const cv of $$('[data-fx-thumb]', this.body)) {
      const f = all.find((x) => x.id === cv.dataset.fxThumb);
      cv.getContext('2d').drawImage(frame, 0, 0);
      if (f && !isNeutral(f.p)) cv.style.filter = cssFilter(f.p, `fxthumb-${f.id}`, { blurScale: 64 / 1080 });
    }
  }

  // ---------------------------------------------------------------- actions

  addText(styleDef = TEXT_STYLES[0]) {
    const c = this.c;
    const st = { ...styleDef.style };
    c.addItem('ov', {
      kind: 'text', text: 'Seu texto aqui', style: st, x: 0.5, y: st.bg === 'box' && st.align === 'left' ? 0.82 : 0.5,
      rot: 0, opacity: 1, anim: { in: 'fade', out: 'fade', d: 0.35 },
    }, 3);
    this.focusText();
  }

  async addMedia() {
    const c = this.c;
    let m;
    try {
      m = await c.api.media.pick({ purpose: 'overlay', folder: c.p.folder || null });
    } catch (err) {
      c.toast(`Não foi possível usar esse arquivo. ${err.message || ''}`, 'error');
      return;
    }
    if (!m) return;
    const W = c.p.width || 1920;
    const H = c.p.height || 1080;
    // Starts at 40% of the frame width (a full-frame-friendly size for big images).
    const w = Math.min(0.4, (0.6 * H * (m.w / m.h)) / W);
    const dur = m.kind === 'video' && m.duration ? Math.min(m.duration, c.outDur - c.t) : 4;
    c.addItem('ov', {
      kind: m.kind, src: m, x: 0.5, y: 0.5, w, rot: 0, opacity: 1, radius: 0.03, border: 0, borderColor: '#ffffff', shadow: true,
      volume: 1, trim: 0, anim: { in: 'fade', out: 'fade', d: 0.3 },
    }, dur);
  }

  applyFx(id) {
    const c = this.c;
    const preset = id === 'none' ? { name: 'Original', p: {} }
      : id.startsWith('u-') ? this.userFilters().find((u) => `u-${u.id}` === id)
        : FX_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const value = { name: preset.name, p: { ...preset.p } };
    if (this.fxScope === 'camera') {
      c.onCameraFilter(id === 'none' ? null : value);
      c.toast(id === 'none' ? 'Câmera sem filtro.' : `Filtro “${value.name}” na câmera: vale para as próximas gravações.`, 'ok');
      this.render();
      return;
    }
    if (this.fxScope === 'global') {
      c.change(() => { c.fxGlobal = id === 'none' ? null : value; });
      c.selItem = id === 'none' ? null : { lane: 'fxg', id: 'global' };
      this.render();
      c.renderAll();
      return;
    }
    const sel = c.selItem && c.selItem.lane === 'fx' ? c.selected : null;
    if (sel) {
      if (id === 'none') { c.deleteItem(c.selItem); return; }
      c.change(() => { Object.assign(sel, value); });
      this.render();
      return;
    }
    if (id === 'none') return;
    c.addItem('fx', value, 5);
  }

  applyFormat(id) {
    const c = this.c;
    const f = this.formats().find((x) => x.id === id);
    if (!f) return;
    const scene = clone({ order: f.order, screen: f.screen, camera: f.camera });
    const lay = c.selItem && c.selItem.lane === 'layout' ? c.selected : null;
    if (lay) {
      c.change(() => { Object.assign(lay, { name: f.name, base: f.base, scene }); });
      this.render();
      return;
    }
    c.addItem('layout', { name: f.name, base: f.base, scene }, 5);
    this.render();
  }

  bind() {
    const c = this.c;
    this.root.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) this.setTab(tab.dataset.tab);
    });
    this.body.addEventListener('toggle', (e) => {
      const d = e.target.closest('details[data-sec]');
      if (!d) return;
      if (d.open) this.open_.add(d.dataset.sec); else this.open_.delete(d.dataset.sec);
    }, true);
    this.body.addEventListener('focusout', () => {
      setTimeout(() => { if (this.dirty && !this.busy()) this.render(); }, 0);
    });

    // Fields of the selected item / of the audio / of the speed.
    bindFields(this.body, {
      get: () => {
        if (this.tab === 'audio') return c.audioFx;
        if (this.tab === 'velocidade') return { speed: c.speed };
        return c.selected;
      },
      patch: (p, k) => {
        if (k === '__fmt') { this.audioFmt = p.__fmt; this.render(); return; }
        if (this.tab === 'audio') {
          c.beginEdit();
          Object.assign(c.audioFx, p);
          c.applyAudioFx();
          if (k === 'denoise' || k === 'gate') this.render();
          return;
        }
        if (this.tab === 'velocidade') {
          if (!Number.isFinite(p.speed) || p.speed <= 0) return;
          c.beginEdit();
          const ratio = c.outDur ? c.t / c.outDur : 0;
          c.speed = clamp(p.speed, 0.1, 16);
          c.buildSeq();
          c.layoutLanes();
          c.setPps(c.fitPps(), 0);
          c.seek(ratio * c.outDur);
          c.renderSummary();
          c.requestDraw();
          return;
        }
        const ref = c.selItem;
        if (!ref) return;
        if (p.style && Array.isArray(c.selected.style && c.selected.style.gradient) && p.style.gradient && !Array.isArray(p.style.gradient)) {
          p.style.gradient = [p.style.gradient[0], p.style.gradient[1]];
        }
        if (k === 'target' && p.target === 'camera') p.mode = 'fixed';
        if (k === 'target' && p.target !== 'all' && !c.canLayerZoom()) { c.toast('Zoom só na tela ou só na câmera precisa de uma gravação feita a partir desta versão.'); return; }
        c.updateItem(ref, p, { rebuild: true });
        if (['style.bg', 'style.stroke', 'style.border', 'style.glow', 'mode', 'border', 'target'].includes(k) || /^scene\.\w+\.(visible|shape|zoom|borderWidth)$/.test(k)) this.render(true);
      },
      commit: (fromClick) => {
        if (this.tab === 'audio' || this.tab === 'velocidade') {
          c.endEdit();
          if (this.tab === 'velocidade' && fromClick !== true) this.render(true);
          return;
        }
        c.endEdit();
        if (fromClick === true) this.render(true);
      },
    });

    // Timing fields (start / duration).
    this.body.addEventListener('change', (e) => {
      const el = e.target.closest('[data-k="__o0"], [data-k="__dur"]');
      const it = c.selected;
      if (!el || !it) return;
      const { o0, o1 } = c.span(it);
      const v = Number(el.value);
      if (!Number.isFinite(v)) return;
      c.beginEdit();
      if (el.dataset.k === '__o0') c.placeItem(it, v, o1 - o0);
      else c.placeItem(it, o0, v);
      c.endEdit();
      c.layoutLanes();
      c.seek(c.span(it).o0);
    });
    this.body.addEventListener('change', (e) => {
      const r = e.target.closest('[data-rename-scene]');
      if (r) c.renameScene(r.dataset.renameScene, r.value);
      if (e.target.matches('[data-act="gradient"]')) {
        const it = c.selected;
        if (!it) return;
        const s = mergeStyle(it.style);
        c.updateItem(c.selItem, { style: { ...it.style, gradient: e.target.checked ? [s.color.startsWith('#') ? s.color : '#ffffff', '#7b80ff'] : null } }, { commit: true });
        this.render(true);
      }
    });
    this.body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-rename-scene]')) e.target.blur();
      if (e.key === 'Enter' && e.target.id === 'cs-range-speed') $('[data-act="range-speed"]', this.body)?.click();
      e.stopPropagation();
    });

    this.body.addEventListener('click', async (e) => {
      const t = e.target;
      const act = t.closest('[data-act]')?.dataset.act;
      const styleBtn = t.closest('[data-style]');
      if (t.closest('[data-del-style]')) {
        const id = t.closest('[data-del-style]').dataset.delStyle;
        c.setPrefs({ userTextStyles: this.userStyles().filter((s) => s.id !== id) });
        this.render();
        return;
      }
      if (styleBtn) {
        const all = [...this.userStyles(), ...TEXT_STYLES];
        const def = all.find((s) => s.id === styleBtn.dataset.style);
        if (!def) return;
        const o = c.selected;
        if (o && o.kind === 'text') c.updateItem(c.selItem, { style: { ...BASE_STYLE, ...def.style } }, { commit: true });
        else this.addText(def);
        this.render();
        return;
      }
      if (t.closest('[data-del-fx]')) {
        e.stopPropagation();
        const id = t.closest('[data-del-fx]').dataset.delFx;
        c.setPrefs({ userFilters: this.userFilters().filter((f) => f.id !== id) });
        this.render();
        return;
      }
      const fxBtn = t.closest('[data-fx]');
      if (fxBtn) { this.applyFx(fxBtn.dataset.fx); return; }
      const scope = t.closest('[data-fx-scope]');
      if (scope) {
        this.fxScope = scope.dataset.fxScope;
        if (this.fxScope === 'global' && c.fxGlobal) c.selItem = { lane: 'fxg', id: 'global' };
        else if (this.fxScope !== 'range' && c.selItem && c.selItem.lane === 'fx') c.selItem = null;
        this.render();
        c.requestDraw();
        return;
      }
      const pos = t.closest('[data-pos]');
      if (pos && c.selected) {
        const [x, y] = pos.dataset.pos.split(',').map(Number);
        c.updateItem(c.selItem, { x, y }, { commit: true });
        this.render();
        return;
      }
      const zpos = t.closest('[data-zpos]');
      if (zpos && c.selected) {
        const [x, y] = zpos.dataset.zpos.split(',').map(Number);
        c.updateItem(c.selItem, { x, y }, { commit: true });
        return;
      }
      if (t.closest('[data-sticker-color]')) {
        this.stickerColor = t.closest('[data-sticker-color]').dataset.stickerColor;
        if (c.selected && c.selected.kind === 'sticker') c.updateItem(c.selItem, { color: this.stickerColor }, { commit: true });
        this.render();
        return;
      }
      const st = t.closest('[data-sticker]');
      if (st) {
        c.addItem('ov', { kind: 'sticker', sticker: st.dataset.sticker, color: this.stickerColor, x: 0.5, y: 0.5, w: 0.14, rot: 0, opacity: 1, shadow: true, anim: { in: 'fade', out: 'fade', d: 0.3 } }, 3);
        return;
      }
      const em = t.closest('[data-emoji]');
      if (em) {
        c.addItem('ov', { kind: 'emoji', emoji: em.dataset.emoji, x: 0.5, y: 0.5, w: 0.12, rot: 0, opacity: 1, anim: { in: 'fade', out: 'fade', d: 0.3 } }, 3);
        return;
      }
      const eq = t.closest('[data-eq]');
      if (eq) {
        c.change(() => Object.assign(c.audioFx, JSON.parse(eq.dataset.eq)));
        c.applyAudioFx();
        this.render();
        return;
      }
      const sp = t.closest('[data-speed]');
      if (sp) { c.setGlobalSpeed(Number(sp.dataset.speed)); return; }
      const rsp = t.closest('[data-range-speed]');
      if (rsp) { this.rangeSpeed = Number(rsp.dataset.rangeSpeed); if (c.sel) c.setRangeSpeed(c.sel.a, c.sel.b, this.rangeSpeed); return; }
      const ds = t.closest('[data-del-speed]');
      if (ds) { c.removeSpeedRange(Number(ds.dataset.delSpeed)); return; }
      const sk = t.closest('[data-seek]');
      if (sk && sk.dataset.seek !== '') { c.seek(Number(sk.dataset.seek)); return; }
      const fmt = t.closest('[data-format]');
      if (fmt) { this.applyFormat(fmt.dataset.format); return; }
      const pz = t.closest('[data-pick-zoom]');
      if (pz) {
        c.selectItem({ lane: 'zoom', id: pz.dataset.pickZoom });
        const z = c.selected;
        if (z) c.seek(c.span(z).o0 + 0.01);
        return;
      }
      const up = t.closest('[data-scene-up]');
      if (up) { const i = Number(up.dataset.sceneUp); c.moveScene(c.scenes[i].id, i - 1); return; }
      const down = t.closest('[data-scene-down]');
      if (down) { const i = Number(down.dataset.sceneDown); c.moveScene(c.scenes[i].id, i + 1); return; }
      const sdel = t.closest('[data-scene-del]');
      if (sdel) { c.removeScene(sdel.dataset.sceneDel); return; }
      const srow = t.closest('[data-scene]');
      if (srow && !t.closest('input, button')) {
        const s = c.sceneSpan(srow.dataset.scene);
        if (s) c.seek(s.o0);
        return;
      }

      switch (act) {
        case 'add-text': this.addText(); break;
        case 'add-media': this.addMedia(); break;
        case 'add-zoom': c.addZoom(t.closest('[data-act]').dataset.target || 'all'); break;
        case 'swap-order': {
          const it = c.selected;
          if (it && it.scene) {
            const o = it.scene.order || ['screen', 'camera'];
            c.updateItem(c.selItem, { scene: { ...it.scene, order: [o[1], o[0]] } }, { commit: true });
            this.render();
          }
          break;
        }
        case 'save-format': {
          const it = c.selected;
          const name = ($('#cs-format-name', this.body).value || '').trim().slice(0, 40);
          if (!it || !it.scene) break;
          if (!name) { c.toast('Dê um nome para o formato.'); $('#cs-format-name', this.body).focus(); break; }
          const f = c.addLayoutFormat(this.orientation(), { name, base: it.base, ...clone(it.scene) });
          if (f) {
            c.updateItem(c.selItem, { name: f.name }, { commit: true });
            c.toast(`Formato “${f.name}” cadastrado (também aparece no estúdio).`, 'ok');
          }
          this.render();
          break;
        }
        case 'upload-scene': c.uploadScene(); break;
        case 'dup': c.duplicateItem(); break;
        case 'del': c.deleteItem(); this.render(); break;
        case 'to-playhead': {
          const it = c.selected;
          if (it) { c.beginEdit(); c.placeItem(it, c.t, it.dur); c.endEdit(); c.layoutLanes(); }
          break;
        }
        case 'to-sel': {
          const it = c.selected;
          if (it && c.sel) { c.beginEdit(); c.placeItem(it, c.sel.a, c.sel.b - c.sel.a); c.endEdit(); c.layoutLanes(); }
          break;
        }
        case 'fonts': await this.loadFonts(); break;
        case 'save-style': {
          const o = c.selected;
          if (!o) break;
          const name = (o.text || 'Meu estilo').split('\n')[0].slice(0, 24) || 'Meu estilo';
          const list = [{ id: `u${Date.now().toString(36)}`, name, style: { ...mergeStyle(o.style) } }, ...this.userStyles()].slice(0, 60);
          c.setPrefs({ userTextStyles: list });
          c.toast(`Estilo “${name}” salvo em Meus estilos.`, 'ok');
          this.render();
          break;
        }
        case 'save-fx': {
          const f = c.selected;
          const name = ($('#cs-fx-name', this.body).value || '').trim().slice(0, 30);
          if (!f) break;
          if (!name) { c.toast('Dê um nome para o filtro.'); $('#cs-fx-name', this.body).focus(); break; }
          const list = this.userFilters();
          const same = list.find((u) => u.name.toLowerCase() === name.toLowerCase());
          const entry = { id: same ? same.id : `f${Date.now().toString(36)}`, name, p: { ...f.p } };
          c.setPrefs({ userFilters: same ? list.map((u) => (u.id === same.id ? entry : u)) : [entry, ...list].slice(0, 60) });
          c.updateItem(c.selItem, { name }, { commit: true });
          c.toast(same ? `Filtro “${name}” atualizado.` : `Filtro “${name}” salvo em Meus filtros.`, 'ok');
          this.render();
          break;
        }
        case 'reset-fx': c.updateItem(c.selItem, { p: {} }, { commit: true }); this.render(); break;
        case 'cam-off': c.onCameraFilter(null); this.render(); break;
        case 'range-speed': {
          const v = Number($('#cs-range-speed', this.body).value);
          if (c.sel && Number.isFinite(v) && v > 0) { this.rangeSpeed = v; c.setRangeSpeed(c.sel.a, c.sel.b, v); }
          break;
        }
        case 'new-scene': c.newScene(); break;
        case 'audio-preview': await this.previewAudio(); break;
        case 'audio-export': c.onExportAudio(this.audioFmt || 'mp3'); break;
        default: break;
      }
    });

    // Scene rows: drag to reorder.
    this.body.addEventListener('dragstart', (e) => {
      const row = e.target.closest('[data-scene]');
      if (!row) return;
      this.dragScene = row.dataset.scene;
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    this.body.addEventListener('dragover', (e) => {
      const row = e.target.closest('[data-scene]');
      if (!row || !this.dragScene) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      $$('.cs-scene', this.body).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    this.body.addEventListener('drop', (e) => {
      const row = e.target.closest('[data-scene]');
      if (!row || !this.dragScene) return;
      e.preventDefault();
      const ids = c.scenes.map((s) => s.id);
      let to = ids.indexOf(row.dataset.scene);
      if (row.classList.contains('drop-after')) to += 1;
      const from = ids.indexOf(this.dragScene);
      if (to > from) to -= 1;
      this.dragScene = null;
      if (to !== from) c.moveScene(ids[from], to);
      else this.render();
    });
    this.body.addEventListener('dragend', () => {
      this.dragScene = null;
      $$('.cs-scene', this.body).forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
    });
  }

  async loadFonts() {
    if (!window.queryLocalFonts) {
      this.c.toast('Este computador não permite listar as fontes instaladas.', 'error');
      return;
    }
    try {
      const fonts = await window.queryLocalFonts();
      const names = [...new Set(fonts.map((f) => f.family))].filter((n) => !FONT_LIST.some(([x]) => x === n)).sort((a, b) => a.localeCompare(b));
      this.localFonts = names;
      this.c.toast(`${names.length} fontes instaladas disponíveis na lista.`, 'ok');
      this.render(true);
    } catch {
      this.c.toast('Não foi possível ler as fontes instaladas.', 'error');
    }
  }

  async previewAudio() {
    const c = this.c;
    const btn = $('[data-act="audio-preview"]', this.body);
    const D = 10;
    const a = clamp(c.t, 0, Math.max(0, c.outDur - 1));
    const b = Math.min(c.outDur, a + D);
    // The pieces of the timeline between a and b.
    const seq = [];
    for (const it of c.seq) {
      if (it.t !== 's' || it.o1 <= a || it.o0 >= b) continue;
      const s0 = it.a + (Math.max(a, it.o0) - it.o0) * it.sp;
      const s1 = it.a + (Math.min(b, it.o1) - it.o0) * it.sp;
      if (s1 - s0 > 0.05) seq.push({ t: 's', a: s0, b: s1, sp: it.sp });
    }
    if (!seq.length) { c.toast('Leve a agulha para um trecho com áudio.'); return; }
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner sm"></span> Preparando…`;
    try {
      const job = await c.audioJob({
        source: c.p.path, duration: c.duration, fps: c.fps, stereo: c.p.stereo, hasAudio: c.p.hasAudio !== false,
        level: c.getPrefs().levelAudio, sidecars: c.p.sidecars || null, transition: null,
      });
      job.seq = seq;
      job.post = { overlays: (job.post.overlays || []).filter((o) => o.o1 > a && o.o0 < b).map((o) => ({ ...o, o0: Math.max(0, o.o0 - a), o1: o.o1 - a, video: { ...o.video, trim: o.video.trim + Math.max(0, a - o.o0) } })) };
      const url = await c.api.exporter.audioPreview(job);
      const el = $('#cs-audio-prev', this.body);
      if (el) {
        el.hidden = false;
        el.src = `${url}?v=${Date.now()}`;
        c.pause();
        el.play().catch(() => {});
      }
    } catch (err) {
      c.toast(`Não consegui gerar a prévia. ${String(err.message || '').slice(0, 200)}`, 'error', 8000);
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.innerHTML = `${icon('headphones', 14)} Ouvir prévia (10 s)`;
      }
    }
  }
}
