import { useCallback, useEffect, useRef, useState } from "react";
import type { VaultItemMeta } from "@trustid/device-security";
import { getMediaVault } from "../../lib/security/tier1";

const FOLDER_NAME = "TrustID Private";

/**
 * Consumer Media tab ? encrypted private folder.
 * Photos/videos are stored encrypted on-device; biometric required to open.
 */
export function MediaVaultPage() {
  const [items, setItems] = useState<VaultItemMeta[]>([]);
  const [sealedCount, setSealedCount] = useState(0);
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<"image" | "video" | "other">(
    "image",
  );
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshSealed = useCallback(async () => {
    setSealedCount(await getMediaVault().sealedCount());
  }, []);

  const refreshOpen = useCallback(async () => {
    const vault = getMediaVault();
    setItems(await vault.list());
    setUnlocked(vault.isUnlocked);
    setSealedCount(await vault.sealedCount());
  }, []);

  useEffect(() => {
    refreshSealed().catch(() => undefined);
  }, [refreshSealed]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      getMediaVault().lock();
    };
  }, [previewUrl]);

  async function onUnlockFolder() {
    setBusy(true);
    setError(null);
    try {
      await getMediaVault().unlock(`Open ${FOLDER_NAME}`);
      await refreshOpen();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Biometric unlock failed");
    } finally {
      setBusy(false);
    }
  }

  async function onAddMedia(fileList: FileList | null) {
    if (!fileList?.length) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (!getMediaVault().isUnlocked) {
        await getMediaVault().unlock(`Unlock ${FOLDER_NAME} to add media`);
      }
      for (const file of Array.from(fileList)) {
        const result = await getMediaVault().importFile(file);
        if (result.wipeNote) setNote(result.wipeNote);
      }
      await refreshOpen();
      setNote((n) => n ?? `Saved to ${FOLDER_NAME}. Encrypted on this device.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add media");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onOpenItem(item: VaultItemMeta) {
    setBusy(true);
    setError(null);
    try {
      if (!getMediaVault().isUnlocked) {
        await getMediaVault().unlock(`Open ${item.displayName}`);
      }
      const { bytes, mimeType } = await getMediaVault().decrypt(item.id);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
      setPreviewUrl(URL.createObjectURL(blob));
      setPreviewKind(
        item.kind === "video" || mimeType.startsWith("video/")
          ? "video"
          : item.kind === "image" || mimeType.startsWith("image/")
            ? "image"
            : "other",
      );
      bytes.fill(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(id: string) {
    setBusy(true);
    setError(null);
    try {
      if (!getMediaVault().isUnlocked) {
        await getMediaVault().unlock("Confirm delete from private folder");
      }
      await getMediaVault().remove(id);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
      await refreshOpen();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  function onLockFolder() {
    getMediaVault().lock();
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setUnlocked(false);
    setItems([]);
    refreshSealed().catch(() => undefined);
  }

  if (!unlocked) {
    return (
      <div className="dashboard">
        <section className="section surface-block media-folder-locked">
          <div className="media-folder-icon" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="56" height="56">
              <path
                d="M8 18a6 6 0 0 1 6-6h12l4 5h20a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6V18Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              />
              <path
                d="M26 34h12M32 28v12"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <h2>{FOLDER_NAME}</h2>
          <p className="sub">
            Photos and videos you add are encrypted and kept in this private
            folder on your device. Face ID, Touch ID, or fingerprint is required
            to open it.
          </p>
          <p className="muted">
            {sealedCount === 0
              ? "Folder is empty"
              : `${sealedCount} encrypted item${sealedCount === 1 ? "" : "s"} ? locked`}
          </p>
          <div className="inline-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={onUnlockFolder}
            >
              {busy ? "Waiting?" : "Open with biometric"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              Add photo or video
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => onAddMedia(e.target.files)}
          />
          {note && <p className="muted">{note}</p>}
          {error && <p className="error">{error}</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <section className="section surface-block">
        <div className="section-head">
          <div>
            <h2>{FOLDER_NAME}</h2>
            <p className="sub">Unlocked ? encrypted on this device</p>
          </div>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onLockFolder}>
            Lock
          </button>
        </div>
        <div className="inline-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Add to folder
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => onAddMedia(e.target.files)}
        />
        {note && <p className="muted">{note}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {previewUrl && (
        <section className="section surface-block">
          <h2>Preview</h2>
          <p className="sub">Visible only while the folder is unlocked.</p>
          {previewKind === "video" ? (
            <video className="vault-preview" src={previewUrl} controls playsInline />
          ) : (
            <img className="vault-preview" src={previewUrl} alt="Private media" />
          )}
        </section>
      )}

      <section className="section surface-block">
        <h2>In this folder</h2>
        <ul className="list compact-list">
          {items.map((item) => (
            <li key={item.id} className="row">
              <div className="row-main">
                <strong>{item.displayName}</strong>
                <span className="muted">
                  {item.kind} ? {(item.byteLength / 1024).toFixed(1)} KB
                </span>
              </div>
              <div className="inline-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => onOpenItem(item)}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => onRemove(item.id)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
          {items.length === 0 && (
            <li className="muted">No photos or videos yet. Tap Add to folder.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
