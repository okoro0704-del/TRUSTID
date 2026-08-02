import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "../apps/web/public");

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}

function png(size, file) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const i = 1 + x * 3;
      const cx = size / 2;
      const cy = size / 2;
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r < size * 0.42) {
        row[i] = 11;
        row[i + 1] = 61;
        row[i + 2] = 58;
      } else {
        row[i] = 7;
        row[i + 1] = 30;
        row[i + 2] = 28;
      }
      if (r > size * 0.18 && r < size * 0.28 && dy < 0) {
        row[i] = 231;
        row[i + 1] = 194;
        row[i + 2] = 125;
      }
    }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  fs.writeFileSync(
    file,
    Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]),
  );
}

fs.mkdirSync(outDir, { recursive: true });
png(192, path.join(outDir, "pwa-192.png"));
png(512, path.join(outDir, "pwa-512.png"));
console.log("PWA icons written");
