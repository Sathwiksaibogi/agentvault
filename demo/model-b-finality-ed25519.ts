/**
 * 7.6D.12A — INACTIVE, test-only asymmetric Model B witness attestations.
 *
 * Uses Ed25519 detached signatures and an independently pinned public-key
 * registry. A witness signs ONLY its own finalized, chain-inspected record.
 * There is NO PostgreSQL terminal-write function here: pgcrypto does not
 * verify Ed25519. The D.8 quarantine must remain in place until a separately
 * audited database-side verifier and least-privilege boundary exist.
 *
 * Never supply a trust registry from the finalizer's message. Private keys
 * belong to isolated witnesses; only raw public keys belong in the registry.
 */
import {
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import {
  encodeModelBFinalityAttestation,
  type AttestedPaymentIdentity,
} from "./model-b-finality-attestation-codec";
import {
  inspectModelBFinality,
  type ModelBFinalityRpc,
} from "./model-b-postgres-chain-inspection";
import {
  validatePaymentClaim,
  validateSignedPayment,
  type ModelBPaymentRecord,
} from "./model-b-postgres-payment-store";

export type AsymmetricWitnessId = "observer_a" | "observer_b";
export type AsymmetricWitnessKey = Readonly<{
  witnessId: AsymmetricWitnessId;
  keyId: string;
  generation: number;
  /** Lowercase hex encoding of the 32-byte raw Ed25519 public key. */
  publicKeyHex: string;
  state: "ACTIVE" | "REVOKED";
}>;
export type TrustedAsymmetricWitnessRegistry = Readonly<{
  generation: number;
  keys: readonly AsymmetricWitnessKey[];
}>;
export type SignedAsymmetricWitnessDecision = Readonly<
  | {
      witnessId: AsymmetricWitnessId;
      requestId: string;
      status: "UNRESOLVED";
      reason: string;
      finalizedSlot: null;
      signatureHex: null;
    }
  | {
      witnessId: AsymmetricWitnessId;
      requestId: string;
      txSignature: string;
      keyId: string;
      generation: number;
      status: "CONFIRMED" | "FAILED";
      finalizedSlot: number;
      signatureHex: string;
    }
>;
export type AsymmetricWitnessDeployment = Readonly<{
  genesisHash: string;
  programId: string;
  vault: string;
  rpc: ModelBFinalityRpc;
}>;

const V2_DOMAIN = Buffer.from(
  "AgentVault/ModelB/finality-attestation/ed25519/v2|",
  "utf8"
);
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const KEY_ID_RE = /^[a-z][a-z0-9_-]{7,63}$/;
const HEX_PUBLIC = /^[0-9a-f]{64}$/;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/;

function denied(): never {
  throw new Error(
    "ASYMMETRIC_WITNESS_DENIED: invalid, revoked, or inconsistent witness evidence"
  );
}
function witnessIdValid(id: unknown): id is AsymmetricWitnessId {
  return id === "observer_a" || id === "observer_b";
}
function generationValid(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}
function canonicalPublicKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}
function enc(value: string): Buffer {
  return Buffer.from(`${Buffer.byteLength(value, "utf8")}:${value}`, "utf8");
}
function rawEd25519PublicKey(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  if (
    !Buffer.isBuffer(der) ||
    der.length !== SPKI_ED25519_PREFIX.length + 32 ||
    !der.subarray(0, SPKI_ED25519_PREFIX.length).equals(SPKI_ED25519_PREFIX)
  )
    denied();
  return der.subarray(SPKI_ED25519_PREFIX.length).toString("hex");
}
export function modelBEd25519PublicKeyHex(key: KeyObject): string {
  if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519")
    denied();
  return rawEd25519PublicKey(key);
}
function importPublicKey(hex: string): KeyObject {
  if (!HEX_PUBLIC.test(hex)) denied();
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  });
}
function requiredPaymentIdentity(
  record: ModelBPaymentRecord
): AttestedPaymentIdentity {
  if (
    !record ||
    !["SUBMISSION_RESERVED", "UNRESOLVED"].includes(record.phase) ||
    record.finalizedSlot != null ||
    !record.signedTransaction ||
    !record.signature ||
    record.signedTransactionSha256 === null ||
    record.lastValidBlockHeight === null
  )
    denied();
  validatePaymentClaim(record);
  const verified = validateSignedPayment({
    requestId: record.requestId,
    signedTransaction: record.signedTransaction!,
    signature: record.signature!,
    lastValidBlockHeight: record.lastValidBlockHeight!,
  });
  if (verified.sha256 !== record.signedTransactionSha256) denied();
  return {
    requestId: record.requestId,
    genesisHash: record.genesisHash,
    programId: record.programId,
    vault: record.vault,
    workflowDigest: record.workflowDigest,
    paymentDigest: record.paymentDigest,
    signedTransactionSha256: record.signedTransactionSha256!,
    signature: record.signature!,
    lastValidBlockHeight: record.lastValidBlockHeight!,
  };
}

/** Canonical domain-separated v2 payload; includes the witness and key epoch. */
export function encodeModelBEd25519Evidence(
  identity: AttestedPaymentIdentity,
  outcome: "CONFIRMED" | "FAILED",
  finalizedSlot: number,
  witnessId: AsymmetricWitnessId,
  keyId: string,
  generation: number
): Buffer {
  if (
    !witnessIdValid(witnessId) ||
    !KEY_ID_RE.test(keyId) ||
    !generationValid(generation)
  )
    denied();
  return Buffer.concat([
    V2_DOMAIN,
    enc(witnessId),
    enc(keyId),
    enc(String(generation)),
    encodeModelBFinalityAttestation(identity, outcome, finalizedSlot),
  ]);
}

/** Trust policy must come from a separate administrative control plane. */
export function validateModelBPublicWitnessRegistry(
  registry: TrustedAsymmetricWitnessRegistry
): Readonly<Record<AsymmetricWitnessId, AsymmetricWitnessKey>> {
  if (
    !registry ||
    !generationValid(registry.generation) ||
    !Array.isArray(registry.keys) ||
    registry.keys.length < 2 ||
    registry.keys.length > 16
  )
    denied();
  const seenIds = new Set<string>();
  const active = new Map<AsymmetricWitnessId, AsymmetricWitnessKey>();
  for (const key of registry.keys) {
    if (
      !key ||
      !witnessIdValid(key.witnessId) ||
      !KEY_ID_RE.test(key.keyId) ||
      !generationValid(key.generation) ||
      !HEX_PUBLIC.test(key.publicKeyHex) ||
      (key.state !== "ACTIVE" && key.state !== "REVOKED") ||
      key.generation > registry.generation ||
      seenIds.has(key.keyId)
    )
      denied();
    seenIds.add(key.keyId);
    if (key.state === "ACTIVE") {
      if (key.generation !== registry.generation || active.has(key.witnessId))
        denied();
      active.set(key.witnessId, key);
    }
  }
  const a = active.get("observer_a");
  const b = active.get("observer_b");
  if (!a || !b || a.publicKeyHex === b.publicKeyHex || a.keyId === b.keyId)
    denied();
  return Object.freeze({ observer_a: a, observer_b: b });
}

/** Only an independent RPC observation can produce a signed outcome. */
export async function inspectAndSignModelBEd25519Finality(
  signer: Readonly<{
    witnessId: AsymmetricWitnessId;
    keyId: string;
    generation: number;
    privateKey: KeyObject;
  }>,
  record: ModelBPaymentRecord,
  deployment: AsymmetricWitnessDeployment
): Promise<SignedAsymmetricWitnessDecision> {
  if (
    !signer ||
    !witnessIdValid(signer.witnessId) ||
    !KEY_ID_RE.test(signer.keyId) ||
    !generationValid(signer.generation) ||
    signer.privateKey?.type !== "private" ||
    signer.privateKey.asymmetricKeyType !== "ed25519" ||
    !deployment ||
    !canonicalPublicKey(deployment.genesisHash) ||
    !canonicalPublicKey(deployment.vault) ||
    deployment.programId !== AGENTVAULT_PROGRAM_ID.toBase58() ||
    !deployment.rpc ||
    typeof deployment.rpc.getGenesisHash !== "function" ||
    typeof deployment.rpc.getSignatureStatuses !== "function" ||
    typeof deployment.rpc.getTransaction !== "function"
  )
    denied();
  const identity = requiredPaymentIdentity(record);
  if (
    identity.genesisHash !== deployment.genesisHash ||
    identity.programId !== deployment.programId ||
    identity.vault !== deployment.vault
  )
    denied();
  const snapshot: ModelBPaymentRecord = {
    ...record,
    signedTransaction: Buffer.from(record.signedTransaction!),
  };
  const observation = await inspectModelBFinality(snapshot, deployment.rpc);
  if (observation.status === "UNRESOLVED") {
    return Object.freeze({
      witnessId: signer.witnessId,
      requestId: record.requestId,
      status: "UNRESOLVED" as const,
      reason: observation.reason,
      finalizedSlot: null,
      signatureHex: null,
    });
  }
  const payload = encodeModelBEd25519Evidence(
    identity,
    observation.status,
    observation.finalizedSlot,
    signer.witnessId,
    signer.keyId,
    signer.generation
  );
  return Object.freeze({
    witnessId: signer.witnessId,
    requestId: identity.requestId,
    txSignature: identity.signature,
    status: observation.status,
    finalizedSlot: observation.finalizedSlot,
    keyId: signer.keyId,
    generation: signer.generation,
    signatureHex: ed25519Sign(null, payload, signer.privateKey).toString("hex"),
  });
}

/**
 * Public-key-only verification. This is NOT a PostgreSQL write authorization.
 * The existing SQL quarantine must not be bypassed using this function's
 * return value. Implement a database-verifiable signature gate separately.
 */
export function requireDualModelBEd25519Evidence(
  record: ModelBPaymentRecord,
  first: SignedAsymmetricWitnessDecision,
  second: SignedAsymmetricWitnessDecision,
  trustedRegistry: TrustedAsymmetricWitnessRegistry
): Readonly<{
  requestId: string;
  status: "CONFIRMED" | "FAILED";
  finalizedSlot: number;
}> {
  const active = validateModelBPublicWitnessRegistry(trustedRegistry);
  const identity = requiredPaymentIdentity(record);
  const decisions = [first, second];
  if (!first || !second || first.witnessId === second.witnessId) denied();
  if (new Set(decisions.map((d) => d.witnessId)).size !== 2) denied();
  for (const decision of decisions) {
    if (decision.status === "UNRESOLVED" || !witnessIdValid(decision.witnessId))
      denied();
    const terminal = decision as Extract<
      SignedAsymmetricWitnessDecision,
      { status: "CONFIRMED" | "FAILED" }
    >;
    const expected = active[terminal.witnessId];
    if (
      !expected ||
      terminal.keyId !== expected.keyId ||
      terminal.generation !== expected.generation ||
      terminal.requestId !== identity.requestId ||
      terminal.txSignature !== identity.signature ||
      !HEX_SIGNATURE.test(terminal.signatureHex) ||
      !Number.isSafeInteger(terminal.finalizedSlot) ||
      terminal.finalizedSlot < 0
    )
      denied();
    const payload = encodeModelBEd25519Evidence(
      identity,
      terminal.status,
      terminal.finalizedSlot,
      terminal.witnessId,
      terminal.keyId,
      terminal.generation
    );
    let verified = false;
    try {
      verified = ed25519Verify(
        null,
        payload,
        importPublicKey(expected.publicKeyHex),
        Buffer.from(terminal.signatureHex, "hex")
      );
    } catch {
      denied();
    }
    if (!verified) denied();
  }
  if (
    first.status !== second.status ||
    first.finalizedSlot !== second.finalizedSlot ||
    first.status === "UNRESOLVED" ||
    first.finalizedSlot === null
  )
    denied();
  return Object.freeze({
    requestId: identity.requestId,
    status: first.status,
    finalizedSlot: first.finalizedSlot,
  });
}
