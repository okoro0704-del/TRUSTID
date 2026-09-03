import { useEffect, useState } from "react";
import { isDeviceApprovalActive } from "@trustid/shared";
import { useTrustIdAuth } from "../context/TrustIdAuthProvider.js";
import {
  MasterApprovalModal,
  type MasterApprovalAction,
} from "./MasterApprovalModal.js";

export type DeviceApprovalModalProps = {
  open: boolean;
  requestId: string;
  deviceName?: string;
  ipAddress?: string;
  applicationName?: string;
  onClose: () => void;
  onResolved?: (status: string) => void;
  /** WebAuthn reauth ceremony — optional for face-first masters with no passkey. */
  reauthenticate?: () => Promise<unknown>;
};

export function DeviceApprovalModal({
  open,
  requestId,
  deviceName,
  ipAddress,
  applicationName,
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

  async function act(action: MasterApprovalAction) {
    setBusy(true);
    setError(null);
    try {
      let response: unknown;
      if (reauthenticate) {
        try {
          response = await reauthenticate();
        } catch {
          response = undefined;
        }
      }
      await apiFetch("/v1/auth/device-approval/respond", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          action,
          ...(response ? { response } : {}),
        }),
      });
      setStatus(action === "DECLINE" ? "declined" : action.toLowerCase());
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
    <MasterApprovalModal
      requestData={{
        requestId,
        deviceMeta: deviceName ?? "Unknown device",
        ipAddress,
        applicationName,
      }}
      busy={busy}
      error={
        error ??
        (isDeviceApprovalActive(status) ? null : status !== "pending" ? status : null)
      }
      onRespond={act}
      onClose={onClose}
    />
  );
}
