// Generates icon-180.png / icon-192.png / icon-512.png — a brass coupe glass
// on walnut. Zero dependencies (hand-rolled PNG encoder + node's zlib).
// Run: node make-icons.js
const zlib = require('zlib');
const fs = require('fs');

// --- minimal PNG encoder (8-bit RGBA, filter 0) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing: walnut vignette bg + brass coupe silhouette, 2x supersampled ---
const BG = [0x1a, 0x14, 0x10], BRASS = [0xc9, 0xa1, 0x5a], BRASS_HI = [0xe2, 0xc1, 0x84];
function inCoupe(x, y) { // x,y in 0..1
  const cx = 0.5, dx = Math.abs(x - cx);
  // bowl: elliptical, y 0.22..0.46
  if (y >= 0.22 && y <= 0.46) {
    const t = (y - 0.22) / 0.24;
    if (dx <= 0.31 * Math.sqrt(Math.max(0, 1 - t * t))) return true;
  }
  // stem: y 0.46..0.70
  if (y > 0.46 && y <= 0.70 && dx <= 0.020) return true;
  // foot: flared trapezoid y 0.70..0.745 + base slab 0.745..0.765
  if (y > 0.70 && y <= 0.745) {
    const t = (y - 0.70) / 0.045;
    if (dx <= 0.03 + t * 0.125) return true;
  }
  if (y > 0.745 && y <= 0.765 && dx <= 0.158) return true;
  return false;
}
function inSparkle(x, y) { // a small four-point star above the bowl's rim, off-center
  const sx = 0.735, sy = 0.155, r = 0.052;
  const dx = Math.abs(x - sx), dy = Math.abs(y - sy);
  return (dx + dy * 6 < r) || (dy + dx * 6 < r);
}
function draw(size) {
  const SS = 2, N = size * SS;
  const acc = new Float64Array(size * size * 3);
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const x = (px + 0.5) / N, y = (py + 0.5) / N;
      let c;
      if (inCoupe(x, y)) {
        // subtle vertical sheen on the brass
        const sheen = Math.max(0, 1 - Math.abs(x - 0.42) * 3.2);
        c = [
          BRASS[0] + (BRASS_HI[0] - BRASS[0]) * sheen * 0.6,
          BRASS[1] + (BRASS_HI[1] - BRASS[1]) * sheen * 0.6,
          BRASS[2] + (BRASS_HI[2] - BRASS[2]) * sheen * 0.6,
        ];
      } else if (inSparkle(x, y)) {
        c = BRASS_HI;
      } else {
        // walnut with radial vignette
        const d = Math.hypot(x - 0.5, y - 0.44) / 0.72;
        const v = 1 - 0.38 * Math.min(1, d * d);
        c = [BG[0] * v + 8, BG[1] * v + 5, BG[2] * v + 3];
      }
      const ox = Math.floor(px / SS), oy = Math.floor(py / SS);
      const i = (oy * size + ox) * 3;
      acc[i] += c[0]; acc[i + 1] += c[1]; acc[i + 2] += c[2];
    }
  }
  const rgba = Buffer.alloc(size * size * 4);
  const div = SS * SS;
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = Math.min(255, Math.round(acc[i * 3] / div));
    rgba[i * 4 + 1] = Math.min(255, Math.round(acc[i * 3 + 1] / div));
    rgba[i * 4 + 2] = Math.min(255, Math.round(acc[i * 3 + 2] / div));
    rgba[i * 4 + 3] = 255;
  }
  return encodePNG(size, size, rgba);
}

for (const size of [180, 192, 512]) {
  fs.writeFileSync(`icon-${size}.png`, draw(size));
  console.log(`wrote icon-${size}.png`);
}
