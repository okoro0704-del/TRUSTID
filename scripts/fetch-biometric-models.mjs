#!/usr/bin/env node
/**
 * Fetch TrustID biometric model artifacts with SHA-256 verification.
 * Output: apps/web/public/models/trustid/
 *
 * Usage: node scripts/fetch-biometric-models.mjs
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "../apps/web/public/models/trustid");

const ARTIFACTS = [
  {
    id: "w600k_mbf",
    file: "w600k_mbf.onnx",
    url: "https://huggingface.co/deepghs/insightface/resolve/main/buffalo_s/w600k_mbf.onnx",
    sha256: "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f",
  },
  {
    id: "face_landmarker",
    file: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    sha256: null, // recorded after download
  },
];

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error("No body");
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const manifest = { fetchedAt: new Date().toISOString(), artifacts: [] };

  for (const art of ARTIFACTS) {
    const dest = join(outDir, art.file);
    if (!existsSync(dest)) {
      await download(art.url, dest);
    } else {
      console.log(`Exists: ${art.file}`);
    }
    const digest = sha256File(dest);
    if (art.sha256 && digest !== art.sha256) {
      throw new Error(
        `Integrity failed for ${art.file}: expected ${art.sha256}, got ${digest}`,
      );
    }
    console.log(`OK ${art.file} sha256=${digest}`);
    manifest.artifacts.push({
      id: art.id,
      file: art.file,
      sha256: digest,
      source: art.url,
    });
  }

  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${join(outDir, "manifest.json")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
