import { useEffect, useState } from "react";
import { isDeviceApprovalActive } from "@trustid/shared";
import { useTrustIdAuth } from "../context/TrustIdAuthProvider.js";

export type DeviceApprovalModalProps = {
  open: boolean;
  requestId: string;
  deviceName?: string;
  onClose: () => void;
  onResolved?: (status: string) => void;
  /** WebAuthn reauth ceremony  required before approve/decline. */
  reauthenticate: () => Promise<unknown>;
};

export function DeviceApprovalModal({
  open,
  requestId,
  deviceName,
  onClose,
  onResolved,
  reauthenticate,
}: DeviceApprovalModalProps) {
  const { apiFetch } = useTrustIdAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("pending");

  useEffect(() => {
    if (!open) return;
    setError(null);
    setStatus("pending");
  }, [open, requestId]);

  async function act(action: "approve" | "temporary" | "decline") {
    setBusy(true);
    setError(null);
    try {
      const reauth = await reauthenticate();
      await apiFetch(`/device-approvals/${encodeURIComponent(requestId)}/${action}`, {
        method: "POST",
        body: JSON.stringify(reauth),
      });
      setStatus(action === "decline" ? "declined" : action);
      onResolved?.(action);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="tid-modal-backdrop" role="dialog" aria-modal="true">
      <div className="tid-modal">
        <h2>Device approval</h2>
        <p className="tid-muted">
          {deviceName
            ? `${deviceName} is requesting access.`
            : "A new device is requesting access."}
        </p>
        <p className="tid-muted">
          Status: {status}
          {isDeviceApprovalActive(status) ? " (active)" : ""}
        </p>
        {error && <p className="tid-error">{error}</p>}
        <div className="tid-actions">
          <button
            type="button"
            className="tid-btn tid-btn-primary"
            disabled={busy}
            onClick={() => act("approve")}
          >
            Trust device
          </button>
          <button
            type="button"
            className="tid-btn tid-btn-ghost"
            disabled={busy}
            onClick={() => act("temporary")}
          >
            Temporary access
          </button>
          <button
            type="button"
            className="tid-btn tid-btn-danger"
            disabled={busy}
            onClick={() => act("decline")}
          >
            Decline
          </button>
          <button type="button" className="tid-btn tid-btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
