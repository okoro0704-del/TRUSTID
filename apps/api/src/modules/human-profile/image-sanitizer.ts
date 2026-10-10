/**
 * Structural validation and metadata stripping for user images (profile
 * avatars, identity documents) without a native image codec.
 *
 * The container is parsed end to end: magic bytes must match the format,
 * every segment/chunk must be well formed, dimensions must be sane, and
 * anything after the end marker is dropped. Metadata (EXIF incl. GPS, XMP,
 * ICC, comments, text chunks) is removed. Pixel data is not decoded here; the
 * web client re-encodes through a canvas before upload, and served bytes are
 * always sent with a fixed content type and nosniff.
 */

export type SanitizedImage = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Buffer;
  width: number;
  height: number;
};

export type ImageLimits = {
  maxBytes: number;
  minDimension: number;
  maxDimension: number;
};

export class ImageValidationError extends Error {
  readonly statusCode = 400;
  readonly code = "invalid_image";
}

function fail(message: string): never {
  throw new ImageValidationError(message);
}

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** Strict data-URL decode: canonical base64 only, declared type must be an allowed image type. */
export function decodeImageDataUrl(dataUrl: string): { declaredType: string; bytes: Buffer } {
  const match = DATA_URL.exec(dataUrl.trim());
  if (!match) fail("Expected a base64 JPEG, PNG or WebP data URL");
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.toString("base64") !== match[2]) fail("Malformed base64 image data");
  return { declaredType: match[1]!, bytes };
}

export function sanitizeImage(input: Buffer, declaredType: string, limits: ImageLimits): SanitizedImage {
  if (input.byteLength > limits.maxBytes) fail("Image is too large");
  if (input.byteLength < 32) fail("Image is too small");
  const detected = detectType(input);
  if (!detected) fail("Unsupported or unrecognised image format");
  if (detected !== declaredType) fail("Image content does not match its declared type");
  const result =
    detected === "image/jpeg" ? sanitizeJpeg(input) :
    detected === "image/png" ? sanitizePng(input) :
    sanitizeWebp(input);
  const { width, height } = result;
  if (width < limits.minDimension || height < limits.minDimension) fail("Image dimensions are too small");
  if (width > limits.maxDimension || height > limits.maxDimension) fail("Image dimensions are too large");
  return { mimeType: detected, ...result };
}

function detectType(b: Buffer): SanitizedImage["mimeType"] | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// ---------------------------------------------------------------- JPEG

/** Markers with no length field. */
const isStandalone = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);
/** SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function sanitizeJpeg(b: Buffer): { bytes: Buffer; width: number; height: number } {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  for (;;) {
    if (i >= b.length) fail("Truncated JPEG");
    if (b[i] !== 0xff) fail("Malformed JPEG marker");
    while (b[i] === 0xff) i += 1; // fill bytes
    const marker = b[i++];
    if (marker === undefined) fail("Truncated JPEG");
    if (marker === 0xd9) {
      if (!sawScan || !width) fail("JPEG has no image data");
      out.push(Buffer.from([0xff, 0xd9]));
      return { bytes: Buffer.concat(out), width, height };
    }
    if (marker === 0xd8 || marker === 0x00) fail("Malformed JPEG marker");
    if (isStandalone(marker)) {
      out.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (i + 2 > b.length) fail("Truncated JPEG");
    const len = b.readUInt16BE(i);
    if (len < 2 || i + len > b.length) fail("Malformed JPEG segment");
    const segment = b.subarray(i - 2, i + len);
    i += len;
    if (isSof(marker)) {
      if (len < 8) fail("Malformed JPEG frame header");
      height = segment.readUInt16BE(5);
      width = segment.readUInt16BE(7);
      if (!width || !height) fail("JPEG has no dimensions");
    }
    // Drop APP1..APP15 (EXIF/GPS, XMP, ICC, vendor data) and COM. APP0 (JFIF) is kept.
    const metadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!metadata) out.push(segment);
    if (marker === 0xda) {
      if (!width) fail("JPEG scan before frame header");
      sawScan = true;
      // Entropy-coded data runs to the next marker that is not stuffing or RSTn.
      const start = i;
      while (i < b.length) {
        if (b[i] === 0xff && i + 1 < b.length) {
          const next = b[i + 1]!;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        i += 1;
      }
      if (i >= b.length) fail("Truncated JPEG scan");
      out.push(b.subarray(start, i));
    }
  }
}

// ---------------------------------------------------------------- PNG

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Rendering chunks kept; text, time, EXIF, ICC and APNG animation chunks are dropped. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "bKGD"]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function sanitizePng(b: Buffer): { bytes: Buffer; width: number; height: number } {
  const out: Buffer[] = [PNG_SIGNATURE];
  let i = 8;
  let width = 0;
  let height = 0;
  let first = true;
  let sawData = false;
  for (;;) {
    if (i + 12 > b.length) fail("Truncated PNG");
    const len = b.readUInt32BE(i);
    if (len > 0x7fffffff || i + 12 + len > b.length) fail("Malformed PNG chunk");
    const type = b.toString("latin1", i + 4, i + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) fail("Malformed PNG chunk type");
    const chunk = b.subarray(i, i + 12 + len);
    if (crc32(b.subarray(i + 4, i + 8 + len)) !== b.readUInt32BE(i + 8 + len)) fail("Corrupt PNG chunk");
    i += 12 + len;
    if (first) {
      if (type !== "IHDR" || len !== 13) fail("PNG must start with IHDR");
      width = chunk.readUInt32BE(8);
      height = chunk.readUInt32BE(12);
      first = false;
    }
    if (type === "acTL") fail("Animated images are not supported");
    if (type === "IDAT") sawData = true;
    const critical = type.charCodeAt(0) < 0x61; // uppercase first letter
    if (critical && !PNG_KEEP.has(type)) fail("Unsupported PNG chunk");
    if (PNG_KEEP.has(type)) out.push(chunk);
    if (type === "IEND") {
      if (!sawData) fail("PNG has no image data");
      return { bytes: Buffer.concat(out), width, height };
    }
  }
}

// ---------------------------------------------------------------- WebP

const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH"]);

function sanitizeWebp(b: Buffer): { bytes: Buffer; width: number; height: number } {
  const riffSize = b.readUInt32LE(4);
  if (riffSize + 8 > b.length || riffSize < 12) fail("Malformed WebP");
  const end = 8 + riffSize;
  const chunks: Buffer[] = [];
  let width = 0;
  let height = 0;
  let i = 12;
  let sawImage = false;
  while (i < end) {
    if (i + 8 > end) fail("Truncated WebP chunk");
    const type = b.toString("latin1", i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const padded = len + (len & 1);
    if (i + 8 + len > end) fail("Malformed WebP chunk");
    const data = b.subarray(i + 8, i + 8 + len);
    if (type === "ANIM" || type === "ANMF") fail("Animated images are not supported");
    if (type === "VP8X") {
      if (len < 10) fail("Malformed WebP header");
      if (data[0]! & 0x02) fail("Animated images are not supported");
      const header = Buffer.from(b.subarray(i, i + 8 + padded));
      // Clear ICC (0x20), EXIF (0x08) and XMP (0x04) flags; those chunks are dropped.
      header[8] = data[0]! & ~(0x20 | 0x08 | 0x04);
      width = 1 + data.readUIntLE(4, 3);
      height = 1 + data.readUIntLE(7, 3);
      chunks.push(header);
    } else if (WEBP_KEEP.has(type)) {
      if (type === "VP8 ") {
        if (len < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) fail("Malformed VP8 frame");
        if (!width) {
          width = data.readUInt16LE(6) & 0x3fff;
          height = data.readUInt16LE(8) & 0x3fff;
        }
        sawImage = true;
      } else if (type === "VP8L") {
        if (len < 5 || data[0] !== 0x2f) fail("Malformed VP8L frame");
        if (!width) {
          const bits = data.readUInt32LE(1);
          width = (bits & 0x3fff) + 1;
          height = ((bits >>> 14) & 0x3fff) + 1;
        }
        sawImage = true;
      }
      chunks.push(b.subarray(i, i + 8 + padded));
    }
    i += 8 + padded;
  }
  if (!sawImage) fail("WebP has no image data");
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  return { bytes: Buffer.concat([header, body]), width, height };
}
