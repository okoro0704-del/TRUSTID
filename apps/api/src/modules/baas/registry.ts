import {
  HttpDataZoneClient,
  HttpDigiconomyClient,
  HttpElfComClient,
  HttpFinProvClient,
  HttpLidiosClient,
  UnboundDataZoneClient,
  UnboundDigiconomyClient,
  UnboundElfComClient,
  UnboundFinProvClient,
  UnboundLidiosClient,
  summarizeBindings,
  type IDataZoneClient,
  type IDigiconomyClient,
  type IElfComClient,
  type IFinProvClient,
  type ILidiosClient,
  type PrimitiveBinding,
} from "@trustid/baas-sdk";
import { config } from "../../lib/config.js";

let elfcom: IElfComClient = new UnboundElfComClient();
let datazone: IDataZoneClient = new UnboundDataZoneClient();
let finprov: IFinProvClient = new UnboundFinProvClient();
let lidios: ILidiosClient = new UnboundLidiosClient();
let digiconomy: IDigiconomyClient = new UnboundDigiconomyClient();

let bootstrapped = false;

export function bootstrapBaasClients() {
  if (bootstrapped) return;
  bootstrapped = true;

  if (config.elfcom.mode === "http") {
    elfcom = new HttpElfComClient({
      baseUrl: config.elfcom.baseUrl,
      nodeSecret: config.elfcom.nodeSecret,
    });
  } else {
    elfcom = new UnboundElfComClient();
  }

  if (config.datazone.mode === "http") {
    datazone = new HttpDataZoneClient({
      baseUrl: config.datazone.baseUrl,
      jwtSecret: config.datazone.jwtSecret,
      issuer: config.datazone.issuer,
      audience: config.datazone.audience,
    });
  } else {
    datazone = new UnboundDataZoneClient();
  }

  if (config.finprov.mode === "http") {
    finprov = new HttpFinProvClient({
      baseUrl: config.finprov.baseUrl,
      apiKey: config.finprov.apiKey,
    });
  } else if (config.finprov.mode === "embedded") {
    // Embedded shim is registered by bbs module after import to avoid cycles.
    finprov = new UnboundFinProvClient();
  } else {
    finprov = new UnboundFinProvClient();
  }

  if (config.lidios.mode === "http") {
    lidios = new HttpLidiosClient({ baseUrl: config.lidios.baseUrl });
  } else {
    lidios = new UnboundLidiosClient();
  }

  if (config.digiconomy.mode === "http") {
    digiconomy = new HttpDigiconomyClient({ baseUrl: config.digiconomy.baseUrl });
  } else {
    digiconomy = new UnboundDigiconomyClient();
  }
}

export function getElfComClient() {
  return elfcom;
}
export function setElfComClient(next: IElfComClient) {
  elfcom = next;
}

export function getDataZoneClient() {
  return datazone;
}
export function setDataZoneClient(next: IDataZoneClient) {
  datazone = next;
}

export function getFinProvClient() {
  return finprov;
}
export function setFinProvClient(next: IFinProvClient) {
  finprov = next;
}

export function getLidiosClient() {
  return lidios;
}
export function getDigiconomyClient() {
  return digiconomy;
}

export function getBaasBindings(): PrimitiveBinding[] {
  return summarizeBindings({
    elfcom: {
      bound: elfcom.bound,
      mode: config.elfcom.mode,
      baseUrl: elfcom.baseUrl,
    },
    datazone: {
      bound: datazone.bound,
      mode: config.datazone.mode,
      baseUrl: datazone.baseUrl,
    },
    finprov: {
      bound: finprov.bound || config.finprov.mode === "embedded",
      mode: config.finprov.mode,
      baseUrl: finprov.baseUrl,
    },
    lidios: {
      bound: lidios.bound,
      mode: config.lidios.mode,
      baseUrl: lidios.baseUrl,
    },
    digiconomy: {
      bound: digiconomy.bound,
      mode: config.digiconomy.mode,
      baseUrl: digiconomy.baseUrl,
    },
  });
}
