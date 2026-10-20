// Zoom regions. The same math drives the editor preview (a CSS transform) and
// the export (an FFmpeg zoompan expression), so the motion is identical.
//
// A resolved zoom: { o0, o1, scale, ease, mode: 'fixed'|'follow', x, y, path? }
//   o0/o1: seconds on the editor timeline; x/y: focus point (fractions of the frame);
//   path: [[t, cx, cy], ...] for "follow the mouse".

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const ZOOM_DEFAULT = { scale: 2, ease: 0.6, mode: 'fixed', x: 0.5, y: 0.5 };

function ramp(zm, t) {
  const R = Math.max(0.05, Math.min(zm.ease ?? 0.6, (zm.o1 - zm.o0) / 2));
  const k = clamp(Math.min((t - zm.o0) / R, (zm.o1 - t) / R), 0, 1);
  return { R, e: k * k * (3 - 2 * k) };
}

export function interpPath(path, t) {
  if (!path || !path.length) return null;
  if (t <= path[0][0]) return [path[0][1], path[0][2]];
  const last = path[path.length - 1];
  if (t >= last[0]) return [last[1], last[2]];
  let lo = 0;
  let hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid][0] <= t) lo = mid; else hi = mid;
  }
  const a = path[lo];
  const b = path[hi];
  const f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Zoom state at editor time t: z (1 = none) and the visible window's top-left (fractions).
export function zoomState(zooms, t) {
  for (const zm of zooms) {
    if (t < zm.o0 || t > zm.o1) continue;
    const { e } = ramp(zm, t);
    const z = 1 + (Math.max(1, zm.scale) - 1) * e;
    const c = zm.mode === 'follow' && zm.path && zm.path.length ? interpPath(zm.path, t) : [zm.x ?? 0.5, zm.y ?? 0.5];
    const x0 = clamp(c[0] - 0.5 / z, 0, 1 - 1 / z);
    const y0 = clamp(c[1] - 0.5 / z, 0, 1 - 1 / z);
    return { z, x0, y0, zm };
  }
  return { z: 1, x0: 0, y0: 0, zm: null };
}

// Smooth "camera" that follows the cursor: it only moves when the cursor
// leaves the middle of the zoomed window, and glides there (no jitter).
//   cursorAt(srcTime) -> [x, y] | null ; srcOf(editorTime) -> source time | null
export function followPath(zm, cursorAt, srcOf) {
  const dt = 0.1;
  const out = [];
  const z = Math.max(1.01, zm.scale);
  const dead = 0.18 / z; // half-size of the calm zone, in frame fractions
  let pos = null;
  for (let t = zm.o0; t <= zm.o1 + 1e-6; t += dt) {
    const src = srcOf(Math.min(t, zm.o1));
    const c = src == null ? null : cursorAt(src);
    if (c && !pos) pos = [c[0], c[1]];
    if (c && pos) {
      const target = [...pos];
      for (const i of [0, 1]) {
        const d = c[i] - pos[i];
        if (Math.abs(d) > dead) target[i] = c[i] - Math.sign(d) * dead;
      }
      const k = 1 - Math.exp(-dt / 0.32);
      pos = [pos[0] + (target[0] - pos[0]) * k, pos[1] + (target[1] - pos[1]) * k];
    }
    const p = pos || [zm.x ?? 0.5, zm.y ?? 0.5];
    out.push([Number(t.toFixed(3)), clamp(p[0], 0, 1), clamp(p[1], 0, 1)]);
  }
  // Fewer points for the export expression: keep every other one (5 per second).
  return out.filter((_, i) => i % 2 === 0 || i === out.length - 1);
}

const f4 = (v) => Number(v).toFixed(4);

// FFmpeg zoompan filter for zooms on the final video. `offset` = seconds before
// the editor timeline starts in the final file (the intro).
export function zoompanFilter(zooms, { W, H, fps, offset = 0 }) {
  if (!zooms.length) return null;
  const zTerms = [];
  const xTerms = [];
  const yTerms = [];
  const inAny = [];
  for (const zm of zooms) {
    const A = zm.o0 + offset;
    const B = zm.o1 + offset;
    const R = Math.max(0.05, Math.min(zm.ease ?? 0.6, (zm.o1 - zm.o0) / 2));
    const k = `clip(min((it-${f4(A)})/${f4(R)},(${f4(B)}-it)/${f4(R)}),0,1)`;
    zTerms.push(`between(it,${f4(A)},${f4(B)})*${f4(Math.max(1, zm.scale) - 1)}*(st(0,${k})*ld(0)*(3-2*ld(0)))`);
    const sel = `between(it,${f4(A)},${f4(B)})`;
    inAny.push(sel);
    if (zm.mode === 'follow' && zm.path && zm.path.length > 1) {
      const seg = (idx) => {
        const parts = [];
        for (let j = 0; j < zm.path.length - 1; j++) {
          const a = zm.path[j];
          const b = zm.path[j + 1];
          const ta = a[0] + offset;
          const tb = b[0] + offset;
          const slope = (b[idx] - a[idx]) / Math.max(1e-6, tb - ta);
          parts.push(`between(it,${f4(ta)},${f4(tb)})*(${f4(a[idx])}+${f4(slope)}*(it-${f4(ta)}))`);
        }
        return parts.join('+');
      };
      xTerms.push(`${sel}*(${seg(1)})`);
      yTerms.push(`${sel}*(${seg(2)})`);
    } else {
      xTerms.push(`${sel}*${f4(zm.x ?? 0.5)}`);
      yTerms.push(`${sel}*${f4(zm.y ?? 0.5)}`);
    }
  }
  const none = `(1-min(1,${inAny.join('+')}))*0.5`;
  const cx = `(${xTerms.join('+')}+${none})`;
  const cy = `(${yTerms.join('+')}+${none})`;
  const z = `1+${zTerms.join('+')}`;
  return `zoompan=z='${z}':x='clip(${cx}*iw-iw/zoom/2,0,iw-iw/zoom)':y='clip(${cy}*ih-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${W}x${H}:fps=${fps}`;
}
