// "Roteiro": a floating script with teleprompter-style auto scroll.
const api = window.api;
const $ = (s) => document.querySelector(s);
const text = $('#text');
let size = 30;
let speed = 35; // px per second
let rolling = false;
let last = 0;
let saveTimer = null;
let pos = 0;

const state = await api.script.get();
text.value = state.text;
size = state.size;
speed = state.speed;
$('#speed').value = speed;
applySize();

function applySize() {
  text.style.fontSize = `${size}px`;
}

function save(patch) {
  api.script.set(patch);
}

function frame(now) {
  if (!rolling) return;
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  pos += speed * dt;
  text.scrollTop = pos;
  if (text.scrollTop + text.clientHeight >= text.scrollHeight - 2) toggle(false);
  else requestAnimationFrame(frame);
}

function toggle(on = !rolling) {
  rolling = on;
  $('#play').classList.toggle('on', on);
  $('#play').textContent = on ? '❚❚ Pausar' : '▶ Rolar';
  if (on) {
    pos = text.scrollTop;
    last = 0;
    requestAnimationFrame(frame);
  }
}

text.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save({ text: text.value }), 400);
});
text.addEventListener('wheel', () => { pos = text.scrollTop; });
$('#play').addEventListener('click', () => toggle());
$('#speed').addEventListener('input', (e) => { speed = Number(e.target.value); save({ speed }); });
$('#bigger').addEventListener('click', () => { size = Math.min(72, size + 4); applySize(); save({ size }); });
$('#smaller').addEventListener('click', () => { size = Math.max(14, size - 4); applySize(); save({ size }); });
$('#close').addEventListener('click', () => { save({ text: text.value }); api.script.close(); });
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === ' ') { e.preventDefault(); toggle(); }
});
window.addEventListener('beforeunload', () => save({ text: text.value }));
