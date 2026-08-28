export { proveZk, verifyZk, ZkProveError } from "./service.js";
export {
  groth16ProofSchema,
  isBundleProveRequest,
  zkClaimBundleSchema,
  zkClaimTypeSchema,
  zkProveRequestSchema,
  zkVerifyRequestSchema,
  ZK_CLAIM_TYPES,
} from "./schemas.js";
export type { ZkProveRequest, ZkVerifyRequest } from "./schemas.js";
