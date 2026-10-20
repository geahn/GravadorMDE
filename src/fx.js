// Color filters. One model drives both the live/preview look (an SVG filter
// referenced from CSS or a canvas) and the export (FFmpeg lutrgb +
// colorchannelmixer + extras), so what you see is what you export.
//
// A filter is a plain object of numbers; missing keys are neutral (0).

export const FX_KEYS = [
  { key: 'brightness', label: 'Brilho', min: -100, max: 100 },
  { key: 'contrast', label: 'Contraste', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturação', min: -100, max: 100 },
  { key: 'hue', label: 'Matiz', min: -180, max: 180, unit: '°' },
  { key: 'temperature', label: 'Temperatura', min: -100, max: 100 },
  { key: 'tint', label: 'Tonalidade', min: -100, max: 100 },
  { key: 'sepia', label: 'Sépia', min: 0, max: 100 },
  { key: 'fade', label: 'Desbotar', min: 0, max: 100 },
  { key: 'vignette', label: 'Vinheta', min: 0, max: 100 },
  { key: 'sharpen', label: 'Nitidez', min: 0, max: 100 },
  { key: 'blur', label: 'Desfoque', min: 0, max: 30 },
  { key: 'grain', label: 'Granulado', min: 0, max: 100 },
];

// The standard collection (always available; user filters are saved apart).
export const FX_PRESETS = [
  { id: 'vivido', name: 'Vívido', p: { contrast: 12, saturation: 35, sharpen: 20 } },
  { id: 'quente', name: 'Quente', p: { temperature: 45, saturation: 8, brightness: 3 } },
  { id: 'frio', name: 'Frio', p: { temperature: -45, tint: -5, contrast: 6 } },
  { id: 'pb', name: 'P&B', p: { saturation: -100, contrast: 15 } },
  { id: 'noir', name: 'Noir', p: { saturation: -100, contrast: 45, brightness: -6, vignette: 55, grain: 18 } },
  { id: 'sepia', name: 'Sépia', p: { sepia: 85, contrast: 5, vignette: 25 } },
  { id: 'vintage', name: 'Vintage', p: { sepia: 35, fade: 35, contrast: -10, saturation: -15, vignette: 35, grain: 25 } },
  { id: 'cinema', name: 'Cinema', p: { contrast: 22, saturation: -12, temperature: -12, tint: 6, vignette: 30 } },
  { id: 'drama', name: 'Drama', p: { contrast: 40, saturation: -20, brightness: -5, vignette: 40, sharpen: 25 } },
  { id: 'suave', name: 'Suave', p: { contrast: -18, brightness: 6, fade: 20, saturation: -5 } },
  { id: 'pastel', name: 'Pastel', p: { saturation: -30, brightness: 10, fade: 30, tint: 8 } },
  { id: 'desbotado', name: 'Desbotado', p: { fade: 55, saturation: -35, contrast: -15 } },
  { id: 'nitido', name: 'Nítido', p: { sharpen: 70, contrast: 10 } },
  { id: 'claro', name: 'Clarear', p: { brightness: 18, contrast: 4 } },
  { id: 'escuro', name: 'Escurecer', p: { brightness: -18, contrast: 8 } },
  { id: 'verao', name: 'Verão', p: { temperature: 30, saturation: 25, brightness: 6, tint: 8 } },
  { id: 'oceano', name: 'Oceano', p: { temperature: -35, hue: -8, saturation: 15 } },
  { id: 'neon', name: 'Neon', p: { saturation: 70, contrast: 25, hue: 12, tint: 15 } },
  { id: 'sonho', name: 'Sonho', p: { blur: 2, brightness: 10, fade: 25, saturation: 10 } },
  { id: 'foco', name: 'Foco central', p: { vignette: 75, contrast: 8 } },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (p, k) => (p && Number.isFinite(Number(p[k])) ? Number(p[k]) : 0);

export function isNeutral(p) {
  return !p || FX_KEYS.every(({ key }) => !num(p, key));
}

// ---------------------------------------------------------------- math

function mul(a, b) {
  const o = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o;
}

// Linear part (per channel): v' = v * slope + intercept (in 0..1 units).
export function linearOf(p) {
  const C = 1 + (num(p, 'contrast') / 100) * 0.8;
  const B = (num(p, 'brightness') / 100) * 0.25;
  const k = (num(p, 'fade') / 100) * 0.22;
  return { slope: C * (1 - k), intercept: (0.5 - 0.5 * C + B) * (1 - k) + k };
}

// 3x3 color matrix (row major, applied to [r,g,b] column): hue -> saturation -> sepia -> temperature/tint.
export function matrixOf(p) {
  const h = (num(p, 'hue') * Math.PI) / 180;
  const cos = Math.cos(h);
  const sin = Math.sin(h);
  const hue = [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
  const s = clamp(1 + num(p, 'saturation') / 100, 0, 2.5);
  const sat = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  const q = clamp(num(p, 'sepia') / 100, 0, 1);
  const S = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
  const sep = S.map((v, i) => (1 - q) * ([0, 4, 8].includes(i) ? 1 : 0) + q * v);
  const k = (num(p, 'temperature') / 100) * 0.16;
  const m = (num(p, 'tint') / 100) * 0.12;
  const temp = [1 + k, 0, 0, 0, 1 - m, 0, 0, 0, 1 - k];
  return mul(temp, mul(sep, mul(sat, hue)));
}

const r4 = (v) => Number(v.toFixed(4));

// ---------------------------------------------------------------- preview (SVG filter)

// Returns the inner markup of an <svg><filter> that reproduces the color part.
export function svgFilterBody(p) {
  const { slope, intercept } = linearOf(p);
  const M = matrixOf(p);
  const row = (r) => `${r4(M[r * 3])} ${r4(M[r * 3 + 1])} ${r4(M[r * 3 + 2])} 0 0`;
  let body = `<feComponentTransfer><feFuncR type="linear" slope="${r4(slope)}" intercept="${r4(intercept)}"/><feFuncG type="linear" slope="${r4(slope)}" intercept="${r4(intercept)}"/><feFuncB type="linear" slope="${r4(slope)}" intercept="${r4(intercept)}"/></feComponentTransfer>`;
  body += `<feColorMatrix type="matrix" values="${row(0)} ${row(1)} ${row(2)} 0 0 0 1 0"/>`;
  const sh = num(p, 'sharpen') / 100;
  if (sh > 0.01) {
    const a = r4(sh * 0.6);
    body += `<feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 ${-a} 0 ${-a} ${r4(1 + 4 * a)} ${-a} 0 ${-a} 0"/>`;
  }
  return body;
}

// Keeps one <svg> with named filters in the document; returns a CSS filter value.
const defs = new Map();
let svgRoot = null;
export function cssFilter(p, id, { blurScale = 1 } = {}) {
  if (isNeutral(p)) return 'none';
  if (typeof document !== 'undefined') {
    if (!svgRoot) {
      svgRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgRoot.setAttribute('width', '0');
      svgRoot.setAttribute('height', '0');
      svgRoot.style.position = 'absolute';
      svgRoot.style.pointerEvents = 'none';
      document.body.appendChild(svgRoot);
    }
    const body = svgFilterBody(p);
    if (defs.get(id) !== body) {
      defs.set(id, body);
      let f = svgRoot.querySelector(`#${CSS.escape(id)}`);
      if (!f) {
        f = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        f.setAttribute('id', id);
        f.setAttribute('color-interpolation-filters', 'sRGB');
        f.setAttribute('x', '0');
        f.setAttribute('y', '0');
        f.setAttribute('width', '1');
        f.setAttribute('height', '1');
        svgRoot.appendChild(f);
      }
      f.innerHTML = body;
    }
  }
  const blur = num(p, 'blur');
  return `url(#${id})${blur > 0 ? ` blur(${r4(blur * blurScale)}px)` : ''}`;
}

// Vignette overlay for previews (CSS background).
export function vignetteCss(p) {
  const v = num(p, 'vignette') / 100;
  if (v <= 0.01) return 'none';
  return `radial-gradient(ellipse at center, rgba(0,0,0,0) ${Math.round(62 - v * 32)}%, rgba(0,0,0,${r4(0.25 + v * 0.6)}) 100%)`;
}

// ---------------------------------------------------------------- export (FFmpeg)

// FFmpeg filter list for a filter, optionally only between a and b (seconds of the output).
export function ffmpegChain(p, { H = 1080, a = null, b = null } = {}) {
  if (isNeutral(p)) return [];
  const en = a != null ? `:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'` : '';
  const out = [];
  const { slope, intercept } = linearOf(p);
  if (Math.abs(slope - 1) > 1e-4 || Math.abs(intercept) > 1e-4) {
    const e = `clip(val*${r4(slope)}+${r4(intercept)}*maxval,minval,maxval)`;
    out.push(`lutrgb=r='${e}':g='${e}':b='${e}'${en}`);
  }
  const M = matrixOf(p);
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (M.some((v, i) => Math.abs(v - I[i]) > 1e-4)) {
    const n = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
    out.push(`colorchannelmixer=${n.map((k, i) => `${k}=${r4(M[i])}`).join(':')}${en}`);
  }
  const sh = num(p, 'sharpen') / 100;
  if (sh > 0.01) out.push(`unsharp=5:5:${r4(sh * 1.4)}:5:5:0${en}`);
  const blur = num(p, 'blur');
  if (blur > 0) out.push(`gblur=sigma=${r4(blur * (H / 1080))}${en}`);
  const v = num(p, 'vignette') / 100;
  if (v > 0.01) out.push(`vignette=angle=${r4(0.2 + v * 0.75)}${en}`);
  const g = num(p, 'grain') / 100;
  if (g > 0.01) out.push(`noise=alls=${Math.round(g * 28)}:allf=t+u${en}`);
  return out;
}
