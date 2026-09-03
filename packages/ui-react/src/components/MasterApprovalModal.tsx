import { useState } from "react";

export type MasterApprovalAction = "TRUST" | "TEMPORARY" | "DECLINE";

export type MasterApprovalModalProps = {
  requestData: {
    requestId: string;
    deviceMeta: string;
    ipAddress?: string;
    applicationName?: string;
  };
  busy?: boolean;
  error?: string | null;
  onRespond: (action: MasterApprovalAction) => void;
  onClose?: () => void;
};

/**
 * Master Device prompt for secondary-device login attempts.
 * Actions: Trust (remember), Temporary (one-time), Decline.
 */
export function MasterApprovalModal({
  requestData,
  busy = false,
  error,
  onRespond,
  onClose,
}: MasterApprovalModalProps) {
  const [localBusy, setLocalBusy] = useState(false);
  const disabled = busy || localBusy;

  async function respond(action: MasterApprovalAction) {
    setLocalBusy(true);
    try {
      await Promise.resolve(onRespond(action));
    } finally {
      setLocalBusy(false);
    }
  }

  return (
    <div className="tid-modal-backdrop" role="dialog" aria-modal="true">
      <div className="tid-modal" style={{ maxWidth: 420 }}>
        <h2>New Device Authorization</h2>
        <p className="tid-muted">
          A new device is trying to access your account
          {requestData.applicationName ? ` via ${requestData.applicationName}` : ""}.
        </p>

        <div
          style={{
            margin: "1rem 0",
            padding: "0.85rem 1rem",
            borderRadius: 12,
            background: "rgba(15, 23, 42, 0.06)",
            fontSize: "0.92rem",
          }}
        >
          <p>
            <strong>Device:</strong> {requestData.deviceMeta}
          </p>
          {requestData.ipAddress ? (
            <p>
              <strong>IP:</strong> {requestData.ipAddress}
            </p>
          ) : null}
        </div>

        {error ? <p className="tid-error">{error}</p> : null}

        <div className="tid-actions" style={{ flexDirection: "column", gap: "0.55rem" }}>
          <button
            type="button"
            className="tid-btn tid-btn-primary"
            disabled={disabled}
            onClick={() => void respond("TRUST")}
          >
            Trust Device (Remember)
          </button>
          <button
            type="button"
            className="tid-btn"
            disabled={disabled}
            onClick={() => void respond("TEMPORARY")}
          >
            Allow Temporary Access (One-time)
          </button>
          <button
            type="button"
            className="tid-btn tid-btn-danger"
            disabled={disabled}
            onClick={() => void respond("DECLINE")}
          >
            Decline & Deny Access
          </button>
          {onClose ? (
            <button type="button" className="tid-btn tid-btn-ghost" onClick={onClose}>
              Dismiss
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
