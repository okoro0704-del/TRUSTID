import { beginTrustIdLogin } from "../lib/oauth";

export function Home() {
  return (
    <div className="wrap">
      <h1>LifeOS</h1>
      <p>
        Mock client demonstrating TrustID authentication. LifeOS does not create
        its own consumer identity — it requests scoped authorization from TrustID.
      </p>
      <button className="btn" onClick={() => beginTrustIdLogin()}>
        Continue with TrustID
      </button>
    </div>
  );
}
