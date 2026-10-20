// Text styles, stickers and the one renderer used everywhere an overlay is
// drawn: the editor preview, the live studio canvas and the export (each text,
// sticker and image becomes a PNG with exactly the same pixels).
//
// Overlay item (fractions of the frame unless noted):
//   { id, kind: 'text'|'image'|'video'|'sticker'|'emoji', at, dur,
//     x, y (center), w (width for media/sticker/emoji), scale (text), rot (deg), opacity,
//     anim: { in, out, d }, text, style, src, sticker, color, emoji, radius, border, borderColor, shadow, volume, trim }

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------- fonts

const SANS = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const BLACK = '"Segoe UI Black", "Arial Black", sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const PALATINO = '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif';
const TIMES = '"Times New Roman", Times, serif';
const SCRIPT = '"Segoe Script", "Brush Script MT", cursive';
const INK = '"Ink Free", "Segoe Print", "Comic Sans MS", cursive';
const PRINT = '"Segoe Print", "Comic Sans MS", cursive';
const MONO = '"Cascadia Code", Consolas, "Courier New", monospace';
const IMPACT = 'Impact, "Arial Black", sans-serif';
const BAHN = 'Bahnschrift, "Arial Narrow", sans-serif';
const FRANKLIN = '"Franklin Gothic Heavy", "Franklin Gothic Medium", "Arial Black", sans-serif';
const COMIC = '"Comic Sans MS", "Segoe Print", cursive';

// Fonts offered in the editor (Windows 10/11 ships all of these).
export const FONT_LIST = [
  ['Segoe UI', SANS], ['Segoe UI Black', BLACK], ['Arial', 'Arial, sans-serif'], ['Arial Black', '"Arial Black", sans-serif'],
  ['Bahnschrift', BAHN], ['Calibri', 'Calibri, sans-serif'], ['Candara', 'Candara, sans-serif'], ['Corbel', 'Corbel, sans-serif'],
  ['Franklin Gothic', FRANKLIN], ['Trebuchet MS', '"Trebuchet MS", sans-serif'], ['Verdana', 'Verdana, sans-serif'], ['Tahoma', 'Tahoma, sans-serif'],
  ['Impact', IMPACT], ['Georgia', SERIF], ['Cambria', 'Cambria, Georgia, serif'], ['Constantia', 'Constantia, Georgia, serif'],
  ['Palatino', PALATINO], ['Times New Roman', TIMES], ['Sitka', 'Sitka, Georgia, serif'], ['Gabriola', 'Gabriola, serif'],
  ['Segoe Script', SCRIPT], ['Segoe Print', PRINT], ['Ink Free', INK], ['Comic Sans MS', COMIC],
  ['Cascadia Code', MONO], ['Consolas', 'Consolas, monospace'], ['Lucida Console', '"Lucida Console", monospace'],
];

export function fontStack(name) {
  const hit = FONT_LIST.find(([n]) => n === name);
  if (hit) return hit[1];
  return `"${String(name).replace(/"/g, '')}", ${SANS}`; // an installed font picked by the user
}

// ---------------------------------------------------------------- styles

export const BASE_STYLE = {
  font: 'Segoe UI', size: 64, weight: 700, italic: false, underline: false, upper: false,
  color: '#ffffff', gradient: null, align: 'center', letter: 0, line: 1.15, stretch: 'normal',
  bg: 'none', bgColor: '#000000', bgOpacity: 1, padX: 0.45, padY: 0.22, radius: 0.25,
  border: 0, borderColor: '#ffffff', stroke: 0, strokeColor: '#000000',
  shadow: 0, shadowColor: 'rgba(0,0,0,0.6)', shadowX: 0, shadowY: 0.06,
  glow: 0, glowColor: '#ff4fd8', rot: 0,
};

const S = (id, name, s) => ({ id, name, style: { ...BASE_STYLE, ...s } });
const pill = { bg: 'box', radius: 9, padX: 0.6, padY: 0.25 };

export const TEXT_STYLES = [
  S('titulo', 'Título', { size: 84, weight: 900, shadow: 0.25, shadowY: 0.05 }),
  S('legenda', 'Legenda', { size: 40, weight: 600, bg: 'box', bgOpacity: 0.78, radius: 0.15 }),
  S('etiqueta', 'Etiqueta', { size: 36, color: '#1f1600', bg: 'box', bgColor: '#ffd43b', ...pill }),
  S('destaque', 'Destaque', { size: 44, weight: 800, bg: 'box', bgColor: '#5b5bf6', radius: 0.14 }),
  S('serifa', 'Serifa', { font: 'Georgia', size: 64, weight: 400 }),
  S('manuscrito', 'Manuscrito', { font: 'Segoe Script', size: 58, weight: 700 }),
  S('manchete', 'Manchete', { font: 'Franklin Gothic', size: 76, weight: 900, shadow: 0.2 }),
  S('subtitulo', 'Subtítulo', { size: 40, weight: 600, bg: 'box', bgColor: '#0b0c10', radius: 0.12 }),
  S('citacao', 'Citação', { font: 'Georgia', size: 56, weight: 400, italic: true, color: '#f3e6c4' }),
  S('codigo', 'Código', { font: 'Cascadia Code', size: 40, weight: 600, color: '#3ddc97', bg: 'box', bgColor: '#07090c', radius: 0.08 }),
  S('pilula', 'Pílula', { size: 40, color: '#0c0d11', bg: 'box', bgColor: '#ffffff', ...pill }),
  S('alerta', 'Alerta', { size: 40, bg: 'box', bgColor: '#e5383b', radius: 0.2 }),
  S('tag', 'Tag', { size: 38, weight: 600, color: '#0f5132', bg: 'box', bgColor: '#b7f5d0', ...pill }),
  S('postit', 'Post-it', { font: 'Segoe Print', size: 44, color: '#3b2f00', bg: 'box', bgColor: '#ffe066', radius: 0.04, padX: 0.6, padY: 0.4, shadow: 0.3, shadowY: 0.12, rot: -2 }),
  S('neon', 'Neon', { size: 66, weight: 800, color: '#ffd6f3', glow: 0.35, glowColor: '#ff4fd8' }),
  S('carimbo', 'Carimbo', { size: 56, weight: 900, upper: true, letter: 0.08, color: '#ff4040', border: 0.07, borderColor: '#ff4040', radius: 0.12, padX: 0.4, padY: 0.12, rot: -6 }),
  S('elegante', 'Elegante', { font: 'Palatino', size: 64, weight: 400, letter: 0.03 }),
  S('balao', 'Balão', { size: 40, weight: 600, color: '#0b3b5c', bg: 'box', bgColor: '#bfe6ff', ...pill }),
  S('negrito', 'Negrito', { size: 48, weight: 900, bg: 'box', bgColor: '#000000', radius: 0.1 }),
  S('faixa', 'Faixa', { size: 44, weight: 800, bg: 'box', bgColor: '#2563eb', radius: 0, padX: 0.8 }),
  S('menta', 'Menta', { size: 38, weight: 600, color: '#0a4d3a', bg: 'box', bgColor: '#a7f3d0', ...pill }),
  S('lavanda', 'Lavanda', { size: 38, weight: 600, color: '#3b1f7a', bg: 'box', bgColor: '#ddd6fe', ...pill }),
  S('pessego', 'Pêssego', { size: 38, weight: 600, color: '#7a2e0b', bg: 'box', bgColor: '#fed7aa', ...pill }),
  S('rosa', 'Rosa', { size: 38, weight: 600, color: '#7a0b2e', bg: 'box', bgColor: '#fecdd3', radius: 0.2 }),
  S('ardosia', 'Ardósia', { size: 38, weight: 600, color: '#e2e8f0', bg: 'box', bgColor: '#334155', ...pill }),
  S('sucesso', 'Sucesso', { size: 40, bg: 'box', bgColor: '#16a34a', ...pill }),
  S('aviso', 'Aviso', { size: 40, color: '#1f1300', bg: 'box', bgColor: '#f5b301', ...pill }),
  S('vidro', 'Vidro', { size: 40, weight: 600, bg: 'box', bgColor: '#ffffff', bgOpacity: 0.22, border: 0.025, borderColor: 'rgba(255,255,255,0.45)', ...pill }),
  S('tinta', 'Tinta', { size: 44, weight: 800, bg: 'box', bgColor: '#111111', radius: 0 }),
  S('editorial', 'Editorial', { font: 'Georgia', size: 60, weight: 700 }),
  S('classico', 'Clássico', { font: 'Times New Roman', size: 52, weight: 700, color: '#111111', bg: 'box', bgColor: '#ffffff', radius: 0 }),
  S('nota', 'Nota', { font: 'Segoe Print', size: 40, color: '#4a3b00', bg: 'box', bgColor: '#fff3a0', radius: 0.03, rot: 1.5, shadow: 0.25, shadowY: 0.1 }),
  S('marcador', 'Marcador', { font: 'Ink Free', size: 58, weight: 700, color: '#ffd400', italic: true }),
  S('condensado', 'Condensado', { font: 'Bahnschrift', size: 62, weight: 700, stretch: 'condensed' }),
  S('largo', 'Largo', { font: 'Arial Black', size: 46, weight: 900, upper: true, letter: 0.18 }),
  S('impacto', 'Impacto', { font: 'Impact', size: 72, weight: 400, color: '#ffd400', stroke: 0.08, strokeColor: '#000000' }),
  S('fino', 'Fino', { size: 64, weight: 200, color: '#d8dbe2' }),
  S('leve', 'Leve', { size: 60, weight: 300 }),
  S('terminal', 'Terminal', { font: 'Consolas', size: 40, weight: 600, color: '#111111', bg: 'box', bgColor: '#f4f4f4', radius: 0.14, border: 0.03, borderColor: '#111111' }),
  S('contorno', 'Contorno', { size: 74, weight: 900, color: 'rgba(0,0,0,0)', stroke: 0.045, strokeColor: '#ffffff' }),
  S('gradiente', 'Gradiente', { size: 74, weight: 900, gradient: ['#9ea2ff', '#ff4fd8'] }),
  S('pordosol', 'Pôr do sol', { size: 72, weight: 900, gradient: ['#ffd36e', '#ff3b55'] }),
  S('oceano', 'Oceano', { size: 72, weight: 900, gradient: ['#67e8f9', '#3b82f6'] }),
  S('sombra', 'Sombra', { size: 74, weight: 900, shadow: 0.02, shadowColor: 'rgba(0,0,0,0.85)', shadowX: 0.06, shadowY: 0.06 }),
  S('meme', 'Meme', { font: 'Impact', size: 76, weight: 400, upper: true, stroke: 0.11, strokeColor: '#000000' }),
  S('tercoinf', 'Terço inferior', { size: 40, weight: 700, bg: 'box', bgColor: '#7b80ff', radius: 0, padX: 1, padY: 0.35, align: 'left' }),
  S('marcatexto', 'Marca-texto', { size: 48, weight: 800, color: '#111111', bg: 'lines', bgColor: '#ffe066', radius: 0.1, padX: 0.25, padY: 0.08 }),
  S('cinema', 'Cinema', { size: 44, weight: 500, shadow: 0.35, shadowY: 0.05, shadowColor: 'rgba(0,0,0,0.95)' }),
  S('brilhoazul', 'Brilho azul', { size: 64, weight: 800, color: '#dff7ff', glow: 0.35, glowColor: '#3bc8ff' }),
  S('retro', 'Retrô', { size: 66, weight: 900, color: '#ffd166', stroke: 0.07, strokeColor: '#ef476f', shadow: 0.01, shadowColor: '#26547c', shadowX: 0.07, shadowY: 0.07 }),
  S('minimal', 'Minimal', { size: 34, weight: 500, upper: true, letter: 0.32 }),
  S('divertido', 'Divertido', { font: 'Comic Sans MS', size: 58, weight: 700, color: '#ff6b6b', stroke: 0.09, strokeColor: '#ffffff' }),
  S('giz', 'Giz', { font: 'Segoe Print', size: 54, weight: 400, color: 'rgba(248,248,242,0.92)' }),
  S('vidroescuro', 'Vidro escuro', { size: 40, weight: 600, bg: 'box', bgColor: '#000000', bgOpacity: 0.45, border: 0.025, borderColor: 'rgba(255,255,255,0.2)', ...pill }),
];

export const mergeStyle = (s) => ({ ...BASE_STYLE, ...(s || {}) });

// ---------------------------------------------------------------- stickers

const STICKER_SVG = {
  'seta-direita': '<path d="M8 40h52V22l32 28-32 28V60H8z" fill="C" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>',
  'seta-esquerda': '<path d="M92 40H40V22L8 50l32 28V60h52z" fill="C" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>',
  'seta-cima': '<path d="M40 92V40H22L50 8l28 32H60v52z" fill="C" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>',
  'seta-baixo': '<path d="M40 8v52H22l28 32 28-32H60V8z" fill="C" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>',
  'seta-curva': '<path d="M14 80C20 40 46 22 74 26" fill="none" stroke="C" stroke-width="9" stroke-linecap="round"/><path d="M62 10l24 16-22 18z" fill="C"/>',
  circulo: '<ellipse cx="50" cy="50" rx="42" ry="36" fill="none" stroke="C" stroke-width="7"/>',
  retangulo: '<rect x="8" y="18" width="84" height="64" rx="10" fill="none" stroke="C" stroke-width="7"/>',
  sublinhado: '<path d="M6 58c18-8 30 6 46-2s28-8 42 0" fill="none" stroke="C" stroke-width="9" stroke-linecap="round"/>',
  check: '<circle cx="50" cy="50" r="44" fill="C"/><path d="M28 51l15 15 30-32" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>',
  x: '<circle cx="50" cy="50" r="44" fill="C"/><path d="M33 33l34 34M67 33L33 67" stroke="#fff" stroke-width="10" stroke-linecap="round"/>',
  estrela: '<path d="M50 6l13 28 30 3-23 20 7 30-27-16-27 16 7-30L7 37l30-3z" fill="C" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>',
  coracao: '<path d="M50 88S8 62 8 34a20 20 0 0 1 42-8 20 20 0 0 1 42 8c0 28-42 54-42 54z" fill="C" stroke="#fff" stroke-width="3"/>',
  exclamacao: '<circle cx="50" cy="50" r="44" fill="C"/><path d="M50 24v34" stroke="#fff" stroke-width="11" stroke-linecap="round"/><circle cx="50" cy="74" r="6.5" fill="#fff"/>',
  interrogacao: '<circle cx="50" cy="50" r="44" fill="C"/><path d="M37 38a13 13 0 1 1 18 12c-4 2-5 5-5 9v3" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round"/><circle cx="50" cy="76" r="6.5" fill="#fff"/>',
  raio: '<path d="M58 4L18 56h28l-6 40 42-56H54z" fill="C" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>',
  lampada: '<path d="M50 8a30 30 0 0 0-18 54c4 3 6 8 6 12h24c0-4 2-9 6-12A30 30 0 0 0 50 8z" fill="C" stroke="#fff" stroke-width="3"/><rect x="38" y="78" width="24" height="7" rx="3" fill="C"/><rect x="41" y="88" width="18" height="6" rx="3" fill="C"/>',
  balao: '<path d="M14 14h72a8 8 0 0 1 8 8v42a8 8 0 0 1-8 8H42L22 90V72h-8a8 8 0 0 1-8-8V22a8 8 0 0 1 8-8z" fill="C" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>',
  clique: '<circle cx="40" cy="40" r="20" fill="none" stroke="C" stroke-width="5" opacity=".55"/><circle cx="40" cy="40" r="34" fill="none" stroke="C" stroke-width="4" opacity=".3"/><path d="M40 40l46 16-20 6 16 18-8 7-16-18-6 20z" fill="#fff" stroke="#111" stroke-width="3" stroke-linejoin="round"/>',
  mira: '<circle cx="50" cy="50" r="40" fill="none" stroke="C" stroke-width="6"/><circle cx="50" cy="50" r="22" fill="none" stroke="C" stroke-width="6"/><circle cx="50" cy="50" r="7" fill="C"/>',
  novo: '<path d="M50 4l10 14 17-5 2 17 17 5-8 15 8 15-17 5-2 17-17-5-10 14-10-14-17 5-2-17-17-5 8-15-8-15 17-5 2-17 17 5z" fill="C"/><text x="50" y="58" text-anchor="middle" font-family="Segoe UI Black, Arial Black, sans-serif" font-size="22" font-weight="900" fill="#fff">NOVO</text>',
  play: '<circle cx="50" cy="50" r="44" fill="C"/><path d="M40 30v40l32-20z" fill="#fff"/>',
  pin: '<path d="M50 94S18 58 18 38a32 32 0 0 1 64 0c0 20-32 56-32 56z" fill="C" stroke="#fff" stroke-width="3"/><circle cx="50" cy="38" r="12" fill="#fff"/>',
};

export const STICKERS = Object.keys(STICKER_SVG).map((id) => ({
  id,
  name: {
    'seta-direita': 'Seta →', 'seta-esquerda': 'Seta ←', 'seta-cima': 'Seta ↑', 'seta-baixo': 'Seta ↓', 'seta-curva': 'Seta curva',
    circulo: 'Círculo', retangulo: 'Moldura', sublinhado: 'Sublinhado', check: 'Certo', x: 'Errado', estrela: 'Estrela',
    coracao: 'Coração', exclamacao: 'Atenção', interrogacao: 'Dúvida', raio: 'Raio', lampada: 'Ideia', balao: 'Balão',
    clique: 'Clique', mira: 'Alvo', novo: 'Novo', play: 'Play', pin: 'Local',
  }[id] || id,
}));

export const EMOJIS = ['🔥', '👍', '👏', '🎉', '✅', '❌', '⚠️', '💡', '🚀', '⭐', '❤️', '😂', '😮', '🤔', '👀', '📌', '🎯', '💯', '👉', '👈', '👆', '👇', '🙌', '💥', '✨', '📣', '🧠', '⏱️', '🔔', '📚'];

export function stickerSvg(id, color = '#ff3b55') {
  const body = (STICKER_SVG[id] || STICKER_SVG.circulo).replace(/="C"/g, `="${color}"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="400" height="400">${body}</svg>`;
}

export const stickerUrl = (id, color) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(stickerSvg(id, color))}`;

// ---------------------------------------------------------------- text layout + drawing

function withAlpha(color, a) {
  if (a >= 0.999) return color;
  const m = /^#([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Font size in px for a frame of W x H (styles are sized for a 1080 short side).
export function fontPx(item, W, H) {
  const s = mergeStyle(item.style);
  return s.size * (Math.min(W, H) / 1080) * (item.scale || 1);
}

function setFont(ctx, s, px) {
  ctx.font = `${s.italic ? 'italic ' : ''}${s.weight} ${px}px ${fontStack(s.font)}`;
  try { ctx.fontStretch = s.stretch || 'normal'; } catch { /* older engines */ }
  try { ctx.letterSpacing = `${(s.letter || 0) * px}px`; } catch { /* older engines */ }
  ctx.textBaseline = 'alphabetic';
}

let measureCtx = null;
function mctx() {
  if (!measureCtx) measureCtx = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas')).getContext('2d');
  return measureCtx;
}

// Box of a text item in px (before rotation).
export function layoutText(item, W, H, ctx = mctx()) {
  const s = mergeStyle(item.style);
  const px = fontPx(item, W, H);
  setFont(ctx, s, px);
  const raw = String(item.text ?? '').replace(/\r/g, '');
  const lines = (s.upper ? raw.toUpperCase() : raw).split('\n');
  const widths = lines.map((l) => ctx.measureText(l || ' ').width - (s.letter || 0) * px);
  const m = ctx.measureText('Hg');
  const asc = m.actualBoundingBoxAscent || px * 0.78;
  const desc = m.actualBoundingBoxDescent || px * 0.22;
  const lineH = px * s.line;
  const textW = Math.max(px * 0.3, ...widths);
  const textH = lineH * (lines.length - 1) + asc + desc;
  const padX = s.bg === 'box' || s.border > 0 ? s.padX * px : 0;
  const padY = s.bg === 'box' || s.border > 0 ? s.padY * px : 0;
  return { s, px, lines, widths, asc, desc, lineH, textW, textH, padX, padY, w: textW + padX * 2, h: textH + padY * 2 };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

// Draws a text item centered at (0,0) of the current transform.
export function drawTextBox(ctx, item, W, H) {
  const L = layoutText(item, W, H, ctx);
  const { s, px, lines, widths, asc, lineH, w, h, padX, padY } = L;
  const x0 = -w / 2;
  const y0 = -h / 2;
  const r = s.radius * px;
  // background
  if (s.bg === 'box' || s.border > 0) {
    ctx.save();
    if (s.shadow > 0 && s.bg === 'box') {
      ctx.shadowColor = s.shadowColor;
      ctx.shadowBlur = s.shadow * px;
      ctx.shadowOffsetX = s.shadowX * px;
      ctx.shadowOffsetY = s.shadowY * px;
    }
    if (s.bg === 'box') {
      ctx.fillStyle = withAlpha(s.bgColor, s.bgOpacity);
      roundRect(ctx, x0, y0, w, h, r);
      ctx.fill();
    }
    ctx.restore();
    if (s.border > 0) {
      const bw = s.border * px;
      ctx.lineWidth = bw;
      ctx.strokeStyle = s.borderColor;
      roundRect(ctx, x0 + bw / 2, y0 + bw / 2, w - bw, h - bw, Math.max(0, r - bw / 2));
      ctx.stroke();
    }
  }
  const lineX = (i) => {
    if (s.align === 'left') return x0 + padX;
    if (s.align === 'right') return x0 + padX + L.textW - widths[i];
    return -widths[i] / 2;
  };
  const baseY = (i) => y0 + padY + asc + i * lineH;
  if (s.bg === 'lines') {
    ctx.fillStyle = withAlpha(s.bgColor, s.bgOpacity);
    lines.forEach((_, i) => {
      const ex = s.padX * px;
      const ey = s.padY * px;
      roundRect(ctx, lineX(i) - ex, baseY(i) - asc - ey, widths[i] + ex * 2, asc + L.desc + ey * 2, r);
      ctx.fill();
    });
  }
  // text
  setFont(ctx, s, px);
  let fill = s.color;
  if (Array.isArray(s.gradient) && s.gradient.length === 2) {
    const g = ctx.createLinearGradient(0, y0 + padY, 0, y0 + h - padY);
    g.addColorStop(0, s.gradient[0]);
    g.addColorStop(1, s.gradient[1]);
    fill = g;
  }
  const textShadow = s.shadow > 0 && s.bg !== 'box';
  lines.forEach((line, i) => {
    const x = lineX(i);
    const y = baseY(i);
    if (s.glow > 0) {
      ctx.save();
      ctx.shadowColor = s.glowColor;
      ctx.fillStyle = s.glowColor;
      for (const k of [1, 0.55, 0.25]) {
        ctx.shadowBlur = s.glow * px * k * 1.6;
        ctx.fillText(line, x, y);
      }
      ctx.restore();
    }
    if (s.stroke > 0) {
      ctx.save();
      if (textShadow) {
        ctx.shadowColor = s.shadowColor;
        ctx.shadowBlur = s.shadow * px;
        ctx.shadowOffsetX = s.shadowX * px;
        ctx.shadowOffsetY = s.shadowY * px;
      }
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = s.stroke * px * 2;
      ctx.strokeStyle = s.strokeColor;
      ctx.strokeText(line, x, y);
      ctx.restore();
    }
    ctx.save();
    if (textShadow && !(s.stroke > 0)) {
      ctx.shadowColor = s.shadowColor;
      ctx.shadowBlur = s.shadow * px;
      ctx.shadowOffsetX = s.shadowX * px;
      ctx.shadowOffsetY = s.shadowY * px;
    }
    ctx.fillStyle = fill;
    ctx.fillText(line, x, y);
    ctx.restore();
    if (s.underline) {
      ctx.fillStyle = typeof fill === 'string' ? fill : s.gradient[1];
      ctx.fillRect(x, y + px * 0.12, widths[i], Math.max(1, px * 0.06));
    }
  });
  return L;
}

// ---------------------------------------------------------------- generic items

// Size in px of an item (before rotation). `res` resolves media: { img|video, w, h }.
export function itemSize(item, W, H, res) {
  if (item.kind === 'text') {
    const L = layoutText(item, W, H);
    return { w: L.w, h: L.h };
  }
  const w = clamp(item.w || 0.25, 0.01, 4) * W;
  if (item.kind === 'sticker' || item.kind === 'emoji') return { w, h: w };
  const nw = (res && res.w) || (item.src && item.src.w) || 16;
  const nh = (res && res.h) || (item.src && item.src.h) || 9;
  return { w, h: (w * nh) / nw };
}

// Animation at `tl` seconds into an item: opacity factor and offset (fractions of the frame).
export const ANIMS = [
  ['none', 'Nenhuma'], ['fade', 'Surgir'], ['up', 'Subir'], ['down', 'Descer'], ['left', 'Da direita'], ['right', 'Da esquerda'],
];
export const SLIDE = 0.045;

export function animState(item, tl) {
  const a = item.anim || {};
  const D = clamp(a.d || 0.35, 0.05, 3);
  const dur = item.dur || 1;
  let alpha = 1;
  let dx = 0;
  let dy = 0;
  const apply = (kind, p, sign) => {
    if (!kind || kind === 'none') return;
    alpha *= p;
    const q = (1 - p) * (1 - p) * sign;
    if (kind === 'up') dy += SLIDE * q;
    else if (kind === 'down') dy -= SLIDE * q;
    else if (kind === 'left') dx += SLIDE * q;
    else if (kind === 'right') dx -= SLIDE * q;
  };
  apply(a.in, clamp(tl / D, 0, 1), 1);
  apply(a.out, clamp((dur - tl) / D, 0, 1), -1);
  return { alpha, dx, dy };
}

// Draws any item onto ctx for a W x H frame, at time `tl` into the item.
export function drawItem(ctx, item, W, H, res, tl = null) {
  const st = tl == null ? { alpha: 1, dx: 0, dy: 0 } : animState(item, tl);
  const op = clamp(item.opacity ?? 1, 0, 1) * st.alpha;
  if (op <= 0.003) return;
  const cx = (item.x + st.dx) * W;
  const cy = (item.y + st.dy) * H;
  ctx.save();
  ctx.globalAlpha = op;
  ctx.translate(cx, cy);
  const rot = (item.rot || 0) + (item.kind === 'text' ? mergeStyle(item.style).rot || 0 : 0);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  if (item.kind === 'text') {
    drawTextBox(ctx, item, W, H);
  } else if (item.kind === 'emoji') {
    const { w } = itemSize(item, W, H);
    ctx.font = `${w * 0.86}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.emoji || '⭐', 0, w * 0.04);
  } else {
    const { w, h } = itemSize(item, W, H, res);
    const src = res && (res.img || res.video);
    const r = (item.radius || 0) * Math.min(w, h);
    if (item.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = Math.min(w, h) * 0.08;
      ctx.shadowOffsetY = Math.min(w, h) * 0.03;
      ctx.fillStyle = '#000';
      roundRect(ctx, -w / 2, -h / 2, w, h, r);
      if (item.kind !== 'sticker') ctx.fill();
      ctx.restore();
    }
    ctx.save();
    if (r > 0 && item.kind !== 'sticker') {
      roundRect(ctx, -w / 2, -h / 2, w, h, r);
      ctx.clip();
    }
    if (src) {
      try { ctx.drawImage(src, -w / 2, -h / 2, w, h); } catch { /* not decodable yet */ }
    } else if (item.kind !== 'sticker' && !item.ringOnly) {
      ctx.fillStyle = 'rgba(123,128,255,0.25)';
      ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    ctx.restore();
    const bw = (item.border || 0) * Math.min(W, H) / 1080;
    if (bw > 0 && item.kind !== 'sticker') {
      ctx.lineWidth = bw;
      ctx.strokeStyle = item.borderColor || '#ffffff';
      roundRect(ctx, -w / 2 + bw / 2, -h / 2 + bw / 2, w - bw, h - bw, Math.max(0, r - bw / 2));
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Rotated bounding box (px) of an item centered at its position, with a margin for shadows/glow.
export function itemBounds(item, W, H, res) {
  const { w, h } = itemSize(item, W, H, res);
  const rot = (((item.rot || 0) + (item.kind === 'text' ? mergeStyle(item.style).rot || 0 : 0)) * Math.PI) / 180;
  const c = Math.abs(Math.cos(rot));
  const s = Math.abs(Math.sin(rot));
  let margin = Math.min(W, H) * 0.01;
  if (item.kind === 'text') {
    const st = mergeStyle(item.style);
    const px = fontPx(item, W, H);
    margin += px * (Math.max(st.shadow, 0) * 1.2 + Math.max(Math.abs(st.shadowX), Math.abs(st.shadowY)) + st.glow * 2 + st.stroke + 0.15);
  } else if (item.shadow) margin += Math.min(w, h) * 0.12;
  const bw = w * c + h * s + margin * 2;
  const bh = w * s + h * c + margin * 2;
  return { w: Math.ceil(bw), h: Math.ceil(bh), cx: item.x * W, cy: item.y * H };
}

// Renders an item alone (no animation) to a PNG data URL, for the export.
// Returns { png, x, y, w, h } in output pixels (x/y = top-left).
export function rasterize(item, W, H, res) {
  const b = itemBounds(item, W, H, res);
  const cv = document.createElement('canvas');
  cv.width = Math.max(2, b.w + (b.w % 2));
  cv.height = Math.max(2, b.h + (b.h % 2));
  const ctx = cv.getContext('2d');
  const shifted = { ...item, x: cv.width / 2 / W, y: cv.height / 2 / H, opacity: 1 };
  drawItem(ctx, shifted, W, H, res, null);
  return {
    png: cv.toDataURL('image/png'),
    x: Math.round(b.cx - cv.width / 2),
    y: Math.round(b.cy - cv.height / 2),
    w: cv.width,
    h: cv.height,
  };
}
