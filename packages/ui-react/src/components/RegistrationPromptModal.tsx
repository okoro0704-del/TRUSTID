import type { ReactNode } from "react";

export type RegistrationPromptModalProps = {
  isOpen: boolean;
  onAccept: () => void;
  onDecline: () => void;
  title?: string;
  message?: ReactNode;
};

/**
 * Shown after face lookup returns NOT_FOUND.
 * No database write happens until the user accepts.
 */
export function RegistrationPromptModal({
  isOpen,
  onAccept,
  onDecline,
  title = "No Trust ID Found",
  message,
}: RegistrationPromptModalProps) {
  if (!isOpen) return null;

  return (
    <div className="tid-modal-backdrop" role="dialog" aria-modal="true">
      <div className="tid-modal" style={{ maxWidth: 400, textAlign: "center" }}>
        <h2>{title}</h2>
        <p className="tid-muted" style={{ marginBottom: "1.25rem" }}>
          {message ?? (
            <>
              We scanned your biometrics, but there are no matching records on
              the protocol network.
              <br />
              <br />
              Would you like to create a new Trust ID account now?
            </>
          )}
        </p>
        <div className="tid-actions" style={{ flexDirection: "column", gap: "0.55rem" }}>
          <button type="button" className="tid-btn tid-btn-primary" onClick={onAccept}>
            Create Trust ID
          </button>
          <button type="button" className="tid-btn tid-btn-ghost" onClick={onDecline}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
