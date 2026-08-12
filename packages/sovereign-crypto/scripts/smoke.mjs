import {
  combineShares,
  encodePreKeyBundle,
  generateIdentityMaterial,
  generateOneTimePreKeys,
  generateSignedPreKey,
  openWithSessionKey,
  sealWithSessionKey,
  splitSecret,
  x3dhInitiate,
  x3dhRespond,
} from "../dist/index.js";

async function main() {
  const secret = new TextEncoder().encode("trustid-recovery-master-key!!");
  const shares = splitSecret(secret, 3, 5);
  const rebuilt = combineShares(shares.slice(0, 3));
  if (new TextDecoder().decode(rebuilt) !== "trustid-recovery-master-key!!") {
    throw new Error("shamir failed");
  }

  const bob = await generateIdentityMaterial();
  const bobSpk = await generateSignedPreKey(bob.signing.privateKey, 1);
  const bobOpks = await generateOneTimePreKeys(1);
  const bundle = encodePreKeyBundle({
    identity: bob.identity,
    signing: bob.signing,
    signedPreKey: bobSpk,
    oneTime: bobOpks[0],
  });

  const alice = await generateIdentityMaterial();
  const init = await x3dhInitiate(alice.identity, bundle);
  const bobSession = await x3dhRespond({
    bobIdentity: bob.identity,
    bobSignedPreKey: bobSpk.keyPair,
    bobOneTimePreKey: bobOpks[0].keyPair,
    header: init.header,
  });

  const msg = new TextEncoder().encode('{"vaultMeta":true}');
  const sealed = await sealWithSessionKey(init.sessionKey, msg);
  const opened = await openWithSessionKey(bobSession, sealed.nonce, sealed.ciphertext);
  if (new TextDecoder().decode(opened) !== '{"vaultMeta":true}') {
    throw new Error("x3dh session seal failed");
  }

  console.log("sovereign-crypto smoke ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
