import { icon, hydrateIcons } from './icons.js';

const api = window.api;
const $ = (s) => document.querySelector(s);
hydrateIcons();

const RING = 628.3;
let cdTimer = null;
let discardTimer = null;
let paused = false;
let layoutsKey = '';

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// ------------------------------------------------------------ countdown

function startCountdown(seconds) {
  $('#bar').hidden = true;
  $('#countdown').hidden = false;
  clearInterval(cdTimer);
  let left = seconds;
  const num = $('#cd-num');
  const prog = $('#cd-prog');
  const show = () => {
    num.textContent = left;
    num.classList.remove('pop');
    void num.offsetWidth;
    num.classList.add('pop');
    prog.style.transition = 'none';
    prog.style.strokeDashoffset = String(RING * (1 - left / seconds));
    requestAnimationFrame(() => {
      prog.style.transition = 'stroke-dashoffset 1s linear';
      prog.style.strokeDashoffset = String(RING * (1 - (left - 1) / seconds));
    });
  };
  show();
  cdTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(cdTimer);
      api.bar.countdownDone();
      return;
    }
    show();
  }, 1000);
}

$('#cd-cancel').addEventListener('click', () => {
  clearInterval(cdTimer);
  api.bar.cancel();
});

// ------------------------------------------------------------ bar

function miniHTML(rects) {
  return rects.map((r) => `<i class="m-${r.k}" style="left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%;border-radius:${r.circle ? '50%' : '1px'}"></i>`).join('');
}

function renderLayouts(layouts, active) {
  const key = JSON.stringify(layouts);
  const box = $('#layouts');
  if (key !== layoutsKey) {
    layoutsKey = key;
    box.innerHTML = layouts.map((l, i) => `
      <button class="lay" data-i="${i}" title="${l.name} (Alt+Shift+${i + 1})"><span class="mini">${miniHTML(l.rects)}</span></button>`).join('');
  }
  [...box.children].forEach((b, i) => b.classList.toggle('on', i === active));
  fitWindow();
}

// The window hugs the bar, whose width depends on how many layouts there are.
let lastWidth = 0;
function fitWindow() {
  requestAnimationFrame(() => {
    const bar = document.querySelector('.bar');
    if (!bar || $('#bar').hidden) return;
    const w = Math.ceil(bar.scrollWidth + 40);
    if (Math.abs(w - lastWidth) < 2) return;
    lastWidth = w;
    api.bar.resize(w);
  });
}

function setPaused(p) {
  paused = p;
  document.body.classList.toggle('paused', p);
  const b = $('#b-pause');
  b.innerHTML = icon(p ? 'play' : 'pause', 16);
  b.title = p ? 'Continuar (Alt+Shift+P)' : 'Pausar (Alt+Shift+P)';
}

function showBar(payload) {
  clearInterval(cdTimer);
  $('#countdown').hidden = true;
  $('#bar').hidden = false;
  setPaused(false);
  $('#time').textContent = '00:00:00';
  lastWidth = 0;
  if (payload.layouts) renderLayouts(payload.layouts, payload.active);
  fitWindow();
}

const vuBars = [...document.querySelectorAll('#vu span')];
function setLevel(level, micOn) {
  $('#vu').classList.toggle('off', !micOn);
  const n = Math.round(level * vuBars.length + 0.15);
  vuBars.forEach((b, i) => {
    b.classList.toggle('on', i < n);
    b.classList.toggle('hot', i === 3);
    b.classList.toggle('clip', i === 4);
  });
}

const setOrientation = (o) => { if (o) document.body.classList.toggle('vertical', o === 'v'); };

api.bar.onMode((p) => {
  setOrientation(p.orientation);
  if (p.mode === 'countdown') startCountdown(p.seconds);
  else showBar(p);
});

api.bar.onStatus((s) => {
  setOrientation(s.orientation);
  $('#time').textContent = fmt(s.elapsed);
  if ((s.state === 'paused') !== paused) setPaused(s.state === 'paused');
  setLevel(s.level || 0, s.micOn);
  const warn = !!s.micWarn;
  if ($('#mic-warn').hidden === warn) { $('#mic-warn').hidden = !warn; fitWindow(); }
  if (s.layouts) renderLayouts(s.layouts, s.active);
});

$('#layouts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (b) api.bar.action({ type: 'layout', index: Number(b.dataset.i) });
});
$('#b-pause').addEventListener('click', () => api.bar.action({ type: paused ? 'resume' : 'pause' }));
$('#b-stop').addEventListener('click', () => api.bar.action({ type: 'stop' }));
$('#b-studio').addEventListener('click', () => api.bar.openStudio());
$('#b-script').addEventListener('click', () => api.bar.script());
$('#b-discard').addEventListener('click', (e) => {
  const b = e.currentTarget;
  if (b.classList.contains('armed')) {
    clearTimeout(discardTimer);
    b.classList.remove('armed');
    api.bar.action({ type: 'discard' });
    return;
  }
  b.classList.add('armed');
  fitWindow();
  discardTimer = setTimeout(() => { b.classList.remove('armed'); fitWindow(); }, 3000);
});

setPaused(false);
