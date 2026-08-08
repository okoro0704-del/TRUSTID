import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";

type Profile = {
  trustId: string;
  displayName: string;
  identityStatus: string;
  verificationLevel: string;
  verificationMethod: string | null;
  identityPortraitRef: string | null;
  portraitVersion: number;
  profileVersion: number;
  status: string;
  latestPortraitStatus: string;
  isVerifiedIdentity: boolean;
  hasVerifiedIdentityPortrait: boolean;
  disclaimer: string;
};

type PortraitView = {
  id: string;
  status: string;
  version: number;
  isVerifiedIdentityPortrait: boolean;
  mediaAccess?: { path: string; token: string; expiresAt: string };
};

export function IdentityPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [portrait, setPortrait] = useState<PortraitView | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportSubject, setReportSubject] = useState("");

  async function load() {
    const p = await api<Profile>("/identity/profile");
    setProfile(p);
    try {
      const port = await api<PortraitView>("/identity/portrait");
      setPortrait(port);
      if (port.mediaAccess) {
        setPreviewUrl(
          `${import.meta.env.VITE_API_URL ?? "/api"}${port.mediaAccess.path}?token=${encodeURIComponent(port.mediaAccess.token)}`,
        );
      }
    } catch {
      setPortrait(null);
      setPreviewUrl(null);
    }
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load identity"),
    );
  }, []);

  async function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = (e.currentTarget.elements.namedItem("photo") as HTMLInputElement)
      ?.files?.[0];
    if (!input) {
      setError("Choose a photograph first");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const dataUrl = await fileToDataUrl(input);
      const result = await api<{
        portrait: PortraitView;
        note: string;
        hashCollisionNote: string | null;
      }>("/identity/portrait", {
        method: "POST",
        body: JSON.stringify({ imageDataUrl: dataUrl }),
      });
      setNotice(
        [result.note, result.hashCollisionNote].filter(Boolean).join(" "),
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function startVerify() {
    if (!portrait?.id) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api<{
        verificationId: string;
        disclaimer: string;
      }>("/identity/verification/start", {
        method: "POST",
        body: JSON.stringify({ portraitId: portrait.id }),
      });
      setNotice(started.disclaimer);
      const done = await api<{ disclaimer: string }>(
        "/identity/verification/complete",
        {
          method: "POST",
          body: JSON.stringify({
            verificationId: started.verificationId,
            providerPayload: { mockApprove: true },
          }),
        },
      );
      setNotice(done.disclaimer);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  async function onReport(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/identity/impersonation-reports", {
        method: "POST",
        body: JSON.stringify({
          type: "identity_impersonation_report",
          reason: reportReason,
          subjectTrustId: reportSubject || undefined,
        }),
      });
      setNotice(
        "Report filed for review. Accounts are never auto-merged from names or photos.",
      );
      setReportReason("");
      setReportSubject("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report failed");
    } finally {
      setBusy(false);
    }
  }

  const badge = profile?.isVerifiedIdentity
    ? "Verified Identity"
    : profile?.identityStatus === "pending"
      ? "Verification pending"
      : profile?.identityStatus === "revoked"
        ? "Verification revoked"
        : "Identity not verified";

  return (
    <div className="dashboard">
      <section className="section surface-block">
        <h2>Verified identity</h2>
        <p className="sub">
          TrustID owns WHO you are. Apps consume signed claims — they do not
          redefine your identity portrait.
        </p>
        {profile && (
          <>
            <p className="lead" style={{ marginBottom: "0.35rem" }}>
              {profile.displayName}
            </p>
            <p className="notice">{badge}</p>
            <ul className="list compact-list">
              <li className="row">
                <span className="muted">TrustID</span>
                <span className="tid">{profile.trustId}</span>
              </li>
              <li className="row">
                <span className="muted">Status</span>
                <span>{profile.identityStatus}</span>
              </li>
              <li className="row">
                <span className="muted">Verification level</span>
                <span>{profile.verificationLevel}</span>
              </li>
              <li className="row">
                <span className="muted">Profile / portrait version</span>
                <span>
                  {profile.profileVersion} / {profile.portraitVersion}
                </span>
              </li>
              <li className="row">
                <span className="muted">Latest upload</span>
                <span>{profile.latestPortraitStatus}</span>
              </li>
            </ul>
            <p className="muted">{profile.disclaimer}</p>
          </>
        )}
      </section>

      <section className="section surface-block">
        <h2>Identity portrait</h2>
        <p className="sub">
          An uploaded photo is only an input. Only a verified portrait may be
          shown to apps as a VERIFIED_IDENTITY_PORTRAIT.
        </p>
        {previewUrl && (
          <img
            src={previewUrl}
            alt="Identity portrait preview"
            style={{
              width: 120,
              height: 120,
              objectFit: "cover",
              borderRadius: 12,
              marginBottom: "0.75rem",
            }}
          />
        )}
        {portrait && (
          <p className="muted">
            Status: {portrait.status}
            {portrait.isVerifiedIdentityPortrait ? " · Verified portrait" : ""}
          </p>
        )}
        <form onSubmit={onUpload}>
          <div className="field">
            <label htmlFor="photo">Upload photograph (JPEG/PNG/WebP)</label>
            <input id="photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Upload photo
          </button>
        </form>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={busy || !portrait}
          style={{ marginTop: "0.5rem", width: "100%" }}
          onClick={() => void startVerify()}
        >
          Start mock verification (dev only)
        </button>
      </section>

      <section className="section surface-block">
        <h2>Report suspected impersonation</h2>
        <p className="sub">
          Same name or same photo never proves two accounts are the same person.
        </p>
        <form onSubmit={onReport}>
          <div className="field">
            <label htmlFor="subject">Other TrustID (optional)</label>
            <input
              id="subject"
              value={reportSubject}
              onChange={(e) => setReportSubject(e.target.value)}
              placeholder="TD-XXXXXXXX"
            />
          </div>
          <div className="field">
            <label htmlFor="reason">Reason</label>
            <input
              id="reason"
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              required
              minLength={5}
            />
          </div>
          <button className="btn btn-ghost" type="submit" disabled={busy}>
            Submit report
          </button>
        </form>
      </section>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}
