/**
 * Structurally valid image fixtures carrying metadata that must be stripped
 * (EXIF/GPS, text chunks, comments) and trailing payloads that must be dropped.
 */
import { deflateSync } from "node:zlib";

export const SECRET_METADATA = "GPS-SECRET-51.5074N";
export const TRAILING_PAYLOAD = "TRAILING-PAYLOAD";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function pngFixture(opts: { width?: number; height?: number; animated?: boolean; trailing?: boolean } = {}) {
  const width = opts.width ?? 96;
  const height = opts.height ?? 96;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x7f);
  for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0; // filter: none
  const chunks = [
    pngChunk("IHDR", ihdr),
    ...(opts.animated ? [pngChunk("acTL", Buffer.alloc(8))] : []),
    pngChunk("tEXt", Buffer.from(`Comment\0${SECRET_METADATA}`, "latin1")),
    pngChunk("eXIf", Buffer.from(`MM\0*${SECRET_METADATA}`, "latin1")),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks,
    ...(opts.trailing === false ? [] : [Buffer.from(TRAILING_PAYLOAD)]),
  ]);
}

function jpegSegment(marker: number, data: Buffer) {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

export function jpegFixture(opts: { width?: number; height?: number } = {}) {
  const width = opts.width ?? 128;
  const height = opts.height ?? 128;
  const sof = Buffer.from([8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0]);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  const dht = Buffer.concat([Buffer.from([0x00, 1]), Buffer.alloc(15), Buffer.from([0])]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    jpegSegment(0xe1, Buffer.from(`Exif\0\0${SECRET_METADATA}`, "latin1")),
    jpegSegment(0xfe, Buffer.from(`camera serial ${SECRET_METADATA}`, "latin1")),
    jpegSegment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    jpegSegment(0xc0, sof),
    jpegSegment(0xc4, dht),
    jpegSegment(0xda, Buffer.from([3, 1, 0, 2, 0, 3, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]),
    Buffer.from([0xff, 0xd9]),
    Buffer.from(TRAILING_PAYLOAD),
  ]);
}

function riffChunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.write(type, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

export function webpFixture(opts: { width?: number; height?: number; animated?: boolean } = {}) {
  const width = opts.width ?? 100;
  const height = opts.height ?? 80;
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04 | (opts.animated ? 0x02 : 0); // EXIF + XMP (+ animation)
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const vp8l = Buffer.alloc(16);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  const body = Buffer.concat([
    riffChunk("VP8X", vp8x),
    riffChunk("VP8L", vp8l),
    riffChunk("EXIF", Buffer.from(SECRET_METADATA, "latin1")),
    riffChunk("XMP ", Buffer.from(`<x>${SECRET_METADATA}</x>`, "latin1")),
  ]);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

export const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;
