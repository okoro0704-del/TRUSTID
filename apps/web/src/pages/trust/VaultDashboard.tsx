import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AppLockGuardOverlay,
  DeviceApprovalModal,
  VaultProtectedMediaViewer,
  useTrustIdSession,
} from "@trustid/ui-react";
import type { AppLockConfig, EsfsManifest, StepUpPolicy } from "@trustid/vault-sdk";
import { DEFAULT_APP_LOCK_CONFIG, DEFAULT_STEP_UP_POLICY } from "@trustid/vault-sdk";
import { reauthenticate } from "../../lib/reauth";
import { getTier1Gate, probeTier1Capabilities } from "../../lib/security/tier1";
import {
  getSovereignVault,
  persistEsfsAsset,
  removeEsfsAsset,
} from "../../lib/security/vault";

const WEB_APP_SUGGESTIONS = [
  { appId: "com.whatsapp", displayName: "WhatsApp" },
  { appId: "com.google.android.apps.photos", displayName: "Google Photos" },
  { appId: "lifeos.finprov", displayName: "LifeOS FinProv" },
];

const ROUTE_SUGGESTIONS = [
  { path: "/dashboard/vault", sensitivity: "critical" as const },
  { path: "/dashboard/identity", sensitivity: "high" as const },
];

export function VaultDashboardPage() {
  const vault = useMemo(() => getSovereignVault(), []);
  const { approvalEvents, realtimeState, clearApprovalEvents } = useTrustIdSession();

  const [config, setConfig] = useState<AppLockConfig>(DEFAULT_APP_LOCK_CONFIG);
  const [stepUpPolicy, setStepUpPolicy] = useState<StepUpPolicy>(DEFAULT_STEP_UP_POLICY);
  const [manifests, setManifests] = useState<EsfsManifest[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [capsNote, setCapsNote] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [duressState, setDuressState] = useState(vault.duress.getState());
  const [approvalModal, setApprovalModal] = useState<{
    requestId: string;
    deviceName?: string;
  } | null>(null);
  const [customRoute, setCustomRoute] = useState("");
  const [customAppId, setCustomAppId] = useState("");
  const [customAppName, setCustomAppName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const loaded = await vault.getAppLockConfig();
    setConfig(loaded);
    setManifests(vault.esfs.listManifests());
    setDuressState(vault.duress.getState());
  }, [vault]);

  useEffect(() => {
    probeTier1Capabilities()
      .then((caps) => {
        setCapsNote(
          `${caps.platform} ? UV ${caps.enrolled ? "enrolled" : "not enrolled"} ? realtime ${realtimeState}`,
        );
      })
      .catch(() => undefined);
    refresh().catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load vault"),
    );
  }, [refresh, realtimeState]);

  useEffect(() => {
    const latest = approvalEvents[0];
    if (!latest || latest.type !== "approval_created") return;
    setApprovalModal({
      requestId: latest.requestId,
      deviceName: latest.deviceName,
    });
  }, [approvalEvents]);

  async function saveConfig(next: AppLockConfig) {
    setBusy(true);
    setError(null);
    try {
      await vault.saveAppLockConfig(next);
      setConfig(next);
      setNote("App lock registry saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onImport(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (!vault.dakSession.isUnlocked) {
        const auth = await vault.dakSession.unlock("Unlock vault to import media");
        if (auth.duress) {
          await vault.duress.handleDuress({ config });
          setDuressState(vault.duress.getState());
          setNote("Duress detected ? vault locked and alert dispatched.");
          return;
        }
      }
      for (const file of Array.from(files)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const assetId = crypto.randomUUID();
        const manifest = await vault.esfs.encryptAsset({
          assetId,
          mimeType: file.type || "application/octet-stream",
          displayName: file.name,
          bytes,
        });
        await persistEsfsAsset(vault, assetId);
        bytes.fill(0);
        setSelectedAssetId(manifest.assetId);
      }
      await refresh();
      setNote("Media encrypted into eSFS.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onRemoveAsset(assetId: string) {
    setBusy(true);
    setError(null);
    try {
      if (!vault.dakSession.isUnlocked) {
        await vault.dakSession.unlock("Confirm delete");
      }
      await removeEsfsAsset(vault, assetId);
      if (selectedAssetId === assetId) setSelectedAssetId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function testStepUp() {
    setBusy(true);
    setError(null);
    try {
      await vault.stepUp.ensureStepUp({
        routeSensitivity: "critical",
        action: "view_encrypted_video",
      });
      setNote("Step-up challenge passed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Step-up failed");
    } finally {
      setBusy(false);
    }
  }

  async function simulateDuress() {
    setBusy(true);
    setError(null);
    try {
      const result = await vault.duress.handleDuress({ config });
      vault.lock();
      setDuressState(vault.duress.getState());
      setNote(
        result.alertDispatched
          ? "Duress alert dispatched via ElfCom."
          : "Duress lockout active (ElfCom not configured in env).",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Duress simulation failed");
    } finally {
      setBusy(false);
    }
  }

  async function addProtectedApp(app: { appId: string; displayName: string }) {
    const next = await vault.registry.addProtectedApp({
      appId: app.appId,
      packageId: app.appId,
      displayName: app.displayName,
    });
    await saveConfig(next);
  }

  async function addRoute(path: string) {
    const next = await vault.registry.addProtectedRoute({
      path,
      sensitivity: "high",
    });
    await saveConfig(next);
  }

  async function onCustomApp(e: FormEvent) {
    e.preventDefault();
    if (!customAppId.trim()) return;
    await addProtectedApp({
      appId: customAppId.trim(),
      displayName: customAppName.trim() || customAppId.trim(),
    });
    setCustomAppId("");
    setCustomAppName("");
  }

  if (duressState.decoyMode) {
    return (
      <div className="dashboard">
        <section className="section surface-block">
          <h2>Trust Center</h2>
          <p className="sub">Your account overview and recent activity.</p>
          <p className="muted">No sensitive vault data is shown in decoy mode.</p>
        </section>
      </div>
    );
  }

  return (
    <AppLockGuardOverlay
      path="/dashboard/vault"
      routeGuard={vault.routeGuard}
      reason="Unlock Sovereign Vault dashboard"
    >
      <div className="dashboard">
        <section className="section surface-block">
          <h2>Sovereign Vault</h2>
          <p className="sub">
            Hardware-gated DAK/CDK encryption, app lock registry, risk-based step-up,
            and duress handling ? zero server knowledge of plaintext media.
          </p>
          {capsNote && <p className="muted">{capsNote}</p>}
          <div className="inline-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              Import encrypted media
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={testStepUp}>
              Test biometric step-up
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                vault.lock();
                setNote("DAK session locked.");
              }}
            >
              Lock DAK
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="video/*,image/*"
            multiple
            hidden
            onChange={(e) => onImport(e.target.files)}
          />
          {note && <p className="muted">{note}</p>}
          {error && <p className="error">{error}</p>}
        </section>

        <section className="section surface-block">
          <h2>Encrypted media (eSFS)</h2>
          <ul className="list compact-list">
            {manifests.map((m) => (
              <li key={m.assetId} className="row">
                <div className="row-main">
                  <strong>{m.displayName}</strong>
                  <span className="muted">
                    {m.mimeType} ? {m.chunkCount} chunks ? {m.contentHash.slice(0, 12)}?
                  </span>
                </div>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => setSelectedAssetId(m.assetId)}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => onRemoveAsset(m.assetId)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
            {manifests.length === 0 && (
              <li className="muted">No encrypted assets yet.</li>
            )}
          </ul>

          {selectedAssetId && (
            <VaultProtectedMediaViewer
              esfs={vault.esfs}
              dakSession={vault.dakSession}
              gate={getTier1Gate()}
              assetId={selectedAssetId}
              onDuress={async () => {
                await vault.duress.handleDuress({ config });
                setDuressState(vault.duress.getState());
              }}
            />
          )}
        </section>

        <section className="section surface-block">
          <h2>App lock registry</h2>
          <label className="check-row">
            <input
              type="checkbox"
              checked={config.enabled}
              disabled={busy}
              onChange={() => saveConfig({ ...config, enabled: !config.enabled })}
            />
            <span>Enable app lock policy</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={config.duressEnabled}
              disabled={busy}
              onChange={() =>
                saveConfig({ ...config, duressEnabled: !config.duressEnabled })
              }
            />
            <span>Enable duress biometric slot</span>
          </label>
          {config.duressEnabled && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={simulateDuress}>
              Simulate duress lockout
            </button>
          )}

          <h3>Protected apps</h3>
          <ul className="list compact-list">
            {config.protectedApps.map((app) => (
              <li key={app.appId} className="row">
                <div className="row-main">
                  <strong>{app.displayName}</strong>
                  <span className="muted tid">{app.appId}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className="hub-grid">
            {WEB_APP_SUGGESTIONS.filter(
              (s) => !config.protectedAppIds.includes(s.appId),
            ).map((s) => (
              <button
                key={s.appId}
                type="button"
                className="hub-card hub-card-btn"
                disabled={busy}
                onClick={() => addProtectedApp(s)}
              >
                <strong>{s.displayName}</strong>
                <span className="muted">{s.appId}</span>
              </button>
            ))}
          </div>
          <form className="stack-form" onSubmit={onCustomApp}>
            <div className="field">
              <label htmlFor="vaultAppId">App / package ID</label>
              <input
                id="vaultAppId"
                value={customAppId}
                onChange={(e) => setCustomAppId(e.target.value)}
                placeholder="com.example.app"
              />
            </div>
            <div className="field">
              <label htmlFor="vaultAppName">Display name</label>
              <input
                id="vaultAppName"
                value={customAppName}
                onChange={(e) => setCustomAppName(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || !customAppId.trim()}>
              Add protected app
            </button>
          </form>

          <h3>Protected routes</h3>
          <ul className="list compact-list">
            {config.protectedRoutes.map((route) => (
              <li key={route.path} className="row">
                <span>{route.path}</span>
                <span className="muted">{route.sensitivity}</span>
              </li>
            ))}
          </ul>
          <div className="inline-actions">
            {ROUTE_SUGGESTIONS.filter(
              (r) => !config.protectedRoutes.some((x) => x.path === r.path),
            ).map((r) => (
              <button
                key={r.path}
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => addRoute(r.path)}
              >
                Lock {r.path}
              </button>
            ))}
          </div>
          <form
            className="stack-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!customRoute.trim()) return;
              addRoute(customRoute.trim());
              setCustomRoute("");
            }}
          >
            <div className="field">
              <label htmlFor="vaultRoute">Custom route prefix</label>
              <input
                id="vaultRoute"
                value={customRoute}
                onChange={(e) => setCustomRoute(e.target.value)}
                placeholder="/dashboard/security"
              />
            </div>
            <button type="submit" className="btn btn-ghost" disabled={busy || !customRoute.trim()}>
              Add protected route
            </button>
          </form>
        </section>

        <section className="section surface-block">
          <h2>Risk step-up policy</h2>
          <div className="field">
            <label htmlFor="sessionAge">Max session age (minutes)</label>
            <input
              id="sessionAge"
              type="number"
              min={1}
              max={120}
              value={Math.round(stepUpPolicy.maxSessionAgeMs / 60_000)}
              onChange={(e) => {
                const minutes = Number(e.target.value) || 15;
                const next = {
                  ...stepUpPolicy,
                  maxSessionAgeMs: minutes * 60_000,
                };
                setStepUpPolicy(next);
                vault.stepUp.updatePolicy(next);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="riskThreshold">Risk threshold (0?100)</label>
            <input
              id="riskThreshold"
              type="number"
              min={0}
              max={100}
              value={stepUpPolicy.riskThreshold}
              onChange={(e) => {
                const next = {
                  ...stepUpPolicy,
                  riskThreshold: Number(e.target.value) || 60,
                };
                setStepUpPolicy(next);
                vault.stepUp.updatePolicy(next);
              }}
            />
          </div>
        </section>

        {approvalModal && (
          <DeviceApprovalModal
            open
            requestId={approvalModal.requestId}
            deviceName={approvalModal.deviceName}
            reauthenticate={reauthenticate}
            onClose={() => {
              setApprovalModal(null);
              clearApprovalEvents();
            }}
          />
        )}
      </div>
    </AppLockGuardOverlay>
  );
}
