import { commitContact, commitName } from "../../src/lib/crypto.js";
import { prisma } from "../../src/db/client.js";

/** Create a user with commitments only — no plaintext PII columns. */
export async function createZeroPiiUser(
  email: string,
  opts?: { name?: string; trustId?: string },
) {
  const name = opts?.name ?? "A User";
  const [first = "A", ...rest] = name.split(" ");
  const last = rest.join(" ") || "User";
  const nameCommit = commitName(first, last);
  const contact = commitContact("email", email);
  return prisma.user.create({
    data: {
      trustId:
        opts?.trustId ??
        `TD-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      status: "active",
      profile: {
        create: {
          nameCommitment: nameCommit.nameCommitment,
          nameSalt: nameCommit.nameSalt,
        },
      },
      contactMethods: {
        create: {
          type: "email",
          lookupHash: contact.lookupHash,
          commitment: contact.commitment,
          salt: contact.salt,
          verifiedAt: new Date(),
          isPrimary: true,
        },
      },
    },
  });
}
