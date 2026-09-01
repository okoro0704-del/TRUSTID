import { registerPlugin } from "@capacitor/core";
import type { SilentFaceCaptureBridge } from "@trustid/sdk";

export type SilentFaceCapturePlugin = SilentFaceCaptureBridge;

export const TrustIdSilentFaceCapture = registerPlugin<SilentFaceCapturePlugin>(
  "TrustIdSilentFaceCapture",
);
