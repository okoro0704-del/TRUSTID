import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  generateVaultDek,
  sha256Hex,
} from "../dist/crypto/aes-gcm.js";

async function main() {
  const key = await generateVaultDek();
  const plain = new TextEncoder().encode("tier1-vault-roundtrip");
  const aad = new TextEncoder().encode("trustid-vault:test");
  const envelope = await aesGcmEncrypt(key, plain, aad);
  const out = await aesGcmDecrypt(key, envelope, aad);
  const text = new TextDecoder().decode(out);
  if (text !== "tier1-vault-roundtrip") throw new Error("AES-GCM roundtrip failed");
  const hash = await sha256Hex(plain);
  if (hash.length !== 64) throw new Error("sha256 length");
  console.log("device-security crypto ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
