/**
 * 生成插件图标资源（零依赖，纯 Node 实现 PNG 编码）
 *
 *   icons/tune.png   128x128 动作图标（透明背景，滑杆造型）
 *   icons/cover.png  960x540 插件封面
 *
 * 用法：node scripts/make-icons.mjs
 */
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 极简 2D 光栅器 ---------------- */

class Canvas {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.data = Buffer.alloc(width * height * 4);
  }

  /** alpha 覆盖率 0..1 的形状函数 + 颜色，source-over 混合 */
  paint(color, coverage) {
    const [r, g, b] = color;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const a = coverage(x + 0.5, y + 0.5);
        if (a <= 0) continue;
        const i = (y * this.w + x) * 4;
        const dstA = this.data[i + 3] / 255;
        const outA = a + dstA * (1 - a);
        if (outA <= 0) continue;
        this.data[i] = Math.round((r * a + this.data[i] * dstA * (1 - a)) / outA);
        this.data[i + 1] = Math.round((g * a + this.data[i + 1] * dstA * (1 - a)) / outA);
        this.data[i + 2] = Math.round((b * a + this.data[i + 2] * dstA * (1 - a)) / outA);
        this.data[i + 3] = Math.round(outA * 255);
      }
    }
  }
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 抗锯齿：距离 d 转成覆盖率 */
const cover = (d, feather = 0.7) => clamp01(0.5 - d / feather);

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy || 1));
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  return Math.hypot(dx, dy);
}

/* ---------------- 滑杆图标 ---------------- */

const ACCENT = [99, 102, 241]; // #6366f1
const ACCENT_SOFT = [129, 140, 248];

/**
 * 画一组「滑杆」：两条断开的线段 + 一个空心滑块。
 */
function drawSliders(canvas, rows, color, scale, offsetX, offsetY, strokeScale = 1) {
  const half = 3.6 * scale * strokeScale;
  const knobR = 11.5 * scale * strokeScale;
  const holeR = 4.6 * scale * strokeScale;

  for (const row of rows) {
    const y = offsetY + row.y * scale;
    const knobX = offsetX + row.knob * scale;
    const x1 = offsetX + row.from * scale;
    const x2 = offsetX + row.to * scale;

    // 线段（避开滑块）
    const gap = knobR + 1.5 * scale;
    const segments = [];
    if (knobX - gap > x1) segments.push([x1, knobX - gap]);
    if (x2 > knobX + gap) segments.push([knobX + gap, x2]);

    for (const [sx, ex] of segments) {
      canvas.paint(color, (px, py) => cover(sdSegment(px, py, sx, y, ex, y) - half));
    }

    // 滑块：外圈实心 + 内部挖空
    canvas.paint(color, (px, py) => {
      const d = Math.hypot(px - knobX, py - y);
      return cover(d - knobR) - cover(d - holeR);
    });
  }
}

/* ---------------- 5x7 点阵字体（封面文字用） ---------------- */

const FONT = {
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  l: ['01100', '00100', '00100', '00100', '00100', '00100', '01110'],
  o: ['00000', '00000', '01110', '10001', '10001', '10001', '01110'],
  g: ['00000', '00000', '01111', '10001', '10001', '01111', '00001', '01110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  u: ['00000', '00000', '10001', '10001', '10001', '10011', '01101'],
  n: ['00000', '00000', '10110', '11001', '10001', '10001', '10001'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function drawText(canvas, text, x, y, scale, color) {
  let cursor = x;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let row = 0; row < glyph.length; row++) {
        for (let col = 0; col < glyph[row].length; col++) {
          if (glyph[row][col] !== '1') continue;
          const px = cursor + col * scale;
          const py = y + row * scale;
          canvas.paint(color, (sx, sy) =>
            cover(Math.max(Math.abs(sx - (px + scale / 2)) - scale / 2, Math.abs(sy - (py + scale / 2)) - scale / 2))
          );
        }
      }
    }
    cursor += 6 * scale;
  }
}

/* ---------------- 输出 ---------------- */

function buildActionIcon() {
  const size = 128;
  const canvas = new Canvas(size, size);
  const rows = [
    { y: 30, knob: 78, from: 14, to: 114 },
    { y: 64, knob: 46, from: 14, to: 114 },
    { y: 98, knob: 90, from: 14, to: 114 },
  ];
  drawSliders(canvas, rows, ACCENT, 1, 0, 0);
  return encodePng(size, size, canvas.data);
}

function buildCover() {
  const width = 960;
  const height = 540;
  const canvas = new Canvas(width, height);

  // 背景渐变
  const top = [99, 102, 241];
  const bottom = [139, 92, 246];
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    const color = [
      Math.round(top[0] + (bottom[0] - top[0]) * t),
      Math.round(top[1] + (bottom[1] - top[1]) * t),
      Math.round(top[2] + (bottom[2] - top[2]) * t),
    ];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      canvas.data[i] = color[0];
      canvas.data[i + 1] = color[1];
      canvas.data[i + 2] = color[2];
      canvas.data[i + 3] = 255;
    }
  }

  // 右上角柔光
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - width * 0.82, y - height * 0.16);
      const a = clamp01(1 - d / (height * 0.62)) * 0.32;
      if (a <= 0) continue;
      const i = (y * width + x) * 4;
      canvas.data[i] = Math.round(canvas.data[i] * (1 - a) + 255 * a);
      canvas.data[i + 1] = Math.round(canvas.data[i + 1] * (1 - a) + 255 * a);
      canvas.data[i + 2] = Math.round(canvas.data[i + 2] * (1 - a) + 255 * a);
    }
  }

  // 主图形
  const rows = [
    { y: 30, knob: 78, from: 14, to: 114 },
    { y: 64, knob: 46, from: 14, to: 114 },
    { y: 98, knob: 90, from: 14, to: 114 },
  ];
  drawSliders(canvas, rows, [255, 255, 255], 1.6, 120, 150, 0.9);

  // 文字
  drawText(canvas, 'Dialog Tune', 124, 372, 9, [255, 255, 255]);

  return encodePng(width, height, canvas.data);
}

mkdirSync(resolve(ROOT, 'icons'), { recursive: true });
writeFileSync(resolve(ROOT, 'icons/tune.png'), buildActionIcon());
writeFileSync(resolve(ROOT, 'icons/cover.png'), buildCover());
console.log('icons/tune.png 与 icons/cover.png 已生成');
