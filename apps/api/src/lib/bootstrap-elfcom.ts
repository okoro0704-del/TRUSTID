import { config } from "../lib/config.js";
import {
  HttpElfComConsentDispatcher,
  UnboundElfComConsentDispatcher,
  getElfComConsentDispatcher,
  setElfComConsentDispatcher,
} from "../modules/elfcom/index.js";

/** Bind ElfCom consent push dispatcher from environment (skips if already bound). */
export function bootstrapElfComDispatcher() {
  if (getElfComConsentDispatcher().bound) return;

  if (config.elfcom.mode === "http") {
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
