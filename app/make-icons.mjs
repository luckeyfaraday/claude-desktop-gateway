#!/usr/bin/env node
// Generates the tray icons with no third-party dependencies by writing PNGs by hand.
// Two states: green (gateway healthy) and gray (stopped / unhealthy).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(here, "assets");

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size, pixel) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function circleIcon(size, [r, g, b]) {
  const c = (size - 1) / 2;
  const outer = size * 0.46;
  const inner = size * 0.2;
  return png(size, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    // Anti-aliased filled disc with a small darker rim for contrast on light/dark trays.
    const fill = Math.max(0, Math.min(1, outer - d + 0.5));
    const ring = Math.max(0, Math.min(1, outer - d + 0.5)) * (d > outer - 1.6 ? 0.55 : 1);
    void inner;
    const a = Math.round(fill * 255);
    const shade = d > outer - 1.6 ? 0.7 : 1;
    return [Math.round(r * shade), Math.round(g * shade), Math.round(b * shade), Math.round(ring * 0 + a)];
  });
}

fs.mkdirSync(assetsDir, { recursive: true });
const variants = {
  "tray-active": [52, 199, 89],
  "tray-idle": [142, 142, 147],
};
for (const [name, color] of Object.entries(variants)) {
  for (const size of [22, 44]) {
    const suffix = size === 22 ? "" : "@2x";
    fs.writeFileSync(path.join(assetsDir, `${name}${suffix}.png`), circleIcon(size, color));
  }
  // A larger app icon reuses the active color.
}
// electron-builder requires the mac icns source to be at least 512x512.
fs.writeFileSync(path.join(assetsDir, "icon.png"), circleIcon(1024, [52, 199, 89]));
console.log(`Wrote tray icons to ${assetsDir}`);
