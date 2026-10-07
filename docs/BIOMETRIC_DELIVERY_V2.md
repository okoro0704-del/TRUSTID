# TrustID Biometric Delivery V2

How TrustID gets its face-recognition engine onto a device, and how it proves
the engine computes the TrustID embedding space before any face is embedded.

## What the 37.7 MB was

Before V2 every page load that lacked a cached copy downloaded four binaries,
each in 256 KiB `Range` requests with `cache: "no-store"`:

| Asset | Bytes | gzip -9 | Purpose |
|---|---:|---:|---|
| `ort/1.21.0/ort-wasm-simd-threaded.wasm` | 12,666,427 | 3,253,060 | ONNX Runtime (runs ArcFace) |
| `models/trustid/w600k_mbf.onnx` | 13,616,099 | 12,620,824 | ArcFace MobileFaceNet embedder (fp32) |
| `mediapipe/0.10.18/vision_wasm_internal.wasm` | 9,502,124 | 2,904,621 | MediaPipe runtime (face detector) |
| `models/trustid/face_landmarker.task` | 3,758,596 | 3,334,083 | Face detector + landmark model |
| **Total** | **39,543,246 (= 37.71 MiB)** | **22,112,588** | |

The UI divided by 1024², so 39.5 MB was shown as "37.7 MB". Not downloaded:
the non-SIMD MediaPipe build (only on browsers without WASM SIMD), source
maps, duplicate models, fallback models. The JS loaders (26 KB ORT, 204 KB
MediaPipe) were small and fetched normally.

## Root cause

1. **Range requests defeat compression.** A `Range` response is served
   uncompressed, so the runtimes (4–5× compressible) always crossed the network
   at full size: 39.5 MB instead of ~22 MB.
2. **The origin is a poor model host for slow links.** Measured from a slow
   link (2026-10-05): Netlify delivered ~14–65 KB/s and closed every long
   transfer after ~70 s (`curl: (18) transfer closed`), while jsDelivr gave
   100–395 KB/s on the same link at the same time. Parallel range requests did
   not help (route-limited, not per-connection).
3. **The installed app downloaded what it already contained.** The APK
   packages `apps/web/dist` (models included) under `assets/public`, but the
   shell loads the live site and the SDK fetched every model from the network.
4. **Progress lived only in memory.** A reload or a killed tab restarted at 0.

## Architecture

```
            BIOMETRIC_ENGINE_RELEASE (model-manifest.ts)
            8 assets pinned by SHA-256  ·  releaseId e2-<6 hex per asset>
                                │
                       loadBiometricAsset()          asset-delivery.ts
     ┌──────────────────────────┼──────────────────────────────┐
  1. Cache Storage        2. App bundle                3. Network
  verified earlier        Android: WebView intercept   /biometric/<sha16>/<file>.gz.bin
  (warm web)              iOS: trustid-native://       adaptive Range requests,
                          (no download)                persisted ranges (resume),
                                                       CDN base → origin fallback
     └──────────────────────────┼──────────────────────────────┘
                 SHA-256 must equal the pinned value, or the asset is rejected
                                │
           ORT WASM + MediaPipe + ArcFace   (identical code and bytes everywhere)
                                │
          warm-up: engine conformance vector (cosine ≥ 0.9999 vs golden)
                                │
                        BiometricEngine contract           biometric-engine.ts
```

### One engine contract

`BiometricEngine` (`initialize`, `getStatus`, `subscribe`, `openCamera`,
`detectFace`, `evaluateQuality`, `createEmbedding`, `closeCamera`, `dispose`)
is the only surface applications use. `WasmBiometricEngine` implements it on
every platform by delegating to the existing pipeline (MediaPipe detection,
quality gates, PAD, ArcFace alignment and embedding); it adds no second
biometric code path.

Status keeps three facts separate:

| Flag | Meaning |
|---|---|
| `BIOMETRIC_ENGINE_READY` | local inference can run (works offline once assets are local) |
| `IDENTITY_NETWORK_AVAILABLE` | the device can reach TrustID (`navigator.onLine`) |
| `IDENTIFICATION_AVAILABLE` | both; a scan can be matched to an identity |

States: `IDLE → PREPARING → DOWNLOADING → VERIFYING → INITIALIZING → WARMING_UP → READY`, or `FAILED`
with the failing component, category and whether a reload is required. A
model or infrastructure failure is never reported as `NO_MATCH`.

### Why native shells run the same WASM engine (not ORT-Android / Core ML)

The mandate is "no core model download during native authentication" and "do
not create incompatible embeddings". V2 meets the first by shipping the exact
release inside the app, and the second by construction: the same bytes run the
same code, so web, Android and iOS embeddings are identical (verified:
gzip-delivered and raw-delivered models give bit-identical embeddings).

A native inference runtime (ONNX Runtime Mobile for Android, ONNX Runtime /
Core ML for iOS) can run `w600k_mbf.onnx` unchanged and would be faster, but it
would re-implement detection, alignment, quality gates and PAD in Kotlin and
Swift. Those cannot be validated without devices and an authorized face
dataset (see Limitations). The contract is ready for it: a native
implementation of `BiometricEngine` must pass the engine conformance vector
(below) before it may produce embeddings.

## Android

* `scripts/stage-biometric-assets.mjs` writes the release into
  `apps/web/public/biometric/<sha16>/`; `npm run android:apk` packages it
  (`prebuild:device`), and the device build drops the `.gz.bin` copies and the
  legacy duplicate binaries from the APK.
* `NativeBiometricAssets` + `BiometricAssetInterceptor` answer
  `https://<app host>/__trustid_native__/biometric/<sha16>/<file>` from the APK
  for the page and its service worker. Only well-formed release paths are
  opened; everything else under the prefix is a 404, never a network fetch.
* `TrustIdBiometricAssets.getBundle()` (Capacitor plugin) reports
  `{ apiVersion: 1, baseUrl: "/__trustid_native__/", assets: [<sha16>…] }`.
* The SDK verifies every bundled byte; a damaged or missing bundled file falls
  back to the network path instead of blocking sign-in.

## iOS

`BiometricAssetSchemeHandler` serves the bundled `public/biometric` release on
`trustid-native://local/biometric/<sha16>/<file>` (WKWebView cannot intercept
the https origin), with the same path rules; `TrustIdBridgeViewController`
registers it and the `TrustIdBiometricAssets` plugin. Both files are added to
the Xcode project and the storyboard uses the new controller.

**Not built or run**: no macOS toolchain was available, and the iOS project
already failed to build before V2 (`AppDelegate.swift` uses
`SceneBlurHandler`, whose sources in `ios/Plugin/` are not in the Xcode
target). If the custom-scheme fetch is refused by WebKit, the SDK falls back to
the network path.

### Android device verification (2026-10-06)

OPPO CPH2727, Android 16 (SDK 36), arm64-v8a, 5.5 GB RAM, WebView 153;
Wi-Fi connected, mobile data off. Verification APK (debug, bundled web shell,
`TRUSTID_DEVICE_DIAG=1`) installed over the existing app; harness:
`ANDROID_SERIAL=<serial> node scripts/verify-android-device.mjs --apk <apk>`.

| Run | App launch | Engine READY | Remote model bytes | Source | Conformance cosine | initWasm |
|---|---:|---:|---:|---|---:|---:|
| First launch (network on) | 2,475 ms | 5,934 ms | 0 | app-bundle | 1.000000 | 1 |
| Force-stop → reopen | 2,002 ms | 5,562 ms | 0 | app-bundle | 1.000000 | 1 |
| Re-enter ×3 | — | 2,799 / 4,622 / 4,691 ms | 0 | app-bundle | 1.000000 | 1 |
| Background → restore | — | stayed READY | 0 | — | — | — |
| 5× rapid in/out, then enter | — | 4,347 ms | 0 | app-bundle | 1.000000 | 1 |
| Process killed in background → reopen | 1,661 ms | 5,119 ms | 0 | app-bundle | 1.000000 | 1 |
| Wi-Fi off (no default network) → reopen | 1,658 ms | 4,857 ms | 0 | app-bundle | 1.000000 | 1 |

Cold first launch breakdown: assets resolved and verified by ~1.7 s
(runtime path ~3.3 s incl. ORT init), detector 1.7 s, embedder 3.3 s,
conformance warm-up 2.6 s. Offline: `BIOMETRIC_ENGINE_READY: true`,
`IDENTITY_NETWORK_AVAILABLE: false`, `IDENTIFICATION_AVAILABLE: false`.

Found and fixed on the device: Android WebView keeps `navigator.onLine` true
with no network unless the app calls `WebView.setNetworkAvailable`, so the
first offline run reported `IDENTIFICATION_AVAILABLE: true`.
`WebViewNetworkState` now feeds Android connectivity to the WebView
(`ACCESS_NETWORK_STATE`).

Camera scan (2026-10-07, real face, front camera, `?scan=1`; timings and
result codes only, embedding zeroed, nothing sent):

| | Cold | Warm |
|---|---:|---:|
| Engine READY | 5,441 ms | 2,482 ms |
| Camera ready | 1,198 ms | 682 ms |
| First face detected | 1,709 ms | 918 ms |
| One detection | 412 ms (first) | 79 ms |
| Quality gate passed | 1,714 ms | 2,771 ms (pose rejected first) |
| ArcFace embedding | 318 ms | 314 ms |
| Scan start → embedding | 2,032 ms | 3,085 ms |

Not exercised on the device: reboot (owner's choice), real-face
identification and unknown-face NO_MATCH against TrustID (needs the V2 web
deployed; not done under the no-deploy rule).

### Identification semantics fix (API)

Found while verifying NO_MATCH semantics: `/v1/trust-id/ambient-signin`
auto-enrolled on any non-match, including `BIOMETRIC_SERVICE_UNAVAILABLE`
(matcher/ANN outage), model/template mismatches, a gated threshold and
modality conflicts, so an outage could mint a duplicate Trust ID for an
existing person, and an outage was answered `401 ambient_no_match`. Fusion now
marks `genuineNoMatch` (every presented modality returned no error or
`NO_MATCH`); auto-enrolment requires it, and an outage is `503
BIOMETRIC_SERVICE_UNAVAILABLE`. Genuine-NO_MATCH onboarding is unchanged.
`apps/api/tests/ambient-no-enroll-on-failure.test.ts` fails 7/8 on the old
code and passes 8/8 with the fix.
The production shell loads the live site, which does not have the V2 SDK
until it is deployed, so identification against TrustID could not be run
with the V2 engine on the phone.

### Ready at launch (prewarm), 2026-10-07

`schedulePrewarmBiometricEngine()` starts the shared engine as the app opens
(web: after an idle asset prefetch; skipped under Save-Data, assets-only below
4 GB device memory). It never opens the camera. Bundled files are SHA-256
verified once per app installation (`installId` = version code + last update
time); later launches check size and type only. The service worker checks for
new web code whenever the app becomes visible, so a long-running app no longer
keeps an old bundle after a deploy.

OPPO CPH2727, bundled-shell verification build, no user action after launch:

| Launch | Activity start | Engine READY (page time) | Bundled requests | Remote model requests | initWasm |
|---|---:|---:|---:|---:|---:|
| 1st after install (full hash) | 2,234 ms | 8,846 ms | 6 | 0 | 1 |
| 2nd (hashes skipped) | 1,922 ms | 7,281 ms | 6 | 0 | 1 |
| 3rd | 1,900 ms | 7,288 ms | 6 | 0 | 1 |

Reproduce: `ANDROID_SERIAL=<serial> node scripts/measure-android-launch.mjs --apk <debug apk>`.

### iOS verification runbook (Mac + iPhone; not yet run)

Status: implementation present, build not verified, device not verified.

1. **Fix the pre-existing build break.** Add `ios/Plugin/SceneBlurHandler.swift`
   (and the other `ios/Plugin` sources the app needs) to the `App` target, or
   stop calling `SceneBlurHandler` from `AppDelegate.swift`. Out of V2 scope;
   do it as its own change.
2. **Build a verification app**:
   `CAP_USE_LIVE_WEB=0 TRUSTID_DEVICE_DIAG=1 npm run cap:sync -w @trustid/device`,
   then `pod install` in `apps/device/ios/App` and build `App` in Xcode for a
   physical iPhone.
3. **Asset hashes.** In the built `.app`, every file under
   `public/biometric/<sha16>/` must hash (`shasum -a 256`) to the value in
   `model-manifest.ts`, with no `.gz.bin` files.
4. **0 model download.** Safari → Develop → [iPhone] → TrustID → open
   `/diag-engine.html`. Expect `assetSource: "app-bundle"`, the Network tab
   showing only `trustid-native://local/biometric/...` for release assets, and
   no remote `/biometric/`, `/models/`, `/ort/` or `/mediapipe/` requests. If
   WebKit refuses the custom scheme, the page reports `assetSource: "network"`:
   that is a FAIL to fix (scheme handler / CORS), not a pass.
5. **Conformance.** Console shows `arcface_conformance_ok cosine=...` ≥ 0.9999
   (ARM64). On failure stop and classify; never lower the threshold.
6. **Cold / warm.** Force-quit → reopen → `/diag-engine.html` (cold); reload
   three times (warm); record `totalMs` and `timingsMs`.
7. **Camera / embedding.** `/diag-engine.html?scan=1`: camera ready, first
   face, quality pass, embedding times.
8. **Identification.** With the V2 web deployed (or a preview), an
   authorized identity: face → embedding → server result per existing policy;
   unknown face → `NO_MATCH`, distinct from every infrastructure failure.
9. **Offline engine.** Airplane mode → force-quit → reopen: engine `READY`,
   `IDENTITY_NETWORK_AVAILABLE: false`, `IDENTIFICATION_AVAILABLE: false`.
10. **Restart / reboot / lifecycle.** Force-quit, reboot, background and
    restore, repeated re-entry: no remote model bytes, `runtimeInitAttempts` 1,
    no `initWasm` errors, camera released.

## Runtime loader integrity

ORT's loader module and its WASM binary are both loaded through the delivery
layer (SHA-256 verified) and handed to ORT as `blob:` URLs
(`wasmPaths = { mjs, wasm }`, no `wasmBinary`, so ORT supplies `locateFile`
and the loader never resolves against a `blob:` `import.meta.url`). A loader
that fails verification is never imported, by blob or by URL. Only hosts
without `blob:` URLs (Node/jsdom tests) import the content-addressed URL;
`getBiometricRuntimeStatus().runtime.loaderIntegrity` reports which mode ran
(`sha256` in Chrome and on the phone). The MediaPipe loader is likewise a
verified blob. The application's own JS bundle remains trusted as part of the
build, as before.

## Web

* Network files are `<file>.gz.bin`: gzip bytes served as opaque binaries, so
  Range requests (resume) and compression both work. `.gz` was rejected
  because static servers and CDNs add `Content-Encoding: gzip` to `.gz` files
  (Vite's dev server does, even on 206 responses), which breaks ranges.
* Ranges adapt: 128 KiB–4 MiB, doubling below 2 s per range, halving above
  10 s, keeping each request well under the ~70 s connection cut-off.
* Received ranges are written to Cache Storage
  (`trustid-biometric-partial-v1`); a reload resumes from the last byte.
* Progress reports compressed bytes actually transferred.
* `schedulePrefetchBiometricAssets()` downloads and verifies assets at idle
  time. It never opens the camera or reads a frame, and skips itself for
  Save-Data, offline, and native shells that already carry the release.

## Model size and accuracy

No model was quantized or otherwise changed. Network transfer for the
standard (SIMD) browser path:

| | Before | After |
|---|---:|---:|
| Network bytes, cold | 39,543,246 | 22,172,301 |
| Native app, normal sign-in | 39,543,246 | 0 |
| Web, warm (verified cache) | 0 (when cached) | 0 |

fp16/int8 quantization of ArcFace (13.6 MB → ~6.8 / ~3.5 MB) was not shipped:
`artifacts/biometric-evidence/report.json` records
`BIOMETRIC_EVIDENCE_STATUS: BLOCKED_BY_DATASET`, so FAR/FRR and the genuine /
impostor distributions cannot be measured, and a changed model must not be
calibrated against the uncalibrated 0.35 threshold. Lossless byte-plane
shuffling was measured (11.66 MB vs 12.62 MB gzip) and judged not worth an
extra decode step.

## Embedding compatibility: the engine conformance vector

`engine-conformance.ts` defines a deterministic synthetic test card (no
person) and rotated landmarks. It goes through the real alignment (similarity
transform, bilinear sampling, RGB order, `(x-127.5)/128`, NCHW) and the real
model. The L2-normalized output must reach cosine ≥ 0.9999 with
`ENGINE_CONFORMANCE_GOLDEN`, generated on the reference engine.

* Runs on every device in the ArcFace warm-up; failure is `WARMUP_INVALID`
  (engine `FAILED`), so a non-conforming engine never produces an embedding.
* Tests prove the check catches a BGR pipeline, a mirrored crop and [0,1]
  pixel scaling (each cosine < 0.99).
* Reproduced in Node (V8) and headless Chrome on x86-64, and on an ARM64
  Android phone (OPPO CPH2727, WebView 153): cosine 1.000000 on every run.

## Model versioning

* `BIOMETRIC_RELEASE_ASSETS` pins file, SHA-256 and size for all 8 assets;
  `BIOMETRIC_ENGINE_RELEASE.releaseId` changes when any byte changes.
* URLs and cache keys are content-addressed, so new JS can never pair with an
  old runtime or model, and caches of other releases are pruned.
* The staging script refuses to publish bytes the SDK does not pin; tests pin
  every hash to the installed npm packages and model files.
* The server already rejects embeddings whose `modelName`/`modelVersion`
  differ; a test binds the ArcFace SHA-256 to that name/version, so swapping
  the model file without a version bump fails CI.

## CDN / delivery

`/biometric/*` is served immutable (`max-age=31536000, immutable`),
`application/octet-stream`, `nosniff`, with CORS for other Digiconomy origins,
and a real 404 for missing files (no SPA fallback). A CDN or object store can
be put first with `VITE_TRUSTID_BIOMETRIC_ASSET_BASE` (it must serve
`biometric/<sha16>/<file>[.gz.bin]` with Range support and CORS); the origin
stays the fallback and every byte is still hash-verified, so a CDN cannot
substitute content. Recommended: an object store with a global edge (e.g.
Cloudflare R2 + CDN) synced from `apps/web/public/biometric/` at deploy.

## Offline

Once the assets are local (installed app, or verified Cache Storage on the
web), the engine initializes without the asset network. On the web this is
limited to the engine: in Chrome the engine reached READY with every release
asset and legacy `/ort`, `/mediapipe` path blocked, but the page shell was
still served by the network. "TrustID Web works fully offline" is NOT claimed. Identification still
needs TrustID: the status reports `IDENTIFICATION_AVAILABLE: false` offline and
no remote search is simulated.

## Security invariants

Unchanged: the 0.35 threshold, PAD status and logic, Digi Authority, grants,
PDI and authority semantics. No embeddings, frames or landmarks are logged or
cached; diagnostics carry URLs, sizes, sources and categories only. No
fallback to fake or random embeddings, no auto-enrolment on failure, and
asset failures are never reported as a match result. Every model and runtime
byte is SHA-256 verified on every source, including the app bundle.

## Measurements

Headless Chrome on the development PC (x86-64, Windows, heavily loaded),
Vite dev server on localhost, 2026-10-05. Engine time = page start to
`READY` (assets, runtime, detector, embedder, conformance warm-up).

| Run | Engine READY | Asset network | Requests | Source |
|---|---:|---:|---:|---|
| Cold, unthrottled | 13.8 s | 21.17 MiB | 21 | network |
| Warm (reload) | 3.5 s | 0 | 1 (loader revalidation) | cache |
| Warm, asset network blocked | 3.4 s | 0 | 0 | cache |
| Cold, 1.6 Mbps / 150 ms RTT | 121.6 s | 21.19 MiB | 72 | network |
| Cut after 4.55 MiB, then reload | 18.7 s | 15.62 MiB more | 23 | mixed (resumed) |

At 1.6 Mbps the old 39.5 MB payload needs ≥198 s of transfer alone. Cold
warm-up (10.4 s) is dominated by MediaPipe's first GPU detection in headless
Chrome; warm it is 1.3 s. No phone was available, so no device number is
reported. Reproduce with

```
npm run dev:web
node scripts/measure-biometric-startup.mjs   # cold, warm, offline-warm, cold-3g, interrupted
```

`/diag-engine.html` (dev only) shows engine status and timings on a device.
