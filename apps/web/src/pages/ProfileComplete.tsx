import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthChrome } from "../components/AuthChrome";
import {
  DocumentFields,
  EMPTY_NAMES,
  ImagePicker,
  LegalNameFields,
  PreferredNameFields,
  type NameDraft,
} from "../components/ProfileFields";
import { DOCUMENT_TYPE_LABELS, getOwnProfile, saveNames, submitDocument, uploadAvatar } from "../lib/profile";

const STEPS = ["Your name", "Preferred name", "Profile picture", "Identity document", "Review"] as const;

/**
 * Profile completion after secure TrustID account creation. This page only
 * renders inside the authenticated app shell (biometric gate passed) and
 * every call needs that session; it cannot create an account.
 */
export function ProfileCompletePage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [names, setNames] = useState<NameDraft>(EMPTY_NAMES);
  const [version, setVersion] = useState<number | undefined>();
  const [avatar, setAvatar] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState("national_id");
  const [documentImage, setDocumentImage] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getOwnProfile()
      .then((p) => {
        if (!p.profile) return;
        setNames({
          givenName: p.profile.givenName,
          familyName: p.profile.familyName,
          preferredName: p.profile.preferredName,
          displayName: p.profile.displayName,
        });
        setVersion(p.profile.profileVersion);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load your profile"));
  }, []);

  const includeDocument = Boolean(documentImage);
  const canAdvance =
    (step !== 0 || names.givenName.trim().length > 0) && (step !== 3 || !includeDocument || consent);

  function next(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (canAdvance) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveNames({
        givenName: names.givenName,
        familyName: names.familyName || undefined,
        preferredName: names.preferredName || undefined,
        displayName: names.displayName || undefined,
        expectedVersion: version,
      });
      setVersion(saved.profile?.profileVersion);
      if (avatar) {
        const withAvatar = await uploadAvatar(avatar);
        setVersion(withAvatar.profile?.profileVersion);
      }
      if (includeDocument && consent && documentImage) await submitDocument(documentType, documentImage);
      navigate("/dashboard/profile", { replace: true, state: { saved: true } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Saving failed");
    } finally {
      setSaving(false);
    }
  }

  const addressAs = names.preferredName.trim() || names.displayName.trim() || names.givenName.trim();

  return (
    <AuthChrome title="Complete your profile" backTo="/dashboard">
      <form className="panel surface-block profile-wizard" onSubmit={next}>
        <p className="continue-eyebrow">
          Step {step + 1} of {STEPS.length} · {STEPS[step]}
        </p>
        <ol className="profile-steps" aria-label="Profile steps">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} className={i <= step ? "done" : undefined}>
              {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <h1>What is your name?</h1>
            <p className="muted">Your name is self-declared. It is not proof of legal identity.</p>
            <LegalNameFields value={names} onChange={setNames} />
          </>
        )}
        {step === 1 && (
          <>
            <h1>How should we address you?</h1>
            <PreferredNameFields value={names} onChange={setNames} />
          </>
        )}
        {step === 2 && (
          <>
            <h1>Profile picture</h1>
            <p className="muted">
              Optional. Stored privately and shared only with apps you allow. It is not
              used for face sign-in or biometric checks.
            </p>
            <ImagePicker id="avatar-image" label="Choose a picture" maxSide={1024} value={avatar} onChange={setAvatar} onError={setError} />
            {avatar && (
              <button type="button" className="btn btn-ghost" onClick={() => setAvatar(null)}>
                Remove picture
              </button>
            )}
          </>
        )}
        {step === 3 && (
          <>
            <h1>Identity document</h1>
            <DocumentFields
              documentType={documentType}
              onDocumentType={setDocumentType}
              image={documentImage}
              onImage={setDocumentImage}
              consent={consent}
              onConsent={setConsent}
              onError={setError}
            />
            {includeDocument && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setDocumentImage(null);
                  setConsent(false);
                }}
              >
                Skip the document
              </button>
            )}
          </>
        )}
        {step === 4 && (
          <>
            <h1>Review</h1>
            <dl className="profile-review">
              <dt>Name</dt>
              <dd>{[names.givenName, names.familyName].filter(Boolean).join(" ")}</dd>
              <dt>Digi will call you</dt>
              <dd>{addressAs}</dd>
              <dt>Profile picture</dt>
              <dd>{avatar ? <img className="profile-preview small" src={avatar} alt="" /> : "None"}</dd>
              <dt>Identity document</dt>
              <dd>{includeDocument ? `${DOCUMENT_TYPE_LABELS[documentType]} · will be stored unverified` : "Not submitted"}</dd>
            </dl>
            <p className="muted">Names are self-declared. You can change everything later.</p>
          </>
        )}

        {error && <p className="error" role="alert">{error}</p>}

        <div className="profile-actions">
          {step > 0 && (
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button type="submit" className="btn btn-primary" disabled={!canAdvance}>
              {step === 2 && !avatar ? "Skip" : step === 3 && !includeDocument ? "Skip" : "Continue"}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Save profile"}
            </button>
          )}
        </div>
        {step === 0 && (
          <Link className="muted" to="/dashboard">
            Not now
          </Link>
        )}
      </form>
    </AuthChrome>
  );
}
