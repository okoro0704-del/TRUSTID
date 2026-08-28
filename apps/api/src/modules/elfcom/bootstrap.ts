import {
  HttpElfComConsentDispatcher,
  UnboundElfComConsentDispatcher,
  getElfComConsentDispatcher,
  setElfComConsentDispatcher,
} from "../elfcom/dispatcher.js";
import { config } from "../../lib/config.js";

let initialized = false;

/** Bind ElfCom HTTP dispatcher from env unless tests injected a custom provider. */
export function initElfComConsentDispatcher() {
  if (initialized) return getElfComConsentDispatcher();
  initialized = true;

  const current = getElfComConsentDispatcher();
  if (current.bound) return current;

  if (config.elfcom.mode === "http") {
    setElfComConsentDispatcher(
      new HttpElfComConsentDispatcher({
        baseUrl: config.elfcom.baseUrl,
        nodeSecret: config.elfcom.nodeSecret,
      }),
    );
  } else {
    setElfComConsentDispatcher(new UnboundElfComConsentDispatcher());
  }
  return getElfComConsentDispatcher();
}
