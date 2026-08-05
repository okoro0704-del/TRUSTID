type Approval = {
  id: string;
  applicationName: string;
  deviceName: string;
  platform: string | null;
  browser: string | null;
  location: string | null;
  createdAt: string;
};

export function ApproveDeviceDialog({
  request,
  busy,
  onClose,
  onTrust,
  onTemporary,
  onDecline,
}: {
  request: Approval;
  busy: boolean;
  onClose: () => void;
  onTrust: () => void;
  onTemporary: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approve-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="approve-title">Approve device?</h2>
        <p className="sub">
          {request.applicationName} is requesting access from{" "}
          <strong>{request.deviceName}</strong>.
        </p>
        <ul className="list">
          <li className="row">
            <span className="muted">Browser</span>
            <span>{request.browser ?? "—"}</span>
          </li>
          <li className="row">
            <span className="muted">Platform</span>
            <span>{request.platform ?? "—"}</span>
          </li>
          <li className="row">
            <span className="muted">Location</span>
            <span>{request.location ?? "Unavailable"}</span>
          </li>
          <li className="row">
            <span className="muted">Time</span>
            <span>{new Date(request.createdAt).toLocaleString()}</span>
          </li>
        </ul>
        <p className="muted">
          Each action requires your passkey / biometric on this primary device.
        </p>
        <div className="inline-actions" style={{ flexWrap: "wrap" }}>
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            onClick={onTrust}
          >
            Trust this device
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            onClick={onTemporary}
          >
            Allow temporary access
          </button>
          <button
            className="btn btn-danger"
            type="button"
            disabled={busy}
            onClick={onDecline}
          >
            Decline
          </button>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
