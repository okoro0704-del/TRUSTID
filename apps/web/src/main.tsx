import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TrustIdAuthProvider } from "@trustid/ui-react";
import "@trustid/ui-react/styles.css";
import { App } from "./App";
import { rememberFromIdentity } from "./lib/rememberedAccount";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <TrustIdAuthProvider
        apiBaseUrl={import.meta.env.VITE_API_URL ?? "/api"}
        enableRealtime
        onIdentityChange={(identity) => {
          if (identity) rememberFromIdentity(identity);
        }}
      >
        <App />
      </TrustIdAuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
