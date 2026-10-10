import { api } from "./api";

export type MediaAccess = { path: string; token: string; expiresAt: string };

export type HumanProfile = {
  subjectId: string;
  givenName: string;
  familyName: string;
  preferredName: string;
  displayName: string;
  avatarAssetId: string | null;
  avatar: MediaAccess | null;
  profileVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type IdentityDocument = {
  id: string;
  documentType: string;
  submittedAt: string;
  verificationStatus: string;
  verificationProvider: string;
};

export type OwnProfile = {
  subjectId: string;
  completed: boolean;
  profile: HumanProfile | null;
  nameVerification: string;
  documents: IdentityDocument[];
};

export type NameInput = {
  givenName: string;
  familyName?: string;
  preferredName?: string;
  displayName?: string;
  expectedVersion?: number;
};

/** Must match the server's DOCUMENT_CONSENT_VERSION. */
export const DOCUMENT_CONSENT_VERSION = "identity-document-consent-v1";

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  passport: "Passport",
  national_id: "National ID card",
  drivers_licence: "Driver's licence",
  voters_card: "Voter's card",
  residence_permit: "Residence permit",
  other: "Other",
};

export const getOwnProfile = () => api<OwnProfile>("/v1/profile");

export const saveNames = (input: NameInput) =>
  api<OwnProfile>("/v1/profile", { method: "PUT", body: JSON.stringify(input) });

export const uploadAvatar = (imageDataUrl: string) =>
  api<OwnProfile>("/v1/profile/avatar", { method: "PUT", body: JSON.stringify({ imageDataUrl }) });

export const removeAvatar = () => api<OwnProfile>("/v1/profile/avatar", { method: "DELETE" });

export const submitDocument = (documentType: string, imageDataUrl: string) =>
  api<{ document: IdentityDocument; note: string }>("/v1/profile/documents", {
    method: "POST",
    body: JSON.stringify({
      documentType,
      imageDataUrl,
      consent: { accepted: true, version: DOCUMENT_CONSENT_VERSION },
    }),
  });

export const deleteDocument = (id: string) =>
  api<{ deleted: boolean }>(`/v1/profile/documents/${encodeURIComponent(id)}`, { method: "DELETE" });

export function mediaUrl(access: MediaAccess): string {
  return `${import.meta.env.VITE_API_URL ?? "/api"}${access.path}?token=${encodeURIComponent(access.token)}`;
}

/**
 * Decode the picked file in the browser and re-encode it as JPEG. Decoding
 * proves it is a real image; re-encoding drops EXIF/GPS and other metadata
 * before anything leaves the device. The server validates and strips again.
 */
export async function reencodeImage(file: File, maxSide: number): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error("Choose a JPEG, PNG or WebP image.");
  }
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file could not be read as an image.");
  });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image processing is unavailable on this device.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    bitmap.close();
  }
}
