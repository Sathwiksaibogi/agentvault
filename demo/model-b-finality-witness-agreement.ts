/**
 * 7.6D.11 INACTIVE: validate witness response agreement before the guarded SQL
 * terminal gate. This is not MAC verification, Solana finality verification,
 * or proof of independent RPC providers. PostgreSQL verifies BOTH MACs against
 * the immutable stored payment. Never use this module to authorize broadcasts.
 */
import type { WitnessDecision } from "./model-b-finality-independent-witness";

export type AgreedFinality = Readonly<{
  requestId: string;
  status: "CONFIRMED" | "FAILED";
  finalizedSlot: number;
  macA: string;
  macB: string;
}>;

/**
 * Fail before SQL when witnesses disagree or evidence is incomplete. A
 * finalizer cannot use one witness twice, substitute another payment, or
 * turn an UNRESOLVED observation into a terminal status.
 */
export function requireModelBDualWitnessAgreement(
  expected: Readonly<{ requestId: string; signature: string }>,
  first: WitnessDecision,
  second: WitnessDecision
): AgreedFinality {
  function denied(): never {
    throw new Error(
      "WITNESS_GATE_DENIED: absent, inconsistent, or malformed witness evidence"
    );
  }
  if (
    !expected ||
    !/^[A-Za-z0-9_-]{8,64}$/.test(expected.requestId) ||
    !expected.signature ||
    !first ||
    !second ||
    first.witnessId !== "observer_a" ||
    second.witnessId !== "observer_b" ||
    first.requestId !== expected.requestId ||
    second.requestId !== expected.requestId
  )
    denied();
  // Keep this guard separate so the TypeScript discriminated union narrows.
  if (first.status === "UNRESOLVED" || second.status === "UNRESOLVED") denied();
  if (first.status !== "CONFIRMED" && first.status !== "FAILED") denied();
  if (second.status !== "CONFIRMED" && second.status !== "FAILED") denied();
  if (
    first.status !== second.status ||
    first.signature !== expected.signature ||
    second.signature !== expected.signature ||
    first.finalizedSlot !== second.finalizedSlot ||
    !Number.isSafeInteger(first.finalizedSlot) ||
    first.finalizedSlot < 0 ||
    !/^[0-9a-f]{64}$/.test(first.mac) ||
    !/^[0-9a-f]{64}$/.test(second.mac)
  )
    denied();
  return Object.freeze({
    requestId: expected.requestId,
    status: first.status,
    finalizedSlot: first.finalizedSlot,
    macA: first.mac,
    macB: second.mac,
  });
}
