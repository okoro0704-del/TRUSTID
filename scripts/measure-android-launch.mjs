#!/usr/bin/env node
/**
 * App launch -> face recognition READY, with no user action (prewarm).
 *
 * Needs a debug build of the shell (DevTools-enabled WebView). Enables the
 * SDK's metadata-only diagnostics timeline, then force-stops and relaunches
 * the app several times and reads, per launch: activity launch time, when the
 * engine reached READY (page time), where every biometric asset came from,
 * and how many bundled files were hashed.
 *
 * Usage: ANDROID_SERIAL=<serial> node scripts/measure-android-launch.mjs [--apk <path>] [--launches 3] [--wait-ms 15000]
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const APP = "com.trustid.device";
const PORT = 9335;
const sdk = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
const ADB = join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const adb = (...a) =>
  execFileSync(ADB, a, { encoding: "utf8", timeout: a[0] === "install" ? 300_000 : 30_000 }).replace(/\r/g, "").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidOf = () => {
  try {
    return adb("shell", "pidof", APP);
  } catch {
    return "";
  }
};

async function attach() {
  let pid = "";
  for (let i = 0; i < 40 && !pid; i++) {
    pid = pidOf();
    if (!pid) await sleep(250);
  }
  const socket = adb("shell", "cat", "/proc/net/unix").match(new RegExp(`@(webview_devtools_remote_${pid})`))?.[1];
  if (!socket) throw new Error("WebView DevTools socket not found");
  try {
    adb("forward", "--remove", `tcp:${PORT}`);
  } catch {
    /* none */
  }
  adb("forward", `tcp:${PORT}`, `localabstract:${socket}`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /^https:\/\//.test(p.url()));
  if (!page) throw new Error("app page not found");
  return { browser, page };
}

async function main() {
  const apk = opt("--apk");
  if (apk) adb("install", "-r", apk);
  const launches = Number(opt("--launches", "3"));
  const waitMs = Number(opt("--wait-ms", "15000"));

  // Enable the metadata-only timeline (persists in the app's storage).
  adb("shell", "am", "start", "-W", "-n", `${APP}/.MainActivity`);
  {
    const { browser, page } = await attach();
    await page.evaluate(() => localStorage.setItem("TRUSTID_FACE_CAPTURE_DIAG", "1"));
    await browser.close();
  }

  const rows = [];
  for (let n = 1; n <= launches; n++) {
    adb("shell", "am", "force-stop", APP);
    await sleep(800);
    const out = adb("shell", "am", "start", "-W", "-n", `${APP}/.MainActivity`);
    const launchMs = Number(out.match(/TotalTime:\s*(\d+)/)?.[1] ?? NaN);
    await sleep(waitMs);
    const { browser, page } = await attach();
    const r = await page.evaluate(() => {
      const tl = window.__TRUSTID_BIOMETRIC_TIMELINE__ ?? [];
      const at = (stage) => tl.find((e) => e.stage === stage)?.t ?? null;
      const res = performance.getEntriesByType("resource").map((e) => e.name);
      const assets = res.filter((u) => /\/biometric\/[0-9a-f]{16}\//.test(u) || /\/models\/trustid\/|\/ort\/\d|\/mediapipe\/\d/.test(u));
      return {
        page: location.href,
        firstEventMs: tl[0]?.t ?? null,
        runtimeReadyMs: at("readiness_runtime_ready"),
        detectorReadyMs: at("readiness_detector_ready"),
        embedderReadyMs: at("readiness_embedder_ready"),
        engineReadyMs: at("readiness_warmup_ready"),
        failures: tl.filter((e) => e.success === false).map((e) => `${e.stage}:${e.errorCode ?? ""}`),
        bundledAssetRequests: assets.filter((u) => u.includes("/__trustid_native__/")).length,
        remoteAssetRequests: assets.filter((u) => !u.includes("/__trustid_native__/")).length,
        initWasmEvents: tl.filter((e) => e.stage === "ort_runtime_ready").length,
        screen: document.body.innerText.replace(/\s+/g, " ").slice(0, 120),
      };
    });
    await browser.close();
    rows.push({ launch: n, launchMs, ...r });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
  try {
    adb("forward", "--remove", `tcp:${PORT}`);
  } catch {
    /* none */
  }
  console.log("\nlaunch  activity  engine-READY(page)  bundled  remote  initWasm  failures");
  for (const r of rows) {
    console.log(
      `${String(r.launch).padEnd(7)} ${String(r.launchMs).padStart(6)}ms ${String(r.engineReadyMs ?? "-").padStart(10)}ms ${String(r.bundledAssetRequests).padStart(10)} ${String(r.remoteAssetRequests).padStart(7)} ${String(r.initWasmEvents).padStart(9)}  ${r.failures.join(",") || "-"}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
