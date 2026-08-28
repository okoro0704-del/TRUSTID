import { useCallback, useEffect, useRef, useState } from "react";
import type { VaultItemMeta } from "@trustid/device-security";
import { getMediaVault } from "../../lib/security/tier1";

const FOLDER_NAME = "Media Locker";

type ThumbMap = Record<string, string>;

/**
 * 2026 Media Locker ? biometric vault with photo/video grid.
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
  const [previewName, setPreviewName] = useState("");
  const [thumbs, setThumbs] = useState<ThumbMap>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const thumbsRef = useRef<ThumbMap>({});

  const clearThumbs = useCallback(() => {
    for (const url of Object.values(thumbsRef.current)) {
      URL.revokeObjectURL(url);
    }
    thumbsRef.current = {};
    setThumbs({});
  }, []);

  const refreshSealed = useCallback(async () => {
    setSealedCount(await getMediaVault().sealedCount());
  }, []);

  const loadThumbs = useCallback(async (list: VaultItemMeta[]) => {
    clearThumbs();
    const next: ThumbMap = {};
    for (const item of list) {
      if (item.kind !== "image" && !item.mimeType.startsWith("image/")) continue;
      try {
        const { bytes, mimeType } = await getMediaVault().decrypt(item.id);
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
        next[item.id] = URL.createObjectURL(blob);
        bytes.fill(0);
      } catch {
        /* skip broken thumb */
      }
    }
    thumbsRef.current = next;
    setThumbs(next);
  }, [clearThumbs]);

  const refreshOpen = useCallback(async () => {
    const vault = getMediaVault();
    const list = await vault.list();
    setItems(list);
    setUnlocked(vault.isUnlocked);
    setSealedCount(await vault.sealedCount());
    await loadThumbs(list);
  }, [loadThumbs]);

  useEffect(() => {
    refreshSealed().catch(() => undefined);
  }, [refreshSealed]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      clearThumbs();
      getMediaVault().lock();
    };
  }, [previewUrl, clearThumbs]);

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
      setNote((n) => n ?? "Encrypted and saved in Media Locker.");
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
      setPreviewName(item.displayName);
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
        await getMediaVault().unlock("Confirm delete from Media Locker");
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
    clearThumbs();
    setUnlocked(false);
    setItems([]);
    refreshSealed().catch(() => undefined);
  }

  if (!unlocked) {
    return (
      <div className="dashboard locker-shell">
        <section className="locker-hero media-locker-gate">
          <div className="media-lock-orb" aria-hidden="true">
            <svg viewBox="0 0 80 80" width="72" height="72">
              <rect
                x="18"
                y="34"
                width="44"
                height="34"
                rx="8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
              />
              <path
                d="M28 34v-8a12 12 0 0 1 24 0v8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <circle cx="40" cy="50" r="3.5" fill="currentColor" />
            </svg>
          </div>
          <p className="locker-eyebrow">Encrypted on device</p>
          <h1 className="locker-title">{FOLDER_NAME}</h1>
          <p className="locker-lede">
            Private photos and videos stay sealed until you unlock with Face ID,
            Touch ID, or fingerprint.
          </p>
          <div className="locker-stat-pill">
            {sealedCount === 0
              ? "Empty locker"
              : `${sealedCount} sealed item${sealedCount === 1 ? "" : "s"}`}
          </div>
          <div className="locker-cta-row">
            <button
              type="button"
              className="btn btn-primary locker-cta"
              disabled={busy}
              onClick={onUnlockFolder}
            >
              {busy ? "Waiting?" : "Unlock with biometric"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              Add media
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
    <div className="dashboard locker-shell">
      <section className="locker-toolbar">
        <div>
          <p className="locker-eyebrow">Unlocked</p>
          <h1 className="locker-title-sm">{FOLDER_NAME}</h1>
        </div>
        <div className="locker-toolbar-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Add
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onLockFolder}>
            Lock
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
      </section>
      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}

      {previewUrl && (
        <section className="media-preview-sheet" role="dialog" aria-label="Media preview">
          <div className="media-preview-head">
            <strong>{previewName}</strong>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                URL.revokeObjectURL(previewUrl);
                setPreviewUrl(null);
              }}
            >
              Close
            </button>
          </div>
          {previewKind === "video" ? (
            <video className="vault-preview" src={previewUrl} controls playsInline autoPlay />
          ) : (
            <img className="vault-preview" src={previewUrl} alt={previewName} />
          )}
        </section>
      )}

      {items.length === 0 ? (
        <section className="locker-empty">
          <p>No media yet</p>
          <span className="muted">Add photos or videos to seal them here.</span>
        </section>
      ) : (
        <div className="media-grid" role="list">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="media-tile"
              role="listitem"
              disabled={busy}
              onClick={() => onOpenItem(item)}
            >
              {thumbs[item.id] ? (
                <img src={thumbs[item.id]} alt="" className="media-tile-img" />
              ) : (
                <div className="media-tile-fallback">
                  {item.kind === "video" ? "?" : "?"}
                </div>
              )}
              {item.kind === "video" && (
                <span className="media-tile-badge">Video</span>
              )}
              <span className="media-tile-name">{item.displayName}</span>
              <button
                type="button"
                className="media-tile-delete"
                aria-label={`Delete ${item.displayName}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void onRemove(item.id);
                }}
              >
                ×
              </button>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
