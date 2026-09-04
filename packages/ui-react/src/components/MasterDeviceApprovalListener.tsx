import { useCallback, useEffect, useState } from "react";
import { useTrustIdAuth } from "../context/TrustIdAuthProvider.js";
import {
  MasterApprovalModal,
  type MasterApprovalAction,
} from "./MasterApprovalModal.js";

type PendingPrompt = {
  requestId: string;
  deviceMeta: string;
  ipAddress?: string;
  applicationName?: string;
};

/**
 * Global Master Device listener:
 * - Opens approval modal on WebSocket DEVICE_APPROVAL_REQUEST / approval.created
 * - Falls back to polling /device-approvals/pending every few seconds
 * - Responds via /v1/auth/device-approval/respond
 */
export function MasterDeviceApprovalListener({
  reauthenticate,
}: {
  /** Optional WebAuthn ceremony; skipped automatically when no passkey exists. */
  reauthenticate?: () => Promise<unknown>;
}) {
  const { identity, apiFetch, approvalEvents, clearApprovalEvents } = useTrustIdAuth();
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openFromPending = useCallback(async () => {
    if (!identity || prompt) return;
    try {
      const pending = await apiFetch<
        Array<{
          id: string;
          deviceName: string;
          applicationName?: string;
          ip?: string | null;
        }>
      >("/device-approvals/pending");
      const first = pending[0];
      if (!first) return;
      setPrompt({
        requestId: first.id,
        deviceMeta: first.deviceName,
        applicationName: first.applicationName,
        ipAddress: first.ip ?? undefined,
      });
    } catch {
      /* ignore poll errors */
    }
  }, [apiFetch, identity, prompt]);

  useEffect(() => {
    if (!identity) return;
    const latest = approvalEvents[0];
    if (!latest) return;
    if (
      latest.type === "approval_created" ||
      latest.type === "DEVICE_APPROVAL_REQUEST" ||
      latest.type === "MASTER_APPROVAL_REQUEST"
    ) {
      setPrompt({
        requestId: latest.requestId,
        deviceMeta: latest.deviceName ?? "Unknown device",
        ipAddress: latest.ipAddress,
        applicationName: latest.applicationName,
      });
      const title = "Login Approval Requested";
      const body = `New login attempt from ${latest.deviceName ?? "a device"}. Tap to approve or decline.`;
      // Capacitor native heads-up (Android IMPORTANCE_HIGH)
      try {
        const heads = (
          window as Window & {
            TrustIdHeadsUp?: {
              showApproval: (o: {
                title?: string;
                body: string;
                requestId: string;
              }) => Promise<unknown>;
            };
          }
        ).TrustIdHeadsUp;
        if (heads?.showApproval) {
          void heads.showApproval({
            title,
            body,
            requestId: latest.requestId,
          });
        } else if (
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          new Notification(title, {
            body,
            tag: latest.requestId,
            requireInteraction: true,
          });
        } else if (
          typeof Notification !== "undefined" &&
          Notification.permission === "default"
        ) {
          void Notification.requestPermission();
        }
      } catch {
        /* ignore */
      }
    }
  }, [approvalEvents, identity]);

  useEffect(() => {
    if (!identity) return;
    void openFromPending();
    const t = window.setInterval(() => {
      void openFromPending();
    }, 4000);
    return () => window.clearInterval(t);
  }, [identity, openFromPending]);

  async function onRespond(action: MasterApprovalAction) {
    if (!prompt) return;
    setBusy(true);
    setError(null);
    try {
      let response: unknown;
      if (reauthenticate) {
        try {
          response = await reauthenticate();
        } catch {
          // Face-first masters may have no passkey — server allows session confirm.
          response = undefined;
        }
      }
      await apiFetch("/v1/auth/device-approval/respond", {
        method: "POST",
        body: JSON.stringify({
          requestId: prompt.requestId,
          action,
          ...(response ? { response } : {}),
        }),
      });
      clearApprovalEvents();
      setPrompt(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to process approval");
    } finally {
      setBusy(false);
    }
  }

  if (!prompt) return null;

  return (
    <MasterApprovalModal
      requestData={prompt}
      busy={busy}
      error={error}
      onRespond={onRespond}
      onClose={() => setPrompt(null)}
    />
  );
}
