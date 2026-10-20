// Live "beauty" for any camera, on the GPU (WebGL2): skin smoothing that keeps
// edges, skin tone evening, face brightening, a rosy tint and sharpening of
// what is not skin (eyes, hair, clothes). Skin is found by its color (YCbCr),
// so it needs no face detection and no downloaded models.
//
// settings: { smooth, tone, bright, rosy, sharp } each 0..100

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 o;
uniform sampler2D tex;
uniform vec2 px;      // one pixel in uv units
uniform float u_smooth; // 0..1
uniform float u_tone;   // 0..1
uniform float u_bright; // 0..1
uniform float u_rosy;   // 0..1
uniform float u_sharp;  // 0..1

float skinMask(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = (c.b - y) * 0.564 + 0.5;
  float cr = (c.r - y) * 0.713 + 0.5;
  // soft box around the skin cluster (in 0..1 units: Cb 77..127, Cr 133..173 of 255)
  float m = smoothstep(0.28, 0.32, cb) * (1.0 - smoothstep(0.50, 0.54, cb))
          * smoothstep(0.50, 0.54, cr) * (1.0 - smoothstep(0.68, 0.72, cr));
  return m * smoothstep(0.12, 0.22, y);
}

void main() {
  vec3 c = texture(tex, uv).rgb;
  float m = skinMask(c);
  // edge-preserving blur: neighbours count less the more their color differs
  vec3 acc = c;
  float wsum = 1.0;
  float r = 2.0 + 7.0 * u_smooth;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.39996; // golden angle spiral
    float d = r * sqrt((float(i) + 0.5) / 16.0);
    vec3 s = texture(tex, uv + vec2(cos(a), sin(a)) * d * px).rgb;
    float diff = length(s - c);
    float w = exp(-diff * diff * 30.0);
    acc += s * w;
    wsum += w;
  }
  vec3 blur = acc / wsum;
  vec3 res = mix(c, blur, m * u_smooth * 0.9);
  // u_tone: pull skin towards its own smoothed color (evens blotches)
  res = mix(res, mix(res, blur * 1.03, 0.6), m * u_tone * 0.6);
  // brighten skin (soft curve, highlights protected)
  res = mix(res, 1.0 - (1.0 - res) * (1.0 - 0.35 * u_bright), m);
  // u_rosy tint on skin
  res = mix(res, res * vec3(1.06, 0.97, 0.98), m * u_rosy);
  // sharpen what is not skin
  vec3 n = (texture(tex, uv + vec2(px.x, 0.0)).rgb + texture(tex, uv - vec2(px.x, 0.0)).rgb
          + texture(tex, uv + vec2(0.0, px.y)).rgb + texture(tex, uv - vec2(0.0, px.y)).rgb) * 0.25;
  res += (c - n) * u_sharp * 1.6 * (1.0 - m * 0.8);
  o = vec4(clamp(res, 0.0, 1.0), 1.0);
}`;

export const BEAUTY_KEYS = [
  ['smooth', 'Pele lisa'], ['tone', 'Uniformizar tom'], ['bright', 'Iluminar rosto'], ['rosy', 'Rosado'], ['sharp', 'Nitidez'],
];

export const beautyOn = (b) => !!b && BEAUTY_KEYS.some(([k]) => (Number(b[k]) || 0) > 0);

export class Beauty {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    this.ok = !!this.gl && this.init();
  }

  init() {
    const { gl } = this;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      this.prog = prog;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      this.u = Object.fromEntries(['px', 'smooth', 'tone', 'bright', 'rosy', 'sharp'].map((n) => [n, gl.getUniformLocation(prog, n === 'px' ? n : `u_${n}`)]));
      return true;
    } catch (err) {
      console.warn('Beleza indisponível:', err);
      return false;
    }
  }

  // Returns a canvas with the treated picture (or the source untouched when off / unsupported).
  process(src, w, h, b) {
    if (!this.ok || !beautyOn(b) || !src || !w || !h) return src;
    const { gl } = this;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    try {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch {
      return src;
    }
    // the blur radius follows the picture size (tuned for 1080p)
    const k = h / 1080;
    gl.uniform2f(this.u.px, k / w, k / h);
    for (const [key] of BEAUTY_KEYS) gl.uniform1f(this.u[key], Math.min(1, Math.max(0, (Number(b[key]) || 0) / 100)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}
