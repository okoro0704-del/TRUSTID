/**
 * Internal biometric-eval API: secret gate + consent before capture.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";

describe("biometric-eval internal collector", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dataRoot: string;
  const secret = "test-eval-secret-please-change";

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "trustid-eval-"));
    process.env.EVAL_BIOMETRIC_SECRET = secret;
    process.env.TRUSTID_EVAL_DATA_ROOT = dataRoot;
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.EVAL_BIOMETRIC_SECRET;
    delete process.env.TRUSTID_EVAL_DATA_ROOT;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("returns 404 when secret env is unset", async () => {
    delete process.env.EVAL_BIOMETRIC_SECRET;
    const res = await app.inject({
      method: "GET",
      url: "/internal/biometric-eval/status",
      headers: { "x-eval-biometric-secret": secret },
    });
    expect(res.statusCode).toBe(404);
    process.env.EVAL_BIOMETRIC_SECRET = secret;
  });

  it("rejects unauthorized secret", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/biometric-eval/status",
      headers: { "x-eval-biometric-secret": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("requires consent to create participant and capture", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/internal/biometric-eval/status",
      headers: { "x-eval-biometric-secret": secret },
    });
    expect(ok.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/internal/biometric-eval/participants",
      headers: { "x-eval-biometric-secret": secret },
      payload: {
        consent_given: true,
        consent_timestamp: new Date().toISOString(),
        dataset_version: "1.0.0",
      },
    });
    expect(created.statusCode).toBe(200);
    const subjectId = created.json().participant.subject_id as string;
    expect(created.json().participant.consent.consent_given).toBe(true);

    const session = await app.inject({
      method: "POST",
      url: "/internal/biometric-eval/sessions",
      headers: { "x-eval-biometric-secret": secret },
      payload: {
        subject_id: subjectId,
        sessionKey: "enrollment_neutral",
      },
    });
    expect(session.statusCode).toBe(200);
    const sessionId = session.json().session.sessionId as string;

    const vector = Array.from({ length: 512 }, (_, i) => (i % 17) / 17);
    const capture = await app.inject({
      method: "POST",
      url: "/internal/biometric-eval/captures",
      headers: { "x-eval-biometric-secret": secret },
      payload: {
        subject_id: subjectId,
        sessionId,
        embedding: vector,
        qualityScore: 0.9,
        active_liveness_check: "skipped",
      },
    });
    expect(capture.statusCode).toBe(200);
    expect(capture.json().captureId).toBeTruthy();
    // Response must not echo embedding
    expect(capture.json().embedding).toBeUndefined();

    const exported = await app.inject({
      method: "POST",
      url: "/internal/biometric-eval/export",
      headers: { "x-eval-biometric-secret": secret },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().validation.DATASET_VALID).toBe(true);

    const del = await app.inject({
      method: "DELETE",
      url: `/internal/biometric-eval/participants/${subjectId}`,
      headers: { "x-eval-biometric-secret": secret },
    });
    expect(del.statusCode).toBe(200);
  });

  it("rejects oversized/non-image payloads", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/internal/biometric-eval/participants",
      headers: { "x-eval-biometric-secret": secret },
      payload: { consent_given: true },
    });
    const subjectId = created.json().participant.subject_id as string;
    const session = await app.inject({
      method: "POST",
      url: "/internal/biometric-eval/sessions",
      headers: { "x-eval-biometric-secret": secret },
      payload: { subject_id: subjectId, sessionKey: "enrollment_neutral" },
    });
    const sessionId = session.json().session.sessionId as string;
    const vector = Array.from({ length: 512 }, () => 0.01);
    const bad = await app.inject({
      method: "POST",
      url: "/internal/biometric-eval/captures",
      headers: { "x-eval-biometric-secret": secret },
      payload: {
        subject_id: subjectId,
        sessionId,
        embedding: vector,
        imageBase64: Buffer.alloc(100).toString("base64"),
        imageMime: "image/png",
      },
    });
    expect(bad.statusCode).toBe(400);
  });
});
