import {
  HttpDataZoneClient,
  HttpDigiconomyClient,
  HttpElfComClient,
  HttpFinProvClient,
  HttpLidiosClient,
  HttpMasterDistributionClient,
  HttpPlatformJobClient,
  UnboundDataZoneClient,
  UnboundDigiconomyClient,
  UnboundElfComClient,
  UnboundFinProvClient,
  UnboundLidiosClient,
  UnboundMasterDistributionClient,
  UnboundPlatformJobClient,
  summarizeBindings,
  type IDataZoneClient,
  type IDigiconomyClient,
  type IElfComClient,
  type IFinProvClient,
  type ILidiosClient,
  type IMasterDistributionClient,
  type IPlatformJobClient,
  type PrimitiveBinding,
} from "@trustid/baas-sdk";
import { config } from "../../lib/config.js";

let elfcom: IElfComClient = new UnboundElfComClient();
let datazone: IDataZoneClient = new UnboundDataZoneClient();
let finprov: IFinProvClient = new UnboundFinProvClient();
let platformJob: IPlatformJobClient = new UnboundPlatformJobClient();
let masterDistribution: IMasterDistributionClient =
  new UnboundMasterDistributionClient();
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
      baasApiKey: config.elfcom.baasApiKey || undefined,
      appId: config.elfcom.appId,
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
    finprov = new UnboundFinProvClient();
  } else {
    finprov = new UnboundFinProvClient();
  }

  if (config.platformJob.mode === "http") {
    platformJob = new HttpPlatformJobClient({
      baseUrl: config.platformJob.baseUrl,
      jwtSecret: config.platformJob.jwtSecret,
      issuer: config.platformJob.issuer,
      audience: config.platformJob.audience,
    });
  } else {
    platformJob = new UnboundPlatformJobClient();
  }

  if (config.masterDistribution.mode === "http") {
    masterDistribution = new HttpMasterDistributionClient({
      baseUrl: config.masterDistribution.baseUrl,
      jwtSecret: config.masterDistribution.jwtSecret,
      issuer: config.masterDistribution.issuer,
      audience: config.masterDistribution.audience,
    });
  } else {
    masterDistribution = new UnboundMasterDistributionClient();
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

export function getPlatformJobClient() {
  return platformJob;
}
export function setPlatformJobClient(next: IPlatformJobClient) {
  platformJob = next;
}

export function getMasterDistributionClient() {
  return masterDistribution;
}
export function setMasterDistributionClient(next: IMasterDistributionClient) {
  masterDistribution = next;
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
    platformJob: {
      bound: platformJob.bound,
      mode: config.platformJob.mode,
      baseUrl: platformJob.baseUrl,
    },
    masterDistribution: {
      bound: masterDistribution.bound,
      mode: config.masterDistribution.mode,
      baseUrl: masterDistribution.baseUrl,
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
