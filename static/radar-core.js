"use strict";
/* radar-core v2 (plan §1.2/§2.4): the radar is a native MapLibre custom GL
   layer. MapLibre hands us its projection matrix every frame, so the sweep is
   drawn in mercator space by the GPU with zero manual canvas positioning —
   the entire class of "misplaced/clipped overlay" bugs cannot exist here. */

const RadarCore = (() => {

const VS = `
attribute vec2 a_pos;          /* mercator units (for the map matrix)      */
attribute vec2 a_local;        /* offset from radar in KM (small numbers!) */
uniform mat4 u_matrix;
varying vec2 v_km;
void main() {
  v_km = a_local;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FS = `precision highp float;
varying vec2 v_km;             /* east/north from radar, km — fp16-safe */
uniform sampler2D u_data, u_lut;
uniform vec3 u_gates;          /* first_m, spacing_m, ngates */
uniform float u_opacity;
uniform float u_smooth;        /* 0 = crisp, 1 = 3x3 post-LUT average */
uniform vec2 u_texel;          /* 1/ngates, 1/rows */
const float PI = 3.14159265358979;

vec4 shade(vec2 tc) {
  /* wrap azimuth, clamp range, colorize, premultiply */
  tc.y = fract(tc.y);
  float raw = texture2D(u_data, tc).r;
  vec4 c = texture2D(u_lut, vec2(raw * 255.0 / 256.0 + 0.5 / 256.0, 0.5));
  return vec4(c.rgb * c.a, c.a);
}

void main() {
  float r = length(v_km) * 1000.0;
  float az = atan(v_km.x, v_km.y); if (az < 0.0) az += 2.0 * PI;
  float col = (r - u_gates.x) / u_gates.y / u_gates.z;
  if (col < 0.0 || col > 1.0) { gl_FragColor = vec4(0.0); return; }
  vec2 tc = vec2(col, az / (2.0 * PI));
  vec4 acc;
  if (u_smooth > 0.5) {
    acc = vec4(0.0);
    for (int dx = -1; dx <= 1; dx++)
      for (int dy = -1; dy <= 1; dy++)
        acc += shade(tc + vec2(float(dx), float(dy)) * u_texel);
    acc /= 9.0;
  } else {
    acc = shade(tc);
  }
  gl_FragColor = acc * u_opacity;
}`;

const mercX = lon => (lon + 180) / 360;
const mercY = lat => {
  const s = Math.sin(lat * Math.PI / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

class RadarLayer {
  constructor() {
    this.id = "l2-radar"; this.type = "custom"; this.renderingMode = "2d";
    this.frames = new Map(); this.order = []; this.maxFrames = 12;
    this.current = null; this.opacity = 0.8; this.smooth = false;
    this._lutData = null; this._map = null;
  }

  onAdd(map, gl) {
    this._map = map; this.gl = gl;
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s);
      gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS))
        console.error("[radar-core]", gl.getShaderInfoLog(o));
      return o; };
    this.prog = gl.createProgram();
    gl.attachShader(this.prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(this.prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(this.prog);
    this.aPos = gl.getAttribLocation(this.prog, "a_pos");
    this.buf = gl.createBuffer();
    this.lutTex = gl.createTexture();
    if (this._lutData) this._uploadLUT();
    for (const [id, f] of this.frames) if (!f.tex && f.bytes) this._uploadFrame(f);
  }

  onRemove() {
    const gl = this.gl;
    if (!gl) return;
    for (const f of this.frames.values()) if (f.tex) gl.deleteTexture(f.tex);
    this.frames.clear(); this.order.length = 0; this.current = null;
  }

  _filter(tex) {
    const gl = this.gl, f = this.smooth ? gl.LINEAR : gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  }

  _uploadFrame(f) {
    const gl = this.gl;
    f.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, f.header.ngates,
                  f.header.rows, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, f.bytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._filter(f.tex);
    f.bytes = null;
  }

  addFrame(id, header, bytes) {
    if (this.frames.has(id)) return;
    const f = { header, bytes, tex: null };
    this.frames.set(id, f);
    this.order.push(id);
    if (this.gl) this._uploadFrame(f);
    while (this.order.length > this.maxFrames) {
      const old = this.order.shift();
      if (old === this.current) { this.order.push(old); break; }
      const g = this.frames.get(old);
      if (g.tex && this.gl) this.gl.deleteTexture(g.tex);
      this.frames.delete(old);
    }
  }

  header(id) { return this.frames.get(id)?.header; }

  setFrame(id) {
    if (!this.frames.has(id)) return;
    this.current = id;
    const h = this.frames.get(id).header;
    if (this._meshKey !== `${h.radar_lat},${h.radar_lon},${h.first_m},${h.spacing_m},${h.ngates}`) {
      this._meshKey = `${h.radar_lat},${h.radar_lon},${h.first_m},${h.spacing_m},${h.ngates}`;
      this._buildMesh(h);
    }
    this._map && this._map.triggerRepaint();
  }

  /* A ROWS-strip grid across the sweep's bbox. Each vertex carries both its
     mercator position (for the map matrix) and its exact east/north offset
     from the radar in km, computed here in double precision. The fragment
     shader then works purely with small local numbers, so reduced-precision
     GPUs cannot quantize the field into blocks. */
  _buildMesh(h) {
    const KM_DEG = 111.194;              // matches the verified CPU model
    const R = (h.first_m + h.ngates * h.spacing_m) / 1000;   // km
    const dLat = R / KM_DEG;
    const dLon = R / (KM_DEG * Math.cos(h.radar_lat * Math.PI / 180));
    const ROWS = 48, COLS = 2;
    const verts = [];                    // interleaved: mx, my, ekm, nkm
    const vert = (lon, lat) => {
      verts.push(mercX(lon), mercY(lat),
        (lon - h.radar_lon) * KM_DEG * Math.cos(lat * Math.PI / 180),
        (lat - h.radar_lat) * KM_DEG);
    };
    for (let i = 0; i < ROWS; i++) {
      const latA = h.radar_lat + dLat - (i / ROWS) * 2 * dLat;
      const latB = h.radar_lat + dLat - ((i + 1) / ROWS) * 2 * dLat;
      if (i > 0) vert(h.radar_lon - dLon, latA);          // degenerate join
      for (let j = 0; j <= COLS; j++) {
        const lon = h.radar_lon - dLon + (j / COLS) * 2 * dLon;
        vert(lon, latA);
        vert(lon, latB);
      }
      if (i < ROWS - 1) vert(h.radar_lon + dLon, latB);   // degenerate join
    }
    this.mesh = new Float32Array(verts);
    this.meshCount = verts.length / 4;
  }

  setLUT(rgba256) {
    this._lutData = rgba256;
    if (this.gl) { this._uploadLUT(); this._map.triggerRepaint(); }
  }
  _uploadLUT() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA,
                  gl.UNSIGNED_BYTE, this._lutData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setSmoothing(on) {
    this.smooth = !!on;
    if (!this.gl) return;
    for (const f of this.frames.values()) if (f.tex) this._filter(f.tex);
    this._map.triggerRepaint();
  }
  setOpacity(a) { this.opacity = a; this._map && this._map.triggerRepaint(); }

  render(gl, matrix) {
    const f = this.frames.get(this.current);
    if (!f || !f.tex || !this._lutData || !this.mesh) return;
    // MapLibre clips basemap tiles with the stencil buffer and may leave
    // depth state active; a custom layer MUST neutralize both or its
    // geometry gets clipped to tile rectangles.
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "u_matrix"), false, matrix);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(gl.getUniformLocation(this.prog, "u_data"), 0);
    gl.uniform1i(gl.getUniformLocation(this.prog, "u_lut"), 1);
    const h = f.header;
    gl.uniform3f(gl.getUniformLocation(this.prog, "u_gates"),
                 h.first_m, h.spacing_m, h.ngates);
    gl.uniform1f(gl.getUniformLocation(this.prog, "u_opacity"), this.opacity);
    gl.uniform1f(gl.getUniformLocation(this.prog, "u_smooth"),
                 this.smooth ? 1.0 : 0.0);
    gl.uniform2f(gl.getUniformLocation(this.prog, "u_texel"),
                 1.0 / h.ngates, 1.0 / h.rows);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 16, 0);
    const aLocal = gl.getAttribLocation(this.prog, "a_local");
    gl.enableVertexAttribArray(aLocal);
    gl.vertexAttribPointer(aLocal, 2, gl.FLOAT, false, 16, 8);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.meshCount);
  }
}

function parseArtifact(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1),
                                    dv.getUint8(2), dv.getUint8(3));
  if (magic !== "RDR1") throw new Error("bad artifact magic: " + magic);
  const hlen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder()
    .decode(new Uint8Array(arrayBuffer, 8, hlen)));
  const grid = new Uint8Array(arrayBuffer, 8 + hlen);
  if (grid.length !== header.rows * header.ngates)
    throw new Error("grid size mismatch");
  return { header, grid };
}

return { RadarLayer, parseArtifact, mercX, mercY };
})();

if (typeof module !== "undefined") module.exports = RadarCore;
