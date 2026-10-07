#!/usr/bin/env node
/**
 * Measure biometric engine startup in real Chrome (Playwright).
 *
 * Needs the web dev server (npm run dev:web) or a preview of a build that
 * serves /diag-engine.html. Runs, each in a fresh profile unless noted:
 *   cold          empty cache, unthrottled
 *   warm          same profile, page reloaded (Cache Storage populated)
 *   offline-warm  same profile, network offline (engine must still start)
 *   cold-3g       empty cache, ~1.6 Mbps / 150 ms RTT
 *   interrupted   empty cache, network cut mid-download, page reloaded, resumed
 *
 * Reports wall time to READY, per-component timings, asset sources and the
 * bytes that crossed the network for /biometric/ (encodedDataLength).
 *
 * Usage: MEASURE_URL=http://localhost:5173/diag-engine.html node scripts/measure-biometric-startup.mjs
 */
import { chromium } from "playwright";

const url = process.env.MEASURE_URL ?? "http://localhost:5173/diag-engine.html";
const only = process.env.MEASURE_ONLY?.split(",");
const TIMEOUT = Number(process.env.MEASURE_TIMEOUT_MS ?? 600_000);
/** Release asset URLs only; the SDK's own modules also live under .../biometric/ in dev. */
const ASSETS = /\/biometric\/[0-9a-f]{16}\//;

const browser = await chromium.launch({ channel: process.env.MEASURE_CHANNEL ?? "chrome", headless: true });

async function instrument(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const urls = new Map();
  const counters = { biometricBytes: 0, biometricRequests: 0 };
  cdp.on("Network.requestWillBeSent", (e) => urls.set(e.requestId, e.request.url));
  cdp.on("Network.loadingFinished", (e) => {
    const u = urls.get(e.requestId) ?? "";
    if (ASSETS.test(u)) {
      counters.biometricBytes += e.encodedDataLength;
      counters.biometricRequests += 1;
    }
  });
  return { cdp, counters };
}

async function runOnce(page, label, counters) {
  counters.biometricBytes = 0;
  counters.biometricRequests = 0;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__TRUSTID_ENGINE_RESULT__), null, { timeout: TIMEOUT });
  const result = await page.evaluate(() => window.__TRUSTID_ENGINE_RESULT__);
  const row = {
    run: label,
    wallMs: Date.now() - t0,
    engineMs: result.totalMs,
    state: result.state,
    source: result.assetSource,
    networkMB: +(counters.biometricBytes / 1048576).toFixed(2),
    requests: counters.biometricRequests,
    timingsMs: result.timingsMs,
    loaderIntegrity: result.loaderIntegrity,
    runtimeInitAttempts: result.runtimeInitAttempts,
    errors: result.errors,
  };
  console.log(JSON.stringify(row));
  return row;
}

const want = (name) => !only || only.includes(name);
const rows = [];

if (want("cold") || want("warm") || want("offline-warm")) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { cdp, counters } = await instrument(page);
  if (want("cold")) rows.push(await runOnce(page, "cold", counters));
  if (want("warm")) rows.push(await runOnce(page, "warm", counters));
  if (want("offline-warm")) {
    // The page shell must still load; take away every biometric asset and
    // runtime loader path (release assets and the legacy /ort, /mediapipe).
    const OFFLINE = /\/biometric\/[0-9a-f]{16}\/|\/ort\/\d|\/mediapipe\/(\d|wasm\/)/;
    await page.route(OFFLINE, (route) => route.abort("internetdisconnected"));
    rows.push(await runOnce(page, "offline-warm", counters));
    await page.unroute(OFFLINE);
  }
  void cdp;
  await context.close();
}

if (want("cold-3g")) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { cdp, counters } = await instrument(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  rows.push(await runOnce(page, "cold-3g", counters));
  await context.close();
}

if (want("interrupted")) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { cdp, counters } = await instrument(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 50,
    downloadThroughput: (8 * 1024 * 1024) / 8,
    uploadThroughput: (2 * 1024 * 1024) / 8,
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Let a few MB arrive, then cut the asset network and abandon the page.
  await page.waitForTimeout(Number(process.env.MEASURE_CUT_AFTER_MS ?? 6_000));
  const before = counters.biometricBytes;
  await page.route(ASSETS, (route) => route.abort("connectionreset"));
  await page.waitForTimeout(1_000);
  await page.unroute(ASSETS);
  console.log(JSON.stringify({ run: "interrupted:first-attempt", networkMB: +(before / 1048576).toFixed(2) }));
  rows.push(await runOnce(page, "interrupted:after-reload", counters));
  await context.close();
}

await browser.close();
console.log("\nSUMMARY");
for (const r of rows) {
  console.log(
    `${r.run.padEnd(26)} ${String(r.engineMs).padStart(7)} ms  ${r.state.padEnd(7)} source=${String(r.source).padEnd(9)} net=${String(r.networkMB).padStart(6)} MB in ${r.requests} req  ${JSON.stringify(r.timingsMs)} loader=${r.loaderIntegrity} initWasm=${r.runtimeInitAttempts}`,
  );
}
if (rows.some((r) => r.state !== "READY")) process.exitCode = 2;
