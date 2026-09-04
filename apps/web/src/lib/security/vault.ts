import {
  HttpElfComEmergencyBridge,
  SovereignVault,
  DEFAULT_STEP_UP_POLICY,
  type StepUpPolicy,
} from "@trustid/vault-sdk";
import { getTier1Gate } from "./tier1";
import {
  deleteEsfsAsset,
  loadAllEsfsAssets,
  saveEsfsAsset,
} from "./vault-store";

let vaultSingleton: SovereignVault | null = null;

function elfcomBridge(): HttpElfComEmergencyBridge | undefined {
  const baseUrl =
    (import.meta.env.VITE_ELFCOM_BASE_URL as string | undefined) ||
    "https://elfcomnode-production.up.railway.app";
  const nodeSecret = import.meta.env.VITE_ELFCOM_NODE_SECRET as string | undefined;
  if (!nodeSecret) return undefined;
  return new HttpElfComEmergencyBridge({ baseUrl, nodeSecret });
}

export function getSovereignVault(stepUpPolicy?: StepUpPolicy): SovereignVault {
  if (!vaultSingleton) {
    vaultSingleton = new SovereignVault({
      gate: getTier1Gate(),
      elfcom: elfcomBridge(),
      stepUpPolicy: stepUpPolicy ?? DEFAULT_STEP_UP_POLICY,
      storage: localStorage,
    });
    hydrateEsfsFromIndexedDb(vaultSingleton).catch(() => undefined);
  }
  return vaultSingleton;
}

async function hydrateEsfsFromIndexedDb(vault: SovereignVault): Promise<void> {
  const assets = await loadAllEsfsAssets();
  for (const asset of assets) {
    vault.esfs.loadAsset(asset.manifest, asset.chunks);
  }
}

export async function persistEsfsAsset(
  vault: SovereignVault,
  assetId: string,
): Promise<void> {
  const exported = vault.esfs.exportAsset(assetId);
  if (!exported) throw new Error("Asset not found in eSFS");
  await saveEsfsAsset(exported);
}

export async function removeEsfsAsset(
  vault: SovereignVault,
  assetId: string,
): Promise<void> {
  vault.esfs.removeAsset(assetId);
  await deleteEsfsAsset(assetId);
}

export function resetSovereignVaultForTests(): void {
  vaultSingleton = null;
}
