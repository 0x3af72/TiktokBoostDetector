/*
 * Generates icons/icon{16,48,128}.png — no image libs, just zlib.
 * Design: teal rounded square + a white magnifying glass over a small "pulse"
 * tick (detector reading a signal). Run: node scripts/gen-icons.js
 */
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

function png(size, draw) {
  const W = size, H = size;
  const raw = Buffer.alloc(H * (1 + W * 4)); // 1 filter byte per row + RGBA
  const px = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = y * (1 + W * 4) + 1 + x * 4;
    // simple alpha-over onto existing
    const ba = raw[o + 3] / 255, sa = a / 255;
    const outA = sa + ba * (1 - sa);
    const mix = (s, d) => (outA === 0 ? 0 : Math.round((s * sa + d * (ba) * (1 - sa)) / outA));
    raw[o] = mix(r, raw[o]); raw[o + 1] = mix(g, raw[o + 1]); raw[o + 2] = mix(b, raw[o + 2]);
    raw[o + 3] = Math.round(outA * 255);
  };
  draw({ W, H, px });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function draw({ W, H, px }) {
  const s = W;
  const teal = [20, 184, 166], dark = [15, 15, 18], white = [255, 255, 255];
  const rad = s * 0.22;
  // rounded-rect background
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inset = (cx, cy) => Math.hypot(x - cx, y - cy) <= rad;
      let inside = true;
      if (x < rad && y < rad) inside = inset(rad, rad);
      else if (x > W - rad && y < rad) inside = inset(W - rad, rad);
      else if (x < rad && y > H - rad) inside = inset(rad, H - rad);
      else if (x > W - rad && y > H - rad) inside = inset(W - rad, H - rad);
      if (inside) px(x, y, teal[0], teal[1], teal[2], 255);
    }
  // magnifying glass: ring centered upper-left of middle
  const cx = W * 0.4, cy = H * 0.4, R = s * 0.24, thick = Math.max(2, s * 0.08);
  const disk = (x0, y0, r, col) => {
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (dx * dx + dy * dy <= r * r) px(Math.round(x0 + dx), Math.round(y0 + dy), col[0], col[1], col[2], 255);
  };
  // handle FIRST (so the ring sits on top of it), thick + long, bottom-right
  const hx0 = cx + R * 0.7, hy0 = cy + R * 0.7, hl = s * 0.34;
  for (let t = 0; t <= hl; t += 0.3) disk(hx0 + t * 0.707, hy0 + t * 0.707, Math.max(1.5, thick * 0.6), white);
  // filled lens interior (dark teal) then white ring on top
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= R - thick / 2) px(x, y, 8, 102, 92, 255); // darker teal lens
      else if (Math.abs(d - R) <= thick / 2) px(x, y, white[0], white[1], white[2], 255);
    }
  // pulse/heartbeat tick inside the lens (white, on the dark lens — high contrast)
  const pts = [
    [-0.55, 0], [-0.22, 0], [-0.06, -0.4], [0.12, 0.4], [0.28, 0], [0.55, 0],
  ].map(([a, b]) => [cx + a * R, cy + b * R]);
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const steps = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0)));
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / steps);
      const y = Math.round(y0 + ((y1 - y0) * k) / steps);
      const r = Math.max(0.8, s * 0.022);
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          if (dx * dx + dy * dy <= r * r) px(x + dx, y + dy, white[0], white[1], white[2], 255);
    }
  }
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png(size, draw));
  console.log(`wrote icons/icon${size}.png`);
}
