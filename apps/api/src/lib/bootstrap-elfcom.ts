import {
  HttpElfComConsentDispatcher,
  UnboundElfComConsentDispatcher,
  getElfComConsentDispatcher,
  setElfComConsentDispatcher,
} from "../modules/elfcom/index.js";
import { bootstrapBaasClients, getElfComClient } from "../modules/baas/registry.js";
import { config } from "./config.js";
import { registerEmbeddedFinProvIfNeeded } from "../modules/bbs/finprov-embedded.js";

/**
 * Bind all five BaaS consumers + keep legacy ElfCom consent dispatcher in sync.
 * Skips overwriting an already-bound dispatcher (tests inject MockElfCom).
 */
export function bootstrapElfComDispatcher() {
  bootstrapBaasClients();
  registerEmbeddedFinProvIfNeeded();

  if (getElfComConsentDispatcher().bound) return;

  const client = getElfComClient();
  if (client.bound && config.elfcom.mode === "http") {
    setElfComConsentDispatcher(
      new HttpElfComConsentDispatcher({
        baseUrl: config.elfcom.baseUrl,
        nodeSecret: config.elfcom.nodeSecret,
      }),
    );
    return;
  }
  setElfComConsentDispatcher(new UnboundElfComConsentDispatcher());
}
