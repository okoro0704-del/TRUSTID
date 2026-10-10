import { useState } from "react";
import { DOCUMENT_TYPE_LABELS, reencodeImage } from "../lib/profile";

export type NameDraft = {
  givenName: string;
  familyName: string;
  preferredName: string;
  displayName: string;
};

export const EMPTY_NAMES: NameDraft = { givenName: "", familyName: "", preferredName: "", displayName: "" };

export function LegalNameFields({ value, onChange }: { value: NameDraft; onChange: (v: NameDraft) => void }) {
  return (
    <>
      <div className="field">
        <label htmlFor="profile-given">Given name</label>
        <input
          id="profile-given"
          autoComplete="given-name"
          maxLength={100}
          required
          value={value.givenName}
          onChange={(e) => onChange({ ...value, givenName: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="profile-family">Family name (optional)</label>
        <input
          id="profile-family"
          autoComplete="family-name"
          maxLength={100}
          value={value.familyName}
          onChange={(e) => onChange({ ...value, familyName: e.target.value })}
        />
      </div>
    </>
  );
}

export function PreferredNameFields({ value, onChange }: { value: NameDraft; onChange: (v: NameDraft) => void }) {
  return (
    <>
      <div className="field">
        <label htmlFor="profile-preferred">What should Digi and your apps call you?</label>
        <input
          id="profile-preferred"
          autoComplete="nickname"
          maxLength={60}
          placeholder={value.givenName}
          value={value.preferredName}
          onChange={(e) => onChange({ ...value, preferredName: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="profile-display">Display name (optional)</label>
        <input
          id="profile-display"
          maxLength={120}
          placeholder={[value.givenName, value.familyName].filter(Boolean).join(" ")}
          value={value.displayName}
          onChange={(e) => onChange({ ...value, displayName: e.target.value })}
        />
      </div>
    </>
  );
}

/** Picks and re-encodes a picture on the device; shows a local preview. */
export function ImagePicker({
  id,
  label,
  maxSide,
  value,
  onChange,
  onError,
}: {
  id: string;
  label: string;
  maxSide: number;
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={busy}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          onError(null);
          try {
            onChange(await reencodeImage(file, maxSide));
          } catch (err) {
            onError(err instanceof Error ? err.message : "That image could not be used.");
          } finally {
            setBusy(false);
          }
        }}
      />
      {value && <img className="profile-preview" src={value} alt="Selected picture preview" />}
    </div>
  );
}

export function DocumentFields({
  documentType,
  onDocumentType,
  image,
  onImage,
  consent,
  onConsent,
  onError,
}: {
  documentType: string;
  onDocumentType: (v: string) => void;
  image: string | null;
  onImage: (v: string | null) => void;
  consent: boolean;
  onConsent: (v: boolean) => void;
  onError: (message: string | null) => void;
}) {
  return (
    <>
      <p className="muted">
        Optional. TrustID stores the document privately for a future verification
        step. It is not checked now, and submitting it does not verify your identity.
      </p>
      <div className="field">
        <label htmlFor="document-type">Document type</label>
        <select id="document-type" value={documentType} onChange={(e) => onDocumentType(e.target.value)}>
          {Object.entries(DOCUMENT_TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <ImagePicker
        id="document-image"
        label="Photo of the document"
        maxSide={2400}
        value={image}
        onChange={onImage}
        onError={onError}
      />
      <label className="consent-check">
        <input type="checkbox" checked={consent} onChange={(e) => onConsent(e.target.checked)} />
        <span>
          I consent to TrustID storing this document privately for future identity
          verification. I can delete it at any time.
        </span>
      </label>
    </>
  );
}

