# TrustID Face Biometric Model Card

## Recognition model

| Field | Value |
|-------|--------|
| **Name** | `insightface_arcface_w600k_mbf_v1` |
| **Architecture** | ArcFace loss + MobileFaceNet backbone (InsightFace `w600k_mbf`) |
| **Why this model** | Trained for face recognition (not classification/detection-only). Compact (~13.6 MB) for browser/mobile ONNX. Produces native **512-D** embeddings — matches existing pgvector schema without fake projection. |
| **Embedding dim** | 512 |
| **Input** | 112×112 RGB, NCHW float32, normalize `(x - 127.5) / 128` |
| **Similarity** | Cosine distance on L2-normalized embeddings |
| **Runtime** | `onnxruntime-web` (WebGPU ? WASM) |
| **Source** | https://huggingface.co/deepghs/insightface (`buffalo_s/w600k_mbf.onnx`) |
| **SHA-256** | `9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f` |
| **License** | InsightFace project models — review InsightFace / dataset licenses before commercial redistribution. Apache-2.0 applies to InsightFace *code*; weight redistribution may have additional constraints. |

## Detector

| Field | Value |
|-------|--------|
| **Name** | MediaPipe Face Landmarker float16 |
| **Version id** | `mediapipe_face_landmarker_v1` |
| **Output** | Face mesh landmarks ? mapped to ArcFace 5-point set |
| **License** | Apache-2.0 (Google MediaPipe) |
| **Source** | `https://storage.googleapis.com/mediapipe-models/face_landmarker/...` |

## Alignment

| Field | Value |
|-------|--------|
| **Version** | `arcface_five_point_v1` |
| **Method** | Similarity transform (Umeyama) to InsightFace 112×112 reference template |

## PAD / Liveness

| Field | Value |
|-------|--------|
| **Current** | `mediapipe_blink_active_v1` — active blink via Face Landmarker blendshapes |
| **Not claimed** | Print/replay/deepfake MiniFASNet (interface ready; artifact optional follow-up) |
| **Forbidden** | Treating `face-presence.ts` heuristics as liveness |

## Fetch artifacts

```bash
node scripts/fetch-biometric-models.mjs
```

Places files under `apps/web/public/models/trustid/` with `manifest.json`.

## Legacy templates

Templates with `model_name` in `spatial_fallback_v1`, `mobile_facenet_v1`, `spatial_fallback_dev_v1` are **incompatible**. Server returns `BIOMETRIC_TEMPLATE_LEGACY` and requires re-enrollment.
