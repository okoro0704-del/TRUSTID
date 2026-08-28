import { useCallback, useEffect, useRef, useState } from "react";
import type { BiometricGate } from "@trustid/device-security";
import type { DakSession, EncryptedSovereignFileSystem, EsfsManifest } from "@trustid/vault-sdk";

export type VaultProtectedMediaViewerProps = {
  esfs: EncryptedSovereignFileSystem;
  dakSession: DakSession;
  gate: BiometricGate;
  assetId: string;
  manifest?: EsfsManifest;
  unlockReason?: string;
  className?: string;
  onUnlocked?: () => void;
  onDuress?: () => void;
};

/**
 * Streams decrypted eSFS media after local biometric re-auth.
 * Plaintext exists only in a blob URL for the media element lifetime.
 */
export function VaultProtectedMediaViewer({
  esfs,
  dakSession,
  gate,
  assetId,
  manifest: manifestProp,
  unlockReason = "Unlock encrypted media",
  className,
  onUnlocked,
  onDuress,
}: VaultProtectedMediaViewerProps) {
  const [manifest, setManifest] = useState<EsfsManifest | null>(
    manifestProp ?? esfs.getManifest(assetId) ?? null,
  );
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(dakSession.isUnlocked);
  const chunksRef = useRef<Uint8Array[]>([]);

  useEffect(() => {
    setManifest(manifestProp ?? esfs.getManifest(assetId) ?? null);
  }, [assetId, esfs, manifestProp]);

  useEffect(() => {
    return () => {
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
      for (const chunk of chunksRef.current) chunk.fill(0);
      chunksRef.current = [];
    };
  }, [mediaUrl]);

  const buildMediaUrl = useCallback(async () => {
    chunksRef.current = [];
    await esfs.decryptChunkStream(assetId, (_index, plain) => {
      chunksRef.current.push(plain);
    });
    const total = chunksRef.current.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunksRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
      chunk.fill(0);
    }
    chunksRef.current = [];
    const mime = manifest?.mimeType ?? "application/octet-stream";
    const blob = new Blob([merged], { type: mime });
    merged.fill(0);
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    setMediaUrl(URL.createObjectURL(blob));
  }, [assetId, esfs, manifest?.mimeType, mediaUrl]);

  async function unlockAndStream() {
    setBusy(true);
    setError(null);
    try {
      if (!dakSession.isUnlocked) {
        const auth = await dakSession.unlock(unlockReason);
        if (auth.duress) {
          onDuress?.();
          setError("Vault locked (duress mode)");
          return;
        }
      }
      setUnlocked(true);
      onUnlocked?.();
      await buildMediaUrl();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decrypt failed");
    } finally {
      setBusy(false);
    }
  }

  async function reauthAndRefresh() {
    setBusy(true);
    setError(null);
    try {
      dakSession.lock();
      setUnlocked(false);
      if (mediaUrl) {
        URL.revokeObjectURL(mediaUrl);
        setMediaUrl(null);
      }
      const auth = await gate.authenticate({
        reason: unlockReason,
        allowDeviceCredential: false,
        strongOnly: true,
      });
      if (!auth.ok) throw new Error("Biometric re-auth required");
      await dakSession.unlock(unlockReason);
      setUnlocked(true);
      await buildMediaUrl();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-auth failed");
    } finally {
      setBusy(false);
    }
  }

  if (!manifest) {
    return (
      <div className={`tid-vault-viewer ${className ?? ""}`.trim()}>
        <p className="tid-error">Encrypted asset not found.</p>
      </div>
    );
  }

  return (
    <div className={`tid-vault-viewer ${className ?? ""}`.trim()}>
      <div className="tid-vault-viewer-head">
        <strong>{manifest.displayName}</strong>
        <span className="tid-muted">
          {manifest.chunkCount} chunks · AES-256-GCM eSFS
        </span>
      </div>

      {!unlocked || !mediaUrl ? (
        <div className="tid-vault-viewer-gate">
          <p className="tid-muted">Biometric step-up required to decrypt this asset.</p>
          <button
            type="button"
            className="tid-btn tid-btn-primary"
            disabled={busy}
            onClick={unlockAndStream}
          >
            {busy ? "Decrypting…" : "Unlock & play"}
          </button>
        </div>
      ) : (
        <div className="tid-vault-viewer-media">
          {manifest.mimeType.startsWith("video/") ? (
            <video
              className="tid-vault-media-el"
              src={mediaUrl}
              controls
              playsInline
              data-testid="vault-video"
            />
          ) : manifest.mimeType.startsWith("image/") ? (
            <img
              className="tid-vault-media-el"
              src={mediaUrl}
              alt={manifest.displayName}
              data-testid="vault-image"
            />
          ) : (
            <a className="tid-btn tid-btn-ghost" href={mediaUrl} download={manifest.displayName}>
              Download decrypted file
            </a>
          )}
          <button
            type="button"
            className="tid-btn tid-btn-ghost"
            disabled={busy}
            onClick={reauthAndRefresh}
          >
            Re-authenticate & reload
          </button>
        </div>
      )}

      {error && <p className="tid-error">{error}</p>}
    </div>
  );
}
