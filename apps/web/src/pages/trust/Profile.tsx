import { FormEvent, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  DocumentFields,
  EMPTY_NAMES,
  ImagePicker,
  LegalNameFields,
  PreferredNameFields,
  type NameDraft,
} from "../../components/ProfileFields";
import {
  DOCUMENT_TYPE_LABELS,
  deleteDocument,
  getOwnProfile,
  mediaUrl,
  removeAvatar,
  saveNames,
  submitDocument,
  uploadAvatar,
  type OwnProfile,
} from "../../lib/profile";

/** Manage the self-declared profile, picture and optional identity documents. */
export function ProfilePage() {
  const location = useLocation();
  const [data, setData] = useState<OwnProfile | null>(null);
  const [names, setNames] = useState<NameDraft>(EMPTY_NAMES);
  const [avatarDraft, setAvatarDraft] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState("national_id");
  const [documentImage, setDocumentImage] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState<string | null>(
    (location.state as { saved?: boolean } | null)?.saved ? "Profile saved." : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load(next: OwnProfile) {
    setData(next);
    setNames(
      next.profile
        ? {
            givenName: next.profile.givenName,
            familyName: next.profile.familyName,
            preferredName: next.profile.preferredName,
            displayName: next.profile.displayName,
          }
        : EMPTY_NAMES,
    );
  }

  useEffect(() => {
    getOwnProfile()
      .then(load)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load your profile"));
  }, []);

  async function run(action: () => Promise<OwnProfile | void>, done: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      load(result ?? (await getOwnProfile()));
      setMessage(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  function onSaveNames(e: FormEvent) {
    e.preventDefault();
    void run(
      () =>
        saveNames({
          givenName: names.givenName,
          familyName: names.familyName || undefined,
          preferredName: names.preferredName || undefined,
          displayName: names.displayName || undefined,
          expectedVersion: data?.profile?.profileVersion,
        }),
      "Name saved.",
    );
  }

  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;

  const profile = data.profile;

  return (
    <div className="dashboard profile-page">
      {!data.completed && (
        <section className="section surface-block">
          <h2>Complete your profile</h2>
          <p className="sub">Tell Digi and your apps what to call you.</p>
          <Link className="btn btn-primary" to="/profile/complete">
            Start
          </Link>
        </section>
      )}

      <section className="section surface-block">
        <h2>Name</h2>
        <p className="muted">Self-declared. Not proof of legal identity.</p>
        <form onSubmit={onSaveNames}>
          <LegalNameFields value={names} onChange={setNames} />
          <PreferredNameFields value={names} onChange={setNames} />
          <button className="btn btn-primary" type="submit" disabled={busy || !names.givenName.trim()}>
            Save name
          </button>
        </form>
      </section>

      <section className="section surface-block">
        <h2>Profile picture</h2>
        <p className="muted">Private. Shared only with apps you allow. Never used for face sign-in.</p>
        {profile?.avatar && !avatarDraft && (
          <img className="profile-preview" src={mediaUrl(profile.avatar)} alt="Your profile picture" />
        )}
        {profile ? (
          <>
            <ImagePicker
              id="avatar-manage"
              label={profile.avatar ? "Replace picture" : "Add a picture"}
              maxSide={1024}
              value={avatarDraft}
              onChange={setAvatarDraft}
              onError={setError}
            />
            <div className="profile-actions">
              {avatarDraft && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const r = await uploadAvatar(avatarDraft);
                        setAvatarDraft(null);
                        return r;
                      }, "Picture saved.")
                    }
                  >
                    Save picture
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setAvatarDraft(null)}>
                    Cancel
                  </button>
                </>
              )}
              {profile.avatar && !avatarDraft && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => run(removeAvatar, "Picture deleted.")}>
                  Delete picture
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="muted">Save your name first.</p>
        )}
      </section>

      <section className="section surface-block">
        <h2>Identity documents</h2>
        {data.documents.length > 0 && (
          <ul className="profile-documents">
            {data.documents.map((d) => (
              <li key={d.id}>
                <span>
                  {DOCUMENT_TYPE_LABELS[d.documentType] ?? d.documentType} ·{" "}
                  {new Date(d.submittedAt).toLocaleDateString()} · <strong>{d.verificationStatus}</strong>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Delete this document? The stored copy is removed.")) {
                      void run(async () => {
                        await deleteDocument(d.id);
                      }, "Document deleted.");
                    }
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
        <DocumentFields
          documentType={documentType}
          onDocumentType={setDocumentType}
          image={documentImage}
          onImage={setDocumentImage}
          consent={consent}
          onConsent={setConsent}
          onError={setError}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !documentImage || !consent}
          onClick={() =>
            run(async () => {
              await submitDocument(documentType, documentImage!);
              setDocumentImage(null);
              setConsent(false);
            }, "Document submitted. It is stored unverified.")
          }
        >
          Submit document
        </button>
      </section>

      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
