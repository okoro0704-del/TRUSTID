import { useCallback, useEffect, useRef, useState } from "react";
import type { BiometricAvailability } from "@trustid/device-security";
import { getMediaVault, probeTier1Capabilities } from "../../lib/security/tier1";
import type { VaultItemMeta } from "@trustid/device-security";

export function MediaVaultPage() {
  const [caps, setCaps] = useState<BiometricAvailability | null>(null);
  const [items, setItems] = useState<VaultItemMeta[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const vault = getMediaVault();
    setItems(await vault.list());
    setUnlocked(vault.isUnlocked);
  }, []);

  useEffect(() => {
    probeTier1Capabilities().then(setCaps).catch(() => undefined);
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      getMediaVault().lock();
    };
  }, [previewUrl]);

  async function onUnlock() {
    setBusy(true);
    setError(null);
    try {
      await getMediaVault().unlock("Unlock TrustID Media Vault");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unlock failed");
    } finally {
      setBusy(false);
    }
  }

  async function onImport(fileList: FileList | null) {
    if (!fileList?.length) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (!getMediaVault().isUnlocked) {
        await getMediaVault().unlock("Unlock vault to import media");
      }
      for (const file of Array.from(fileList)) {
        const result = await getMediaVault().importFile(file);
        if (result.wipeNote) setNote(result.wipeNote);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onOpen(id: string) {
    setBusy(true);
    setError(null);
    try {
      if (!getMediaVault().isUnlocked) {
        await getMediaVault().unlock("Unlock vault to view media");
      }
      const { bytes, mimeType } = await getMediaVault().decrypt(id);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
      setPreviewUrl(URL.createObjectURL(blob));
      bytes.fill(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decrypt failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(id: string) {
    setBusy(true);
    setError(null);
    try {
      if (!getMediaVault().isUnlocked) {
        await getMediaVault().unlock("Confirm vault delete");
      }
      await getMediaVault().remove(id);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }

  function onLock() {
    getMediaVault().lock();
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setUnlocked(false);
    setItems([]);
  }

  return (
    <div className="dashboard">
      <section className="section surface-block">
        <h2>Secure Media Vault</h2>
        <p className="sub">
          Photos and videos encrypted with AES-256-GCM. Keys unlock only after
          strong biometric verification ù no weak PIN unless you opt in elsewhere.
        </p>
        {caps && (
          <ul className="list compact-list">
            <li className="row">
              <span className="muted">Platform</span>
              <span>{caps.platform}</span>
            </li>
            <li className="row">
              <span className="muted">Hardware-bound keys</span>
              <span className={caps.hardwareBoundKeys ? "status-ok" : "status-off"}>
                {caps.hardwareBoundKeys ? "Yes (Device app)" : "WebAuthn UV gate only"}
              </span>
            </li>
            <li className="row">
              <span className="muted">Secure source wipe</span>
              <span className={caps.secureWipeSupported ? "status-ok" : "status-off"}>
                {caps.secureWipeSupported ? "Supported" : "Manual / Device app"}
              </span>
            </li>
          </ul>
        )}
        <div className="inline-actions">
          {!unlocked ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={onUnlock}>
              Unlock with biometric
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onLock}>
              Lock vault
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Import media
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => onImport(e.target.files)}
          />
        </div>
        {note && <p className="muted">{note}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {previewUrl && (
        <section className="section surface-block">
          <h2>Preview</h2>
          <p className="sub">Decrypted in memory for this session only.</p>
          {previewUrl.match(/video|\.mp4|webm/i) ? (
            <video className="vault-preview" src={previewUrl} controls playsInline />
          ) : (
            <img className="vault-preview" src={previewUrl} alt="Vault preview" />
          )}
        </section>
      )}

      <section className="section surface-block">
        <h2>Vault contents</h2>
        <p className="sub">
          Ciphertext is invisible to system galleries and third-party file pickers
          when running in TrustID Device.
        </p>
        {!unlocked && items.length === 0 ? (
          <p className="muted">Unlock to list encrypted items.</p>
        ) : (
          <ul className="list compact-list">
            {items.map((item) => (
              <li key={item.id} className="row">
                <div className="row-main">
                  <strong>{item.displayName}</strong>
                  <span className="muted">
                    {item.kind} ù {(item.byteLength / 1024).toFixed(1)} KB ù{" "}
                    {item.contentHash.slice(0, 12)}ù
                  </span>
                </div>
                <div className="inline-actions">
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onOpen(item.id)}>
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
            {unlocked && items.length === 0 && (
              <li className="muted">Vault is empty.</li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
