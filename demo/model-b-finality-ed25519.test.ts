/** 7.6D.12A: offline asymmetric witness tests — no real RPC or SQL writes. */
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as rawSign,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import type { ModelBFinalityRpc } from "./model-b-postgres-chain-inspection";
import type { ModelBPaymentRecord } from "./model-b-postgres-payment-store";
import {
  encodeModelBEd25519Evidence,
  inspectAndSignModelBEd25519Finality,
  modelBEd25519PublicKeyHex,
  requireDualModelBEd25519Evidence,
  validateModelBPublicWitnessRegistry,
  type AsymmetricWitnessKey,
  type SignedAsymmetricWitnessDecision,
  type TrustedAsymmetricWitnessRegistry,
} from "./model-b-finality-ed25519";
import { encodeModelBFinalityAttestation } from "./model-b-finality-attestation-codec";

const A_ID = "observer-a-epoch-001";
const B_ID = "observer-b-epoch-001";

function setup(
  mode: {
    confirmation?: "finalized" | "confirmed" | "processed";
    error?: unknown;
    receiptError?: unknown;
    receiptSlot?: number;
    unavailable?: boolean;
    wrongGenesis?: "before" | "after";
  } = {}
) {
  const fx = makeModelBPostgresFixture("modelb-d12-ed25519-01");
  const calls: string[] = [];
  let genesisCount = 0;
  const rpc: ModelBFinalityRpc = {
    async getGenesisHash() {
      calls.push("genesis");
      genesisCount += 1;
      if (
        (mode.wrongGenesis === "before" && genesisCount === 1) ||
        (mode.wrongGenesis === "after" && genesisCount === 2)
      ) {
        return Keypair.generate().publicKey.toBase58();
      }
      return fx.record.genesisHash;
    },
    async getSignatureStatuses(signatures, opts) {
      calls.push("status");
      assert.deepEqual(signatures, [fx.record.signature]);
      assert.deepEqual(opts, { searchTransactionHistory: true });
      if (mode.unavailable) throw Error("RPC_DOWN");
      return {
        value: [
          {
            slot: 271,
            confirmationStatus: mode.confirmation ?? "finalized",
            err: mode.error ?? null,
          },
        ],
      };
    },
    async getTransaction(sig, opts) {
      calls.push("receipt");
      assert.equal(sig, fx.record.signature);
      assert.deepEqual(opts, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      return {
        slot: mode.receiptSlot ?? 271,
        transaction: { signatures: [sig] },
        meta: {
          err:
            mode.receiptError === undefined
              ? mode.error ?? null
              : mode.receiptError,
        },
      };
    },
  };
  const deployment = {
    genesisHash: fx.record.genesisHash,
    programId: AGENTVAULT_PROGRAM_ID.toBase58(),
    vault: fx.record.vault,
    rpc,
  };
  return { ...fx, rpc, deployment, calls };
}
function keys(generation = 1, keyIdA = A_ID, keyIdB = B_ID) {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const kA: AsymmetricWitnessKey = {
    witnessId: "observer_a",
    keyId: keyIdA,
    generation,
    publicKeyHex: modelBEd25519PublicKeyHex(a.publicKey),
    state: "ACTIVE",
  };
  const kB: AsymmetricWitnessKey = {
    witnessId: "observer_b",
    keyId: keyIdB,
    generation,
    publicKeyHex: modelBEd25519PublicKeyHex(b.publicKey),
    state: "ACTIVE",
  };
  const registry: TrustedAsymmetricWitnessRegistry = {
    generation,
    keys: [kA, kB],
  };
  const signerA = {
    witnessId: "observer_a" as const,
    keyId: keyIdA,
    generation,
    privateKey: a.privateKey,
  };
  const signerB = {
    witnessId: "observer_b" as const,
    keyId: keyIdB,
    generation,
    privateKey: b.privateKey,
  };
  return { a, b, kA, kB, registry, signerA, signerB };
}
async function pair(fx: ReturnType<typeof setup>, k: ReturnType<typeof keys>) {
  return Promise.all([
    inspectAndSignModelBEd25519Finality(k.signerA, fx.record, fx.deployment),
    inspectAndSignModelBEd25519Finality(k.signerB, fx.record, fx.deployment),
  ]);
}
function change(
  d: SignedAsymmetricWitnessDecision,
  props: Record<string, unknown>
) {
  return { ...d, ...props } as SignedAsymmetricWitnessDecision;
}

// Signature and key material is generated only here, never included in source or SQL.
test("independent witnesses create detached Ed25519 evidence verified by public keys only", async () => {
  const fx = setup();
  const k = keys();
  const [a, b] = await pair(fx, k);
  assert.equal(a.status, "CONFIRMED");
  assert.equal(b.status, "CONFIRMED");
  assert.equal(a.finalizedSlot, 271);
  assert.equal(b.finalizedSlot, 271);
  assert.equal(a.signatureHex?.length, 128);
  assert.notEqual(a.signatureHex, b.signatureHex);
  assert.equal(Object.keys(a).includes("signedTransaction"), false);
  assert.deepEqual(
    requireDualModelBEd25519Evidence(fx.record, a, b, k.registry),
    {
      requestId: fx.record.requestId,
      status: "CONFIRMED",
      finalizedSlot: 271,
    }
  );
  assert.deepEqual(
    [...fx.calls].sort(),
    [
      "genesis",
      "status",
      "receipt",
      "genesis",
      "genesis",
      "status",
      "receipt",
      "genesis",
    ].sort()
  );
});

test("canonical v2 domain binds witness, key ID, generation, and v1 payment envelope", () => {
  const fx = setup();
  const record = fx.record;
  const identity = {
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
  const v1 = encodeModelBFinalityAttestation(identity, "CONFIRMED", 271);
  const v2 = encodeModelBEd25519Evidence(
    identity,
    "CONFIRMED",
    271,
    "observer_a",
    A_ID,
    1
  );
  assert.ok(v2.subarray(0, 60).toString().includes("ed25519/v2"));
  assert.equal(
    v2.subarray(v2.length - v1.length).toString("hex"),
    v1.toString("hex")
  );
  for (const [witnessId, keyId, gen, outcome, slot] of [
    ["observer_b", A_ID, 1, "CONFIRMED", 271],
    ["observer_a", B_ID, 1, "CONFIRMED", 271],
    ["observer_a", A_ID, 2, "CONFIRMED", 271],
    ["observer_a", A_ID, 1, "FAILED", 271],
    ["observer_a", A_ID, 1, "CONFIRMED", 272],
  ] as const) {
    assert.notEqual(
      encodeModelBEd25519Evidence(
        identity,
        outcome,
        slot,
        witnessId,
        keyId,
        gen
      ).toString("hex"),
      v2.toString("hex")
    );
  }
});

test("finalized on-chain error is signed FAILED, never CONFIRMED", async () => {
  const error = { InstructionError: [2, { Custom: 601 }] };
  const fx = setup({ error });
  const k = keys();
  const [a, b] = await pair(fx, k);
  assert.equal(a.status, "FAILED");
  assert.equal(
    requireDualModelBEd25519Evidence(fx.record, a, b, k.registry).status,
    "FAILED"
  );
  assert.throws(
    () =>
      requireDualModelBEd25519Evidence(
        fx.record,
        change(a, { status: "CONFIRMED" }),
        b,
        k.registry
      ),
    /ASYMMETRIC_WITNESS_DENIED/
  );
});

test("confirmed-only RPC observations cannot create Ed25519 signatures", async () => {
  const fx = setup({ confirmation: "confirmed" });
  const k = keys();
  const [a, b] = await pair(fx, k);
  assert.equal(a.status, "UNRESOLVED");
  assert.equal(a.signatureHex, null);
  assert.equal(a.finalizedSlot, null);
  assert.deepEqual(
    [...fx.calls].sort(),
    ["genesis", "status", "genesis", "status"].sort()
  );
  assert.throws(
    () => requireDualModelBEd25519Evidence(fx.record, a, b, k.registry),
    /ASYMMETRIC_WITNESS_DENIED/
  );
});

test("contradictory finalized errors and slots stay unresolved", async () => {
  const e = { InstructionError: [0, "InvalidArgument"] };
  for (const mode of [{ error: e, receiptError: null }, { receiptSlot: 272 }]) {
    const fx = setup(mode);
    const k = keys();
    const d = await inspectAndSignModelBEd25519Finality(
      k.signerA,
      fx.record,
      fx.deployment
    );
    assert.equal(d.status, "UNRESOLVED");
    assert.equal(d.signatureHex, null);
  }
});

test("RPC exception or changed genesis cannot become signed evidence", async () => {
  for (const mode of [
    { unavailable: true },
    { wrongGenesis: "before" as const },
    { wrongGenesis: "after" as const },
  ]) {
    const fx = setup(mode);
    const k = keys();
    await assert.rejects(
      inspectAndSignModelBEd25519Finality(k.signerA, fx.record, fx.deployment),
      /RPC_DOWN|genesis differs|genesis changed/
    );
  }
});

test("invalid keys, deployment and stored transaction refuse before RPC", async () => {
  const fx = setup();
  const k = keys();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(
    inspectAndSignModelBEd25519Finality(
      { ...k.signerA, privateKey: rsa.privateKey },
      fx.record,
      fx.deployment
    ),
    /ASYMMETRIC_WITNESS_DENIED/
  );
  await assert.rejects(
    inspectAndSignModelBEd25519Finality(
      k.signerA,
      { ...fx.record, signedTransactionSha256: "0".repeat(64) },
      fx.deployment
    ),
    /ASYMMETRIC_WITNESS_DENIED/
  );
  await assert.rejects(
    inspectAndSignModelBEd25519Finality(k.signerA, fx.record, {
      ...fx.deployment,
      genesisHash: Keypair.generate().publicKey.toBase58(),
    }),
    /ASYMMETRIC_WITNESS_DENIED/
  );
  assert.deepEqual(fx.calls, []);
});

test("forged signature, switched witness or same-key substitute is denied", async () => {
  const fx = setup();
  const k = keys();
  const [a, b] = await pair(fx, k);
  for (const tampered of [
    change(a, { signatureHex: "0".repeat(128) }),
    change(a, { witnessId: "observer_b" }),
    change(a, { signatureHex: b.signatureHex }),
    change(a, { keyId: k.kB.keyId }),
  ]) {
    assert.throws(
      () =>
        requireDualModelBEd25519Evidence(fx.record, tampered, b, k.registry),
      /ASYMMETRIC_WITNESS_DENIED/
    );
  }
  assert.throws(
    () => requireDualModelBEd25519Evidence(fx.record, a, a, k.registry),
    /ASYMMETRIC_WITNESS_DENIED/
  );
});

test("outcome, finalized slot, generation, and key-id substitutions fail closed", async () => {
  const fx = setup();
  const k = keys();
  const [a, b] = await pair(fx, k);
  for (const tampered of [
    change(a, { status: "FAILED" }),
    change(a, { finalizedSlot: 272 }),
    change(a, { generation: 2 }),
    change(a, { keyId: "observer-a-fake-001" }),
    change(a, { signatureHex: "abc" }),
  ]) {
    assert.throws(
      () =>
        requireDualModelBEd25519Evidence(fx.record, tampered, b, k.registry),
      /ASYMMETRIC_WITNESS_DENIED/
    );
  }
});

test("replay against another payment or modified immutable identity is denied", async () => {
  const fx = setup();
  const k = keys();
  const [a, b] = await pair(fx, k);
  const alternate = makeModelBPostgresFixture("modelb-d12-another-01");
  for (const row of [
    alternate.record,
    { ...fx.record, workflowDigest: "0".repeat(64) },
    { ...fx.record, paymentDigest: "1".repeat(64) },
    { ...fx.record, genesisHash: Keypair.generate().publicKey.toBase58() },
    { ...fx.record, vault: Keypair.generate().publicKey.toBase58() },
  ]) {
    assert.throws(
      () => requireDualModelBEd25519Evidence(row, a, b, k.registry),
      /ASYMMETRIC_WITNESS_DENIED/
    );
  }
});

test("terminal and unreserved payment phases cannot replay valid signatures", async () => {
  const fx = setup();
  const k = keys();
  const [a, b] = await pair(fx, k);
  for (const phase of ["CONFIRMED", "FAILED", "PREPARED", "CLAIMED"] as const) {
    assert.throws(
      () =>
        requireDualModelBEd25519Evidence(
          { ...fx.record, phase },
          a,
          b,
          k.registry
        ),
      /ASYMMETRIC_WITNESS_DENIED/
    );
  }
});

test("rotation revokes old generation and accepts new independent keys", async () => {
  const fx = setup();
  const old = keys();
  const [oldA, oldB] = await pair(fx, old);
  const next = keys(2, "observer-a-epoch-002", "observer-b-epoch-002");
  const rotated: TrustedAsymmetricWitnessRegistry = {
    generation: 2,
    keys: [
      { ...old.kA, state: "REVOKED" },
      { ...old.kB, state: "REVOKED" },
      next.kA,
      next.kB,
    ],
  };
  assert.throws(
    () => requireDualModelBEd25519Evidence(fx.record, oldA, oldB, rotated),
    /ASYMMETRIC_WITNESS_DENIED/
  );
  const [newA, newB] = await pair(fx, next);
  assert.equal(
    requireDualModelBEd25519Evidence(fx.record, newA, newB, rotated).status,
    "CONFIRMED"
  );
  assert.throws(
    () => requireDualModelBEd25519Evidence(fx.record, oldA, newB, rotated),
    /ASYMMETRIC_WITNESS_DENIED/
  );
});

test("invalid trust registries fail closed before accepting any signatures", async () => {
  const fx = setup();
  const k = keys();
  const [a, b] = await pair(fx, k);
  const invalid: TrustedAsymmetricWitnessRegistry[] = [
    { generation: 1, keys: [k.kA] },
    { generation: 1, keys: [k.kA, k.kA] },
    {
      generation: 1,
      keys: [k.kA, { ...k.kB, publicKeyHex: k.kA.publicKeyHex }],
    },
    { generation: 1, keys: [k.kA, { ...k.kB, keyId: k.kA.keyId }] },
    { generation: 1, keys: [k.kA, { ...k.kB, state: "REVOKED" }] },
    { generation: 2, keys: [k.kA, k.kB] },
    { generation: 1, keys: [k.kA, { ...k.kB, publicKeyHex: "f".repeat(62) }] },
  ];
  for (const registry of invalid) {
    assert.throws(
      () => validateModelBPublicWitnessRegistry(registry),
      /ASYMMETRIC_WITNESS_DENIED/
    );
    assert.throws(
      () => requireDualModelBEd25519Evidence(fx.record, a, b, registry),
      /ASYMMETRIC_WITNESS_DENIED/
    );
  }
});

test("raw 32-byte public key format matches detached Ed25519 and rejects non-Ed25519 keys", () => {
  const k = keys();
  assert.match(modelBEd25519PublicKeyHex(k.a.publicKey), /^[0-9a-f]{64}$/);
  assert.notEqual(
    modelBEd25519PublicKeyHex(k.a.publicKey),
    modelBEd25519PublicKeyHex(k.b.publicKey)
  );
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () => modelBEd25519PublicKeyHex(rsa.publicKey),
    /ASYMMETRIC_WITNESS_DENIED/
  );
  assert.throws(
    () => modelBEd25519PublicKeyHex(k.a.privateKey as KeyObject),
    /ASYMMETRIC_WITNESS_DENIED/
  );
});

test("a signature of legacy HMAC/v1 bytes cannot authenticate v2 evidence", async () => {
  const fx = setup();
  const k = keys();
  const [a, b] = await pair(fx, k);
  const r = fx.record;
  const legacy = encodeModelBFinalityAttestation(
    {
      requestId: r.requestId,
      genesisHash: r.genesisHash,
      programId: r.programId,
      vault: r.vault,
      workflowDigest: r.workflowDigest,
      paymentDigest: r.paymentDigest,
      signedTransactionSha256: r.signedTransactionSha256!,
      signature: r.signature!,
      lastValidBlockHeight: r.lastValidBlockHeight!,
    },
    "CONFIRMED",
    271
  );
  const wrongSignature = rawSign(null, legacy, k.a.privateKey).toString("hex");
  assert.throws(
    () =>
      requireDualModelBEd25519Evidence(
        fx.record,
        change(a, { signatureHex: wrongSignature }),
        b,
        k.registry
      ),
    /ASYMMETRIC_WITNESS_DENIED/
  );
});

test("the new asymmetric module cannot silently enable SQL terminal writes", () => {
  const source = readFileSync("demo/model-b-finality-ed25519.ts", "utf8");
  const sql = readFileSync(
    "sql/20261111_model_b_attested_finality_gate.sql",
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /from ["']pg["']|recordChainStatus\(|sendRawTransaction\(/
  );
  assert.match(sql, /\.hmac\(/);
  assert.doesNotMatch(sql, /crypto_sign_verify_detached/);
  const doc = readFileSync(
    "docs/security/model-b-ed25519-attestation-boundary.md",
    "utf8"
  );
  assert.match(doc, /Do not.*legacy database terminal function/);
});
