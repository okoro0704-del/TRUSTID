import type { LabStudyConfig } from "./protocol.js";

export const LAB_CONSENT_VERSION = "trustid-assurance-lab-consent-v1";
export const LAB_CONSENT_PHRASE = "I CONSENT";

export type LabConsentDocument = {
  consentVersion: string;
  studyId: string;
  studyVersion: string;
  title: string;
  sections: Array<{ heading: string; body: string }>;
  requiredPhrase: typeof LAB_CONSENT_PHRASE;
};

/** The exact text shown before any biometric collection. */
export function buildConsentDocument(study: LabStudyConfig): LabConsentDocument {
  return {
    consentVersion: study.consentVersion,
    studyId: study.studyId,
    studyVersion: study.studyVersion,
    title: "TrustID Assurance Lab - biometric evaluation study",
    requiredPhrase: LAB_CONSENT_PHRASE,
    sections: [
      {
        heading: "What is collected",
        body:
          "Face measurements (a 512-number face embedding produced on your device by the TrustID face pipeline), " +
          "capture quality and liveness results, and timing. These are biometric data.",
      },
      {
        heading: "Why",
        body:
          "Only to measure how accurately and securely TrustID face recognition works. " +
          "This study does not create a TrustID, does not sign you in, and grants no account, owner, admin, or financial authority.",
      },
      {
        heading: "Repeated captures",
        body:
          "You may be asked for several captures across separate sessions, with different poses, distances, lighting, " +
          "and possibly a different device or browser.",
      },
      {
        heading: "Device and environment metadata",
        body:
          "Platform (Web/Android/iOS), browser or app runtime, device class, camera facing/orientation, and the " +
          "conditions the operator labels (for example LOW_LIGHT). No location, contacts, or account identifiers.",
      },
      {
        heading: "Camera images",
        body:
          "Raw camera frames are processed in memory and discarded. They are not uploaded or stored by this study.",
      },
      {
        heading: "Pseudonymous identity",
        body:
          "You are recorded under a random study ID. Your name, email, phone number, and TrustID are not linked to the study data.",
      },
      {
        heading: "Retention",
        body: `Evaluation evidence (embeddings and metadata) is kept for at most ${study.evidenceRetentionDays} days, then deleted. Exported reports contain only aggregate statistics.`,
      },
      {
        heading: "Withdrawal and deletion",
        body:
          "You can withdraw at any time. Withdrawal deletes your captures and embeddings and invalidates any report computed from them. " +
          "Aggregate reports already published cannot identify you and are regenerated without your data.",
      },
    ],
  };
}

export type ConsentAcceptance =
  | { ok: true }
  | { ok: false; reason: "CONSENT_PHRASE_REQUIRED" | "CONSENT_VERSION_MISMATCH" };

/** Consent requires the exact phrase for the exact consent version shown. */
export function validateConsentAcceptance(
  input: { phrase: unknown; consentVersion: unknown },
  document: LabConsentDocument,
): ConsentAcceptance {
  if (typeof input.phrase !== "string" || input.phrase.trim() !== LAB_CONSENT_PHRASE) {
    return { ok: false, reason: "CONSENT_PHRASE_REQUIRED" };
  }
  if (input.consentVersion !== document.consentVersion) {
    return { ok: false, reason: "CONSENT_VERSION_MISMATCH" };
  }
  return { ok: true };
}

/** Deterministic text used for the consent document hash. */
export function consentDocumentText(document: LabConsentDocument): string {
  return [
    document.title,
    `consentVersion=${document.consentVersion}`,
    `studyId=${document.studyId}`,
    `studyVersion=${document.studyVersion}`,
    ...document.sections.map((s) => `${s.heading}\n${s.body}`),
    `requiredPhrase=${document.requiredPhrase}`,
  ].join("\n\n");
}
