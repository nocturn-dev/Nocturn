// Генератор иконок HaloUI: тёмный диск с терракотовым «гало».
// Без внешних зависимостей: PNG собирается вручную (zlib + CRC32),
// ICO — контейнер с BMP-записью 32px и PNG-записью 256px.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ---------- PNG ----------
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- Рисунок ----------
// Курсивная «N» Nocturn (как NocturnMark.tsx) в координатах 24×24
const N_PATH = [
  [4.2, 20.2],
  [7.6, 3.8],
  [16.4, 20.2],
  [19.8, 3.8],
];
// Диагональные «порезы» в стиле референса: линии параллельны среднему штриху N
const CUTS = [
  { x: 5.8, y: 7.6 },
  { x: 18.2, y: 16.2 },
];
const CUT_DIR = (() => {
  const dx = 16.4 - 7.6;
  const dy = 20.2 - 3.8;
  const len = Math.hypot(dx, dy);
  return [dx / len, dy / len];
})();
const CUT_HALF = 0.9; // половина ширины пореза в юнитах 24×24

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function nDist(lx, ly) {
  let d = Infinity;
  for (let i = 0; i < N_PATH.length - 1; i++) {
    const [ax, ay] = N_PATH[i];
    const [bx, by] = N_PATH[i + 1];
    d = Math.min(d, segDist(lx, ly, ax, ay, bx, by));
  }
  return d;
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const bg = [24, 23, 22]; // #181716 — монолитный тёмный квадрат
  const cyan = [56, 199, 238]; // #38C7EE
  const blue = [37, 78, 225]; // #254EE1
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  // Скруглённый квадрат: SDF бокса минус радиус
  const boxHalf = size / 2 - 1;
  const radius = size * 0.2;
  const boxSDF = (px, py) => {
    const dx = Math.abs(px - c) - (boxHalf - radius);
    const dy = Math.abs(py - c) - (boxHalf - radius);
    const ax = Math.max(dx, 0);
    const ay = Math.max(dy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - radius;
  };
  // Буква: крупнее и шире, чем на старом диске. Все величины буквы —
  // в юнитах 24×24 (nd и half в ОДНИХ единицах, иначе штрих плывёт по size)
  const s = (size / 24) * 0.88;
  const halfU = 1.45; // половина толщины штриха, юниты буквы
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sd = boxSDF(x, y);
      let col = null;
      let alpha = 1;
      if (sd < 0.5) {
        col = bg;
        alpha = clamp01(0.5 - sd);
        // буква N
        const lx = 12 + (x - c) / s;
        const ly = 12 + (y - c) / s;
        const nd = nDist(lx, ly);
        if (nd < halfU + 0.08) {
          // порезы: в полосе буква стирается, фон виден насквозь
          let letterA = clamp01(halfU + 0.08 - nd);
          for (const cut of CUTS) {
            const vx = lx - cut.x;
            const vy = ly - cut.y;
            const cd = Math.abs(vx * CUT_DIR[1] - vy * CUT_DIR[0]);
            if (cd < CUT_HALF + 0.15) {
              letterA *= clamp01((cd - CUT_HALF) / 0.15 + 0.5);
            }
          }
          if (letterA > 0) {
            // градиент циан → синий по диагонали (как в логотипе)
            const t = clamp01(((x + y) / (2 * size) - 0.3) / 0.7);
            const n = [
              Math.round(cyan[0] + (blue[0] - cyan[0]) * t),
              Math.round(cyan[1] + (blue[1] - cyan[1]) * t),
              Math.round(cyan[2] + (blue[2] - cyan[2]) * t),
            ];
            col = [
              Math.round(n[0] * letterA + col[0] * (1 - letterA)),
              Math.round(n[1] * letterA + col[1] * (1 - letterA)),
              Math.round(n[2] * letterA + col[2] * (1 - letterA)),
            ];
          }
        }
      }
      if (!col) continue;
      const i = (y * size + x) * 4;
      buf[i] = col[0];
      buf[i + 1] = col[1];
      buf[i + 2] = col[2];
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

// ---------- ICO ----------
function bmpData(size, rgba) {
  const h = Buffer.alloc(40); // BITMAPINFOHEADER
  h.writeUInt32LE(40, 0);
  h.writeInt32LE(size, 4);
  h.writeInt32LE(size * 2, 8); // XOR + AND маска
  h.writeUInt16LE(1, 12);
  h.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4); // BGRA, снизу вверх
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4;
      const di = ((size - 1 - y) * size + x) * 4;
      xor[di] = rgba[si + 2];
      xor[di + 1] = rgba[si + 1];
      xor[di + 2] = rgba[si];
      xor[di + 3] = rgba[si + 3];
    }
  }
  const and = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // прозрачность из альфа-канала
  return Buffer.concat([h, xor, and]);
}

function makeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // тип: icon
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dirs = [];
  const datas = [];
  for (const e of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = e.size % 256;
    dir[2] = e.size % 256;
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(e.data.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirs.push(dir);
    datas.push(e.data);
    offset += e.data.length;
  }
  return Buffer.concat([header, ...dirs, ...datas]);
}

mkdirSync(outDir, { recursive: true });
const png32 = encodePng(32, draw(32));
const png128 = encodePng(128, draw(128));
const png256 = encodePng(256, draw(256));
writeFileSync(join(outDir, "32x32.png"), png32);
writeFileSync(join(outDir, "128x128.png"), png128);
writeFileSync(join(outDir, "128x128@2x.png"), png256);
writeFileSync(
  join(outDir, "icon.ico"),
  makeIco([
    { size: 32, data: bmpData(32, draw(32)) },
    { size: 256, data: png256 },
  ]),
);

// ---------- Классический вариант (диск с тонкой N) — для тумблера в трее ----------
function drawClassic(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const disc = size / 2 - 0.75;
  const bg = [31, 30, 29];
  const cyan = [56, 199, 238];
  const blue = [37, 78, 225];
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const CLASSIC_PATH = [
    [5.4, 19.8],
    [8.7, 4.4],
    [15.3, 19.6],
    [18.6, 4.2],
  ];
  const s = (size / 24) * 0.66;
  const half = (0.55 * size) / 24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      let col = null;
      let alpha = 1;
      if (d < disc) {
        col = bg;
        alpha = clamp01(disc - d + 0.5);
        const lx = 12 + (x - c) / s;
        const ly = 12 + (y - c) / s;
        let nd = Infinity;
        for (let i = 0; i < CLASSIC_PATH.length - 1; i++) {
          const [ax, ay] = CLASSIC_PATH[i];
          const [bx, by] = CLASSIC_PATH[i + 1];
          nd = Math.min(nd, segDist(lx, ly, ax, ay, bx, by));
        }
        if (nd < half + 0.5) {
          const t = clamp01(((x + y) / (2 * size) - 0.3) / 0.7);
          const n = [
            Math.round(cyan[0] + (blue[0] - cyan[0]) * t),
            Math.round(cyan[1] + (blue[1] - cyan[1]) * t),
            Math.round(cyan[2] + (blue[2] - cyan[2]) * t),
          ];
          const a = clamp01(half + 0.5 - nd);
          col = [
            Math.round(n[0] * a + col[0] * (1 - a)),
            Math.round(n[1] * a + col[1] * (1 - a)),
            Math.round(n[2] * a + col[2] * (1 - a)),
          ];
        }
      }
      if (!col) continue;
      const i = (y * size + x) * 4;
      buf[i] = col[0];
      buf[i + 1] = col[1];
      buf[i + 2] = col[2];
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

writeFileSync(join(outDir, "tray-bold.png"), encodePng(32, draw(32)));
writeFileSync(join(outDir, "tray-classic.png"), encodePng(32, drawClassic(32)));
console.log("OK: icons written to", outDir);
