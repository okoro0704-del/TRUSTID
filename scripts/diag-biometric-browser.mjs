import { chromium } from "playwright";

const url = process.env.DIAG_URL ?? "http://localhost:5174/diag-biometric.html";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const events = [];
page.on("console", (msg) => {
  const text = msg.text();
  if (
    text.includes("face_capture_diag") ||
    text.includes("[TrustID]") ||
    text.includes("[diag]")
  ) {
    events.push(text);
    console.log(text);
  }
});
page.on("pageerror", (err) => {
  console.error("PAGE_ERROR", err.message);
  events.push(`PAGE_ERROR ${err.message}`);
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForFunction(
  () => Boolean(window.__TRUSTID_DIAG_RESULT__),
  null,
  { timeout: 120_000 },
);
const result = await page.evaluate(() => window.__TRUSTID_DIAG_RESULT__);
const body = await page.locator("#out").innerText();
console.log("\n=== RESULT ===");
console.log(JSON.stringify(result, null, 2));
console.log("\n=== PAGE BODY ===");
console.log(body);
await browser.close();

if (!result?.ready) {
  process.exitCode = 2;
}
