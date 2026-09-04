import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

export function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [via, setVia] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const data = await api<{
      items: Notification[];
      unread: number;
      via?: string;
    }>("/notifications");
    setItems(data.items);
    setUnread(data.unread);
    setVia(data.via ?? null);
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
    const t = setInterval(() => load().catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, []);

  async function markRead(id: string) {
    await api(`/notifications/${id}/read`, { method: "POST", body: "{}" });
    await load();
  }

  return (
    <div className="dashboard">
      <section className="section">
        <h2>Security notifications</h2>
        <p className="sub">
          Alerts for primary devices ({unread} unread)
          {via ? ` · via ${via}` : ""}. Delivery is owned by ElfCom when bound.
        </p>
        <ul className="list">
          {items.map((n) => (
            <li key={n.id} className="row">
              <div className="row-main">
                <strong>
                  {n.title}
                  {!n.readAt ? " · New" : ""}
                </strong>
                <span className="muted">{n.body}</span>
                <span className="muted">
                  {new Date(n.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="inline-actions">
                {n.type === "device_approval_request" && (
                  <Link className="btn btn-primary" to="/dashboard/approvals">
                    Review
                  </Link>
                )}
                {!n.readAt && (
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => markRead(n.id)}
                  >
                    Mark read
                  </button>
                )}
              </div>
            </li>
          ))}
          {items.length === 0 && (
            <li className="row">
              <span className="muted">No notifications yet</span>
            </li>
          )}
        </ul>
      </section>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
