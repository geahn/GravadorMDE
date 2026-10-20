// Layout presets. Each layout is a "scene": geometry + style for the screen and
// camera layers. Every layout keeps its own adjustments, so the user can set
// them up once and switch between them while recording. There are two sets:
// horizontal (16:9, 1920x1080) and vertical (9:16, 1080x1920).

export const DIMS = {
  h: { w: 1920, h: 1080 },
  v: { w: 1080, h: 1920 },
};

export const PRESETS = {
  h: [
    { key: 'aula', name: 'Aula' },
    { key: 'canto', name: 'Câmera no canto' },
    { key: 'lado', name: 'Lado a lado' },
    { key: 'tela', name: 'Só a tela' },
    { key: 'camera', name: 'Só a câmera' },
  ],
  v: [
    { key: 'v-split', name: 'Tela + câmera' },
    { key: 'v-camtop', name: 'Câmera + tela' },
    { key: 'v-zoom', name: 'Tela com zoom' },
    { key: 'v-camera', name: 'Só a câmera' },
    { key: 'v-tela', name: 'Só a tela' },
  ],
};

export const orientationOf = (presetKey) => (String(presetKey).startsWith('v-') ? 'v' : 'h');
export const isPreset = (key) => PRESETS.h.some((p) => p.key === key) || PRESETS.v.some((p) => p.key === key);

export function baseLayer(overrides = {}) {
  return {
    visible: true,
    x: 0, y: 0, w: 1920, h: 1080,
    zoom: 1, panX: 0, panY: 0,
    shape: 'rect',
    radius: 0,
    shadow: false,
    borderWidth: 0,
    borderColor: '#ffffff',
    ...overrides,
  };
}

function fit(aspect, box) {
  let w = box.w;
  let h = w / aspect;
  if (h > box.h) {
    h = box.h;
    w = h * aspect;
  }
  return {
    x: Math.round(box.x + (box.w - w) / 2),
    y: Math.round(box.y + (box.h - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

// ---------------------------------------------------------------- horizontal

function horizontalScene(key, sa) {
  const W = 1920;
  const H = 1080;
  const exact = Math.abs(sa - W / H) < 0.02;
  const fullRect = exact ? { x: 0, y: 0, w: W, h: H } : fit(sa, { x: 40, y: 40, w: W - 80, h: H - 80 });
  const fullScreen = baseLayer({ ...fullRect, radius: exact ? 0 : 14, shadow: !exact });
  const cornerCam = baseLayer({
    x: W - 320 - 48, y: H - 320 - 48, w: 320, h: 320,
    shape: 'circle', shadow: true, borderWidth: 5, borderColor: '#ffffff',
  });

  switch (key) {
    case 'canto':
      return { order: ['screen', 'camera'], screen: fullScreen, camera: cornerCam };

    case 'lado': {
      const s = fit(sa, { x: 40, y: 40, w: 1260, h: H - 80 });
      const camX = s.x + s.w + 32;
      const camW = Math.min(W - 40 - camX, 720);
      const camH = Math.min(s.h, Math.round(camW * 1.6));
      return {
        order: ['screen', 'camera'],
        screen: baseLayer({ ...s, radius: 16, shadow: true }),
        camera: baseLayer({ x: camX, y: Math.round(s.y + (s.h - camH) / 2), w: camW, h: camH, radius: 16, shadow: true }),
      };
    }

    case 'tela':
      return { order: ['screen', 'camera'], screen: fullScreen, camera: { ...cornerCam, visible: false } };

    case 'camera':
      return {
        order: ['screen', 'camera'],
        screen: { ...fullScreen, visible: false },
        camera: baseLayer({ x: 0, y: 0, w: W, h: H }),
      };

    case 'aula':
    default: {
      // Screen on the left, a vertical camera on the right slightly overlapping it.
      const camW = 380;
      const camH = 640;
      const camX = W - camW - 40;
      const overlap = 108;
      const s = fit(sa, { x: 48, y: 56, w: camX + overlap - 48, h: H - 112 });
      const camY = Math.round(Math.min(Math.max(s.y + s.h / 2 - camH / 2, 40), H - camH - 40));
      return {
        order: ['screen', 'camera'],
        screen: baseLayer({ ...s, radius: 14, shadow: true }),
        camera: baseLayer({ x: camX, y: camY, w: camW, h: camH, radius: 28, shadow: true }),
      };
    }
  }
}

// ---------------------------------------------------------------- vertical

function verticalScene(key, sa) {
  const W = 1080;
  const H = 1920;
  const bubble = baseLayer({
    x: Math.round((W - 420) / 2), y: H - 420 - 150, w: 420, h: 420,
    shape: 'circle', shadow: true, borderWidth: 6, borderColor: '#ffffff',
  });

  switch (key) {
    case 'v-camtop': {
      // Camera on top, the screen below overlapping it a little.
      const camH = 1180;
      const s = fit(sa, { x: 32, y: camH - 40, w: W - 64, h: H - camH - 40 });
      s.y = camH - 40;
      return {
        order: ['camera', 'screen'],
        screen: baseLayer({ ...s, radius: 20, shadow: true }),
        camera: baseLayer({ x: 0, y: 0, w: W, h: camH }),
      };
    }

    case 'v-zoom':
      // The screen fills the frame (zoom/pan to pick the area) with a camera bubble.
      return {
        order: ['screen', 'camera'],
        screen: baseLayer({ x: 0, y: 0, w: W, h: H }),
        camera: bubble,
      };

    case 'v-camera': {
      const s = fit(sa, { x: 32, y: 120, w: W - 64, h: 700 });
      return {
        order: ['screen', 'camera'],
        screen: baseLayer({ ...s, y: 120, radius: 20, shadow: true, visible: false }),
        camera: baseLayer({ x: 0, y: 0, w: W, h: H }),
      };
    }

    case 'v-tela':
      return {
        order: ['screen', 'camera'],
        screen: baseLayer({ ...fit(sa, { x: 0, y: 0, w: W, h: H }) }),
        camera: { ...bubble, visible: false },
      };

    case 'v-split':
    default: {
      // Screen on top, a large camera below overlapping its bottom edge.
      const s = fit(sa, { x: 32, y: 120, w: W - 64, h: 700 });
      s.y = 120;
      const camY = s.y + s.h - 56;
      const camW = 940;
      return {
        order: ['screen', 'camera'],
        screen: baseLayer({ ...s, radius: 20, shadow: true }),
        camera: baseLayer({ x: Math.round((W - camW) / 2), y: camY, w: camW, h: H - 110 - camY, radius: 32, shadow: true }),
      };
    }
  }
}

export function defaultScene(key, screenAspect = 16 / 9) {
  const sa = screenAspect > 0 ? screenAspect : 16 / 9;
  const scene = orientationOf(key) === 'v' ? verticalScene(key, sa) : horizontalScene(key, sa);
  return { custom: false, ...scene };
}

export const MAX_LAYOUTS = 9;

let seq = 0;
export const newId = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

// A layout = name + the preset it was based on (used by "Restaurar") + its scene.
export function makeLayout(base, name, screenAspect, id = newId()) {
  return { id, name, base, ...defaultScene(base, screenAspect) };
}

export function defaultLayouts(screenAspect, orientation = 'h') {
  return PRESETS[orientation].map((p) => makeLayout(p.key, p.name, screenAspect, p.key));
}

export const BACKGROUNDS = [
  { key: 'preto', name: 'Preto', colors: ['#000000', '#000000'] },
  { key: 'grafite', name: 'Grafite', colors: ['#14161c', '#23262f'] },
  { key: 'noite', name: 'Noite', colors: ['#0f172a', '#312e81'] },
  { key: 'oceano', name: 'Oceano', colors: ['#082f49', '#0e7490'] },
  { key: 'aurora', name: 'Aurora', colors: ['#1e1b4b', '#9d174d'] },
  { key: 'floresta', name: 'Floresta', colors: ['#052e16', '#166534'] },
  { key: 'areia', name: 'Areia', colors: ['#e7e0d4', '#f6f2ea'] },
  { key: 'claro', name: 'Claro', colors: ['#e2e8f0', '#f8fafc'] },
];
