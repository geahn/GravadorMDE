// Full-screen overlay to draw the area of the screen that will be recorded.
const api = window.api;
const $ = (s) => document.querySelector(s);
const box = $('#box');
const bar = $('#bar');
let start = null;
let rect = null;

function draw(r) {
  box.style.display = 'block';
  $('#shade').style.display = 'none';
  Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  const dpr = window.devicePixelRatio || 1;
  $('#size').textContent = `${Math.round(r.w * dpr)} × ${Math.round(r.h * dpr)}`;
}

function showBar() {
  bar.style.display = 'flex';
  const below = rect.y + rect.h + 60 < innerHeight;
  bar.style.top = `${below ? rect.y + rect.h + 12 : Math.max(12, rect.y - 54)}px`;
  bar.style.left = `${Math.min(innerWidth - bar.offsetWidth - 12, Math.max(12, rect.x + rect.w - bar.offsetWidth))}px`;
}

function finish(ok) {
  api.region.done(ok && rect ? {
    x: rect.x / innerWidth, y: rect.y / innerHeight, w: rect.w / innerWidth, h: rect.h / innerHeight,
  } : null);
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('#bar')) return;
  start = { x: e.clientX, y: e.clientY };
  rect = null;
  bar.style.display = 'none';
  $('#hint').style.display = 'none';
});

document.addEventListener('pointermove', (e) => {
  if (!start) return;
  let w = Math.abs(e.clientX - start.x);
  let h = Math.abs(e.clientY - start.y);
  if (e.shiftKey) h = w * 9 / 16; // lock 16:9
  const x = e.clientX < start.x ? start.x - w : start.x;
  const y = e.clientY < start.y ? start.y - h : start.y;
  rect = { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(w, innerWidth - Math.max(0, x)), h: Math.min(h, innerHeight - Math.max(0, y)) };
  draw(rect);
});

document.addEventListener('pointerup', () => {
  if (!start) return;
  start = null;
  if (!rect || rect.w < 80 || rect.h < 45) {
    rect = null;
    box.style.display = 'none';
    $('#shade').style.display = 'block';
    $('#hint').style.display = 'block';
    return;
  }
  showBar();
});

document.addEventListener('dblclick', (e) => { if (rect && !e.target.closest('#bar')) finish(true); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') finish(false);
  if (e.key === 'Enter' && rect) finish(true);
});
$('#ok').addEventListener('click', () => finish(true));
$('#cancel').addEventListener('click', () => finish(false));
$('#redo').addEventListener('click', () => {
  rect = null;
  bar.style.display = 'none';
  box.style.display = 'none';
  $('#shade').style.display = 'block';
  $('#hint').style.display = 'block';
});
