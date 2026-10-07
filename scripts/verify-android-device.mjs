#!/usr/bin/env node
/**
 * Biometric Delivery V2: Android device verification harness.
 *
 * Drives one connected device (adb) and the app's debug WebView over the
 * DevTools protocol (Playwright connectOverCDP). Needs the verification APK:
 * a debug build with the bundled web shell and the diagnostics page,
 *
 *   CAP_USE_LIVE_WEB=0 TRUSTID_DEVICE_DIAG=1 npm run cap:sync:device -w @trustid/device
 *   (cd apps/device/android && ./gradlew assembleDebug)
 *
 * so the app runs the V2 SDK even though the live site is not deployed.
 *
 * Records no personal identifiers (no serial, IMEI, account) and never reads
 * frames or embeddings: the diagnostics page reports timings, sources, states
 * and result codes only.
 *
 * Usage:
 *   node scripts/verify-android-device.mjs --apk <path> [--fresh] [--scan] [--reboot] [--skip-install]
 *
 * --fresh uninstalls first (deletes the app's data), --scan opens the camera,
 * --reboot reboots the device: each only with the device owner's consent.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const APP = "com.trustid.device";
const ACTIVITY = `${APP}/.MainActivity`;
const ORIGIN = "https://localhost";
const DIAG = `${ORIGIN}/diag-engine.html`;
const PORT = 9333;
const RELEASE_ASSET = /\/biometric\/[0-9a-f]{16}\//;
const LEGACY_ASSET = /\/(models\/trustid\/|ort\/\d|mediapipe\/(\d|wasm\/))/;
const sdk = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
const ADB = join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");

/** adb with a timeout so a stuck device cannot hang the run; installs get longer. */
const adb = (...a) => execFileSync(ADB, a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: a[0] === "install" ? 180_000 : 30_000 }).replace(/\r/g, "").trim();
/** pidof exits 1 when the process is not running: that is an answer, not an error. */
const pidOf = () => {
  try {
    return adb("shell", "pidof", APP);
  } catch {
    return "";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { device: {}, apk: {}, runs: [], checks: {} };
const log = (o) => console.log(JSON.stringify(o));

function deviceInfo() {
  const devices = adb("devices").split("\n").slice(1).filter((l) => /\tdevice$/.test(l));
  // ANDROID_SERIAL (honoured by adb) selects the device when several are
  // attached; the serial itself is never recorded.
  if (!process.env.ANDROID_SERIAL && devices.length !== 1) {
    throw new Error(`need exactly one device (or ANDROID_SERIAL), found ${devices.length}`);
  }
  const prop = (p) => adb("shell", "getprop", p);
  const memKb = Number(adb("shell", "cat", "/proc/meminfo").match(/MemTotal:\s+(\d+)/)?.[1] ?? 0);
  report.device = {
    manufacturer: prop("ro.product.manufacturer"),
    model: prop("ro.product.model"),
    android: prop("ro.build.version.release"),
    sdk: prop("ro.build.version.sdk"),
    abi: prop("ro.product.cpu.abi"),
    emulator: prop("ro.kernel.qemu") === "1" || prop("ro.boot.qemu") === "1",
    ramMB: Math.round(memKb / 1024),
    webview: adb("shell", "dumpsys", "package", "com.google.android.webview").match(/versionName=(\S+)/)?.[1] ?? "unknown",
  };
  log({ device: report.device });
}

/** Every pinned release asset inside the APK must hash to its directory name and release.json. */
function verifyApk(apkPath) {
  report.apk.path = apkPath;
  report.apk.bytes = statSync(apkPath).size;
  const listing = execFileSync("unzip", ["-l", apkPath], { encoding: "utf8" });
  const files = [...listing.matchAll(/assets\/public\/biometric\/([0-9a-f]{16})\/(\S+)/g)].map((m) => ({ dir: m[1], file: m[2] }));
  const release = JSON.parse(execFileSync("unzip", ["-p", apkPath, "assets/public/biometric/release.json"], { encoding: "utf8" }));
  report.apk.assets = release.assets.map((a) => {
    const dir = a.sha256.slice(0, 16);
    const present = files.some((f) => f.dir === dir && f.file === a.file);
    const bytes = present ? execFileSync("unzip", ["-p", apkPath, `assets/public/biometric/${dir}/${a.file}`], { maxBuffer: 64 * 1024 * 1024 }) : Buffer.alloc(0);
    const actual = createHash("sha256").update(bytes).digest("hex");
    return { id: a.id, expected: a.sha256, actual, ok: present && actual === a.sha256 };
  });
  report.apk.compressedCopies = (listing.match(/\.gz\.bin/g) ?? []).length;
  report.checks.apkHashes = report.apk.assets.every((a) => a.ok) && report.apk.compressedCopies === 0;
  log({ apk: report.apk });
}

function launch() {
  const out = adb("shell", "am", "start", "-W", "-n", ACTIVITY);
  return Number(out.match(/TotalTime:\s*(\d+)/)?.[1] ?? NaN);
}

async function connect() {
  let pid = "";
  for (let i = 0; i < 40 && !pid; i++) {
    pid = pidOf();
    if (!pid) await sleep(250);
  }
  if (!pid) throw new Error("app did not start");
  let socket = "";
  for (let i = 0; i < 40 && !socket; i++) {
    socket = adb("shell", "cat", "/proc/net/unix").match(new RegExp(`@(webview_devtools_remote_${pid})`))?.[1] ?? "";
    if (!socket) await sleep(250);
  }
  if (!socket) throw new Error("WebView DevTools socket not found (debug build required)");
  try {
    adb("forward", "--remove", `tcp:${PORT}`);
  } catch {
    /* none */
  }
  adb("forward", `tcp:${PORT}`, `localabstract:${socket}`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(ORIGIN));
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("app page not found");
  return { browser, page };
}

/** Load the diagnostics page and classify every asset request it makes. */
async function diagRun(page, label, { scan = false, appLaunchMs = null } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const urls = new Map();
  const net = { remoteAssetBytes: 0, remoteAssetRequests: 0, bundledRequests: 0, bundledBytes: 0, other: 0 };
  const console_ = [];
  cdp.on("Network.requestWillBeSent", (e) => urls.set(e.requestId, e.request.url));
  cdp.on("Network.loadingFinished", (e) => {
    const u = urls.get(e.requestId) ?? "";
    if (u.includes("/__trustid_native__/")) {
      net.bundledRequests += 1;
      net.bundledBytes += e.encodedDataLength;
    } else if (!u.startsWith(ORIGIN) && (RELEASE_ASSET.test(u) || LEGACY_ASSET.test(u))) {
      net.remoteAssetRequests += 1;
      net.remoteAssetBytes += e.encodedDataLength;
    } else if (!u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:")) {
      net.other += 1;
    }
  });
  const onConsole = (m) => {
    const t = m.text();
    if (/conformance|initWasm|multiple calls|RUNTIME_FAILED/i.test(t)) console_.push(t.slice(0, 300));
  };
  page.on("console", onConsole);
  await page.evaluate(() => localStorage.setItem("TRUSTID_FACE_CAPTURE_DIAG", "1")).catch(() => undefined);
  const t0 = Date.now();
  await page.goto(scan ? `${DIAG}?scan=1` : DIAG, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__TRUSTID_ENGINE_RESULT__), null, { timeout: 300_000 });
  const engine = await page.evaluate(() => window.__TRUSTID_ENGINE_RESULT__);
  let scanResult = null;
  if (scan && engine.state === "READY") {
    await page.waitForFunction(() => Boolean(window.__TRUSTID_SCAN_RESULT__), null, { timeout: 60_000 }).catch(() => undefined);
    scanResult = await page.evaluate(() => window.__TRUSTID_SCAN_RESULT__ ?? null);
  }
  page.off("console", onConsole);
  await cdp.detach().catch(() => undefined);
  const cosine = console_.map((t) => t.match(/cosine=([\d.]+)/)?.[1]).find(Boolean) ?? null;
  const row = {
    run: label,
    appLaunchMs,
    wallMs: Date.now() - t0,
    engineMs: engine.totalMs,
    state: engine.state,
    assetSource: engine.assetSource,
    flags: engine.flags,
    timingsMs: engine.timingsMs,
    states: engine.states,
    loaderIntegrity: engine.loaderIntegrity,
    runtimeInitAttempts: engine.runtimeInitAttempts,
    conformanceCosine: cosine ? Number(cosine) : null,
    duplicateInitWasm: console_.some((t) => /multiple calls to 'initWasm\(\)'|previous call to 'initWasm\(\)' failed/.test(t)),
    network: net,
    scan: scanResult,
    errors: engine.errors,
  };
  report.runs.push(row);
  log(row);
  return row;
}

async function coldStart(label, opts = {}) {
  adb("shell", "am", "force-stop", APP);
  await sleep(500);
  const appLaunchMs = launch();
  const { browser, page } = await connect();
  const row = await diagRun(page, label, { ...opts, appLaunchMs });
  await browser.close().catch(() => undefined);
  return row;
}

/** Turn off only the radios that are on, and later restore exactly that state. */
function networkOff() {
  const original = {
    wifi: adb("shell", "settings", "get", "global", "wifi_on") !== "0",
    data: adb("shell", "settings", "get", "global", "mobile_data") === "1",
  };
  if (original.wifi) adb("shell", "svc", "wifi", "disable");
  if (original.data) adb("shell", "svc", "data", "disable");
  return () => {
    if (original.wifi) adb("shell", "svc", "wifi", "enable");
    if (original.data) adb("shell", "svc", "data", "enable");
  };
}

async function main() {
  deviceInfo();
  const apk = opt("--apk");
  if (!apk) throw new Error("--apk <path> required");
  verifyApk(apk);
  if (!flag("--skip-install")) {
    // --fresh deletes the app's local data on the device; only with consent.
    if (flag("--fresh")) {
      try {
        adb("uninstall", APP);
      } catch {
        /* not installed */
      }
    }
    adb("install", "-r", apk);
  }
  if (flag("--scan") || flag("--scan-only")) {
    // Some OEM builds (ColorOS) refuse shell grants; a permission the user
    // already granted is enough.
    try {
      adb("shell", "pm", "grant", APP, "android.permission.CAMERA");
    } catch {
      const granted = /android\.permission\.CAMERA: granted=true/.test(adb("shell", "dumpsys", "package", APP));
      if (!granted) throw new Error("camera permission not granted and cannot be granted from adb");
    }
  }

  // --scan-only: camera -> face -> quality -> embedding timing, cold then warm.
  if (flag("--scan-only")) {
    await coldStart("scan:cold", { scan: true });
    {
      const { browser, page } = await connect();
      await diagRun(page, "scan:warm", { scan: true });
      await browser.close().catch(() => undefined);
    }
    for (const r of report.runs) {
      console.log(`${r.run.padEnd(10)} engine=${r.engineMs}ms ${r.state} src=${r.assetSource} remote=${r.network.remoteAssetBytes}B cos=${r.conformanceCosine} scan=${JSON.stringify(r.scan)}`);
    }
    return;
  }

  // --from-recreation resumes a run after the install/cold/warm phases.
  const fromRecreation = flag("--from-recreation") || flag("--offline-only");
  if (!fromRecreation) {
  // Fresh install, network connected: bundled assets must still be chosen.
  await coldStart("cold:first-launch");
  await coldStart("cold:force-stop");

  // Warm: re-enter the biometric page in the same process, several times.
  {
    const { browser, page } = await connect();
    for (let i = 1; i <= 3; i++) await diagRun(page, `warm:reenter-${i}`);
    // Background and restore: the running engine must stay READY.
    adb("shell", "input", "keyevent", "KEYCODE_HOME");
    await sleep(3_000);
    launch();
    await sleep(1_500);
    const restored = await page.evaluate(() => window.__TRUSTID_ENGINE_RESULT__?.state ?? null);
    report.checks.backgroundRestoreState = restored;
    log({ backgroundRestore: restored });
    // Rapid re-entry: navigate in and out five times without waiting.
    for (let i = 0; i < 5; i++) {
      await page.goto(DIAG, { waitUntil: "commit" }).catch(() => undefined);
      await sleep(300);
      await page.goto(`${ORIGIN}/`, { waitUntil: "commit" }).catch(() => undefined);
      await sleep(200);
    }
    const rapid = await diagRun(page, "rapid-reentry:final");
    // Concurrent initialize() calls sharing one pass is covered by the SDK unit tests.
    report.checks.rapidReentry = rapid.state === "READY" && rapid.runtimeInitAttempts <= 1 && !rapid.duplicateInitWasm;
    await browser.close().catch(() => undefined);
  }

  }

  if (flag("--scan")) await coldStart("scan:camera", { scan: true });

  // Process recreation: kill the backgrounded process, then return.
  if (!flag("--offline-only")) {
    launch();
    await sleep(2_000);
    adb("shell", "input", "keyevent", "KEYCODE_HOME");
    await sleep(2_000);
    adb("shell", "am", "kill", APP);
    await sleep(1_000);
    report.checks.processKilled = pidOf() === "";
    const appLaunchMs = launch();
    const { browser, page } = await connect();
    await diagRun(page, "process-recreation", { appLaunchMs });
    await browser.close().catch(() => undefined);
  }

  // Network off: local engine yes, identification no.
  const restoreNetwork = networkOff();
  await sleep(3_000);
  // "Active default network: none" means the device has no route at all.
  const activeNetwork = adb("shell", "dumpsys", "connectivity").split("\n").find((l) => l.includes("Active default network")) ?? "";
  report.checks.offlineConfirmed = /none/i.test(activeNetwork);
  log({ offlineConfirmed: report.checks.offlineConfirmed });
  try {
    const off = await coldStart("offline:engine");
    report.checks.offlineEngine =
      off.state === "READY" && off.flags.BIOMETRIC_ENGINE_READY === true && off.flags.IDENTIFICATION_AVAILABLE === false;
  } catch (err) {
    log({ offlineError: String(err).slice(0, 400) });
    report.checks.offlineEngine = false;
  } finally {
    restoreNetwork();
  }

  if (flag("--reboot")) {
    adb("reboot");
    adb("wait-for-device");
    while (adb("shell", "getprop", "sys.boot_completed") !== "1") await sleep(2_000);
    await sleep(5_000);
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    await coldStart("reboot:first-launch");
  }

  const runs = report.runs;
  report.checks.zeroRemoteAssetBytes = runs.every((r) => r.network.remoteAssetBytes === 0 && r.network.remoteAssetRequests === 0);
  report.checks.allFromAppBundle = runs.every((r) => r.assetSource === "app-bundle");
  report.checks.allReady = runs.every((r) => r.state === "READY");
  report.checks.conformance = runs.every((r) => r.conformanceCosine == null || r.conformanceCosine >= 0.9999);
  report.checks.conformanceObserved = runs.filter((r) => r.conformanceCosine != null).map((r) => r.conformanceCosine);
  report.checks.noDuplicateInitWasm = !runs.some((r) => r.duplicateInitWasm || r.runtimeInitAttempts > 1);
  report.checks.loaderVerified = runs.every((r) => r.loaderIntegrity === "sha256");
  console.log("\nREPORT");
  console.log(JSON.stringify({ device: report.device, apkBytes: report.apk.bytes, checks: report.checks }, null, 2));
  console.log("\nRUNS");
  for (const r of runs) {
    console.log(
      `${r.run.padEnd(22)} launch=${String(r.appLaunchMs ?? "-").padStart(5)}ms engine=${String(r.engineMs).padStart(6)}ms ${r.state.padEnd(7)} src=${String(r.assetSource).padEnd(10)} remote=${r.network.remoteAssetBytes}B bundled=${r.network.bundledRequests}req cos=${r.conformanceCosine ?? "-"} initWasm=${r.runtimeInitAttempts} ${JSON.stringify(r.timingsMs)}${r.scan ? ` scan=${JSON.stringify(r.scan)}` : ""}`,
    );
  }
  const failed = Object.entries(report.checks).filter(([, v]) => v === false).map(([k]) => k);
  if (failed.length) {
    console.log(`FAILED CHECKS: ${failed.join(", ")}`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
