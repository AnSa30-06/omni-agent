// Generate installer/assets/omni-agent.ico.
//
// Hand-rolled rather than adding an image dependency: an ICO is a 6-byte header
// plus one 16-byte directory entry per image, and Windows Vista and later accept
// a PNG payload directly, so the whole thing is a PNG with 22 bytes in front.
// The PNG itself is written with zlib, which Node already has.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "installer", "assets");
const SIZE = 256;

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A rounded-square mark: indigo field, white orbit ring, bright centre node. */
function pixels() {
  const rows = [];
  const c = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    // Each PNG scanline is prefixed with its filter type (0 = none).
    const row = Buffer.alloc(SIZE * 4 + 1);
    row[0] = 0;
    for (let x = 0; x < SIZE; x++) {
      const dx = x - c;
      const dy = y - c;
      const r = Math.hypot(dx, dy);

      // Rounded-square background mask.
      const k = 8;
      const inSquare = Math.pow(Math.abs(dx) / (SIZE / 2 - 6), k) + Math.pow(Math.abs(dy) / (SIZE / 2 - 6), k) <= 1;

      let R = 0, G = 0, B = 0, A = 0;
      if (inSquare) {
        // Vertical gradient, deep indigo to violet.
        const t = y / SIZE;
        R = Math.round(40 + 46 * t);
        G = Math.round(38 + 20 * t);
        B = Math.round(96 + 60 * t);
        A = 255;
      }

      // Orbit ring.
      const ringR = SIZE * 0.32;
      const ringW = SIZE * 0.035;
      const dRing = Math.abs(r - ringR);
      if (inSquare && dRing < ringW) {
        const a = 1 - dRing / ringW;
        R = Math.round(R + (236 - R) * a);
        G = Math.round(G + (238 - G) * a);
        B = Math.round(B + (252 - B) * a);
      }

      // Centre node.
      const coreR = SIZE * 0.13;
      if (inSquare && r < coreR) {
        const a = Math.min(1, (coreR - r) / 6);
        R = Math.round(R + (125 - R) * a);
        G = Math.round(G + (211 - G) * a);
        B = Math.round(B + (252 - B) * a);
      }

      // Three satellites on the ring.
      for (const angle of [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6]) {
        const sx = c + Math.cos(angle) * ringR;
        const sy = c + Math.sin(angle) * ringR;
        const ds = Math.hypot(x - sx, y - sy);
        const sr = SIZE * 0.055;
        if (inSquare && ds < sr) {
          const a = Math.min(1, (sr - ds) / 4);
          R = Math.round(R + (255 - R) * a);
          G = Math.round(G + (255 - G) * a);
          B = Math.round(B + (255 - B) * a);
        }
      }

      const o = 1 + x * 4;
      row[o] = R;
      row[o + 1] = G;
      row[o + 2] = B;
      row[o + 3] = A;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function png() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixels(), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 is encoded as 0
  entry[1] = 0; // height 256 likewise
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12); // offset: 6 + 16
  return Buffer.concat([header, entry, pngBuf]);
}

fs.mkdirSync(OUT, { recursive: true });
const p = png();
fs.writeFileSync(path.join(OUT, "omni-agent.png"), p);
fs.writeFileSync(path.join(OUT, "omni-agent.ico"), ico(p));
console.log(`wrote ${path.join(OUT, "omni-agent.ico")} (${(ico(p).length / 1024).toFixed(1)} KB)`);
