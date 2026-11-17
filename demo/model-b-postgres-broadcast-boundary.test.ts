import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthorizedSignedModelBPayment,
  ModelBPaymentRecord,
} from "./model-b-postgres-payment-store";
import type { ModelBPreparationBackend } from "./model-b-postgres-durable-preparation";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";
import {
  exerciseModelBPostgresBroadcastBoundary,
  type ModelBPostgresBroadcastRpc,
  type ModelBPostgresBroadcastControls,
} from "./model-b-postgres-broadcast-boundary";

function harness(suffix: string) {
  const fx = makeModelBPostgresFixture(`modelb-postgres-broadcast-${suffix}`);
  let record: ModelBPaymentRecord = { ...fx.record, phase: "PREPARED" };
  let rpcGenesis = fx.binding.scope.genesisHash;
  let blockHeight = 100;
  let simulateErr: unknown = null;
  let returnedSignature = fx.payment.signature;
  let policyError: Error | null = null;
  let policyChecks = 0;
  let onSend: (() => void | Promise<void>) | undefined;
  const stats = {
    reads: 0,
    reserves: 0,
    reservationWins: 0,
    simulates: 0,
    sends: 0,
    sentBytes: [] as Buffer[],
    simulationConfig: null as null | Record<string, unknown>,
    sendConfig: null as null | Record<string, unknown>,
  };
  const store: ModelBPreparationBackend = {
    async claim() {
      throw new Error("Unexpected claim in broadcast boundary");
    },
    async persistSignedPayment() {
      throw new Error("Unexpected persistence in broadcast boundary");
    },
    async getForReconciliation() {
      stats.reads++;
      return record;
    },
    async reserveOneSubmission() {
      stats.reserves++;
      if (record.phase !== "PREPARED")
        throw new Error("Submission reservation already consumed");
      record = { ...record, phase: "SUBMISSION_RESERVED" };
      stats.reservationWins++;
      return record;
    },
  };
  const rpc = {
    async getGenesisHash() {
      return rpcGenesis;
    },
    async getBlockHeight() {
      return blockHeight;
    },
    async simulateTransaction(
      _signed: unknown,
      config: Record<string, unknown>
    ) {
      stats.simulates++;
      stats.simulationConfig = config;
      return { value: { err: simulateErr } };
    },
    async sendRawTransaction(raw: Buffer, config: Record<string, unknown>) {
      stats.sends++;
      stats.sentBytes.push(Buffer.from(raw));
      stats.sendConfig = config;
      if (onSend) await onSend();
      return returnedSignature;
    },
  } as unknown as ModelBPostgresBroadcastRpc;
  const controls: ModelBPostgresBroadcastControls = {
    mode: "test-harness",
    trustedDevnetGenesisHash: fx.binding.scope.genesisHash,
    async assertFreshOnChainPolicy() {
      policyChecks++;
      if (policyError) throw policyError;
    },
  };
  return {
    fx,
    store,
    rpc,
    controls,
    stats,
    get record() {
      return record;
    },
    get policyChecks() {
      return policyChecks;
    },
    setGenesis(value: string) {
      rpcGenesis = value;
    },
    setBlockHeight(value: number) {
      blockHeight = value;
    },
    setSimulationErr(value: unknown) {
      simulateErr = value;
    },
    setReturnedSignature(value: string) {
      returnedSignature = value;
    },
    setPolicyError(value: Error) {
      policyError = value;
    },
    setOnSend(value: () => void | Promise<void>) {
      onSend = value;
    },
    setRecord(value: ModelBPaymentRecord) {
      record = value;
    },
  };
}

async function run(
  h: ReturnType<typeof harness>,
  payment: AuthorizedSignedModelBPayment = h.fx.payment
) {
  return exerciseModelBPostgresBroadcastBoundary(
    h.store,
    payment,
    h.rpc,
    h.controls
  );
}

test("broadcast is disabled by default and cannot touch RPC or PostgreSQL", async () => {
  const h = harness("001");
  h.controls.mode = undefined;
  await assert.rejects(run(h), /BROADCAST_DISABLED/);
  assert.equal(h.stats.reads, 0);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.simulates, 0);
  assert.equal(h.stats.sends, 0);
});

test("test harness submits only the original reserved bytes once and does not mark finality", async () => {
  const h = harness("002");
  const result = await run(h);
  assert.deepEqual(result, {
    requestId: h.fx.payment.requestId,
    signature: h.fx.payment.signature,
    status: "rpc_accepted_not_finalized",
  });
  assert.equal(h.stats.reads, 1);
  assert.equal(h.stats.reserves, 1);
  assert.equal(h.stats.sends, 1);
  assert.equal(h.stats.simulates, 1);
  assert.equal(h.policyChecks, 2);
  assert.deepEqual(h.stats.sentBytes[0], h.fx.payment.signedTransaction);
  assert.deepEqual(h.stats.simulationConfig, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  assert.deepEqual(h.stats.sendConfig, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 0,
  });
  assert.equal(h.record.phase, "SUBMISSION_RESERVED");
});

test("a second call never obtains a new permit or rebroadcasts", async () => {
  const h = harness("003");
  await run(h);
  await assert.rejects(run(h), /SUBMISSION_LOCKED/);
  assert.equal(h.stats.reserves, 1);
  assert.equal(h.stats.sends, 1);
});

test("tampered signed payment fails before RPC or reservation", async () => {
  const h = harness("004");
  const altered = Buffer.from(h.fx.payment.signedTransaction);
  altered[1] ^= 1;
  await assert.rejects(run(h, { ...h.fx.payment, signedTransaction: altered }));
  assert.equal(h.stats.simulates, 0);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.sends, 0);
});

test("trusted genesis config may not be inferred or replaced by approval", async () => {
  const h = harness("005");
  h.controls.trustedDevnetGenesisHash = "not-the-trusted-genesis";
  await assert.rejects(run(h), /ledger is not trusted/);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.sends, 0);
});

test("wrong RPC genesis rejects before simulation or reservation", async () => {
  const h = harness("006");
  h.setGenesis("different-ledger");
  await assert.rejects(run(h), /RPC ledger changed/);
  assert.equal(h.stats.simulates, 0);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.sends, 0);
});

test("expired or malformed block heights reject before simulation", async () => {
  const h = harness("007");
  for (const height of [
    9001,
    -1,
    Number.NaN,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    h.setBlockHeight(height);
    await assert.rejects(run(h), /blockhash expired/);
  }
  assert.equal(h.stats.simulates, 0);
  assert.equal(h.stats.reserves, 0);
});

test("simulation error never consumes the submission reservation", async () => {
  const h = harness("008");
  h.setSimulationErr({ InstructionError: [2, "Custom"] });
  await assert.rejects(run(h), /simulation failed/);
  assert.equal(h.stats.simulates, 1);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.sends, 0);
});

test("trusted policy failure rejects before any reservation", async () => {
  const h = harness("009");
  h.setPolicyError(new Error("on-chain task paused"));
  await assert.rejects(run(h), /task paused/);
  assert.equal(h.stats.simulates, 0);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.sends, 0);
});

test("missing trusted policy callback is always denied", async () => {
  const h = harness("010");
  h.controls.assertFreshOnChainPolicy =
    undefined as unknown as () => Promise<void>;
  await assert.rejects(run(h), /missing trusted policy reader/);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.sends, 0);
});

test("a ledger switch after simulation prevents CAS and broadcast", async () => {
  const h = harness("011");
  h.rpc.simulateTransaction = (async () => {
    h.stats.simulates++;
    h.setGenesis("changed-after-simulation");
    return { value: { err: null } };
  }) as unknown as typeof h.rpc.simulateTransaction;
  await assert.rejects(run(h), /RPC ledger changed/);
  assert.equal(h.stats.simulates, 1);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.sends, 0);
});

test("a block height expiring during simulation prevents CAS", async () => {
  const h = harness("012");
  h.rpc.simulateTransaction = (async () => {
    h.stats.simulates++;
    h.setBlockHeight(9001);
    return { value: { err: null } };
  }) as unknown as typeof h.rpc.simulateTransaction;
  await assert.rejects(run(h), /blockhash expired/);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.sends, 0);
});

test("policy change after simulation prevents reservation", async () => {
  const h = harness("019");
  h.rpc.simulateTransaction = (async () => {
    h.stats.simulates++;
    h.setPolicyError(new Error("task nonce changed"));
    return { value: { err: null } };
  }) as unknown as typeof h.rpc.simulateTransaction;
  await assert.rejects(run(h), /task nonce changed/);
  assert.equal(h.stats.simulates, 1);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.sends, 0);
});

test("independent workers race: at most one application send occurs", async () => {
  const h = harness("013");
  const outcomes = await Promise.allSettled([run(h), run(h)]);
  assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((v) => v.status === "rejected").length, 1);
  assert.equal(h.stats.reservationWins, 1);
  assert.equal(h.stats.sends, 1);
});

test("ambiguous SQL reservation response leaves request locked and never sends", async () => {
  const h = harness("014");
  const original = h.store.reserveOneSubmission;
  h.store.reserveOneSubmission = async (id) => {
    await original(id);
    throw new Error("lost SQL acknowledgment");
  };
  await assert.rejects(run(h), /lost SQL acknowledgment/);
  assert.equal(h.record.phase, "SUBMISSION_RESERVED");
  assert.equal(h.stats.sends, 0);
  await assert.rejects(run(h), /SUBMISSION_LOCKED/);
  assert.equal(h.stats.reserves, 1);
  assert.equal(h.stats.sends, 0);
});

test("RPC throws after one send; the database never grants a second permit", async () => {
  const h = harness("015");
  h.setOnSend(() => {
    throw new Error("RPC response lost");
  });
  await assert.rejects(run(h), /RPC response lost/);
  await assert.rejects(run(h), /SUBMISSION_LOCKED/);
  assert.equal(h.record.phase, "SUBMISSION_RESERVED");
  assert.equal(h.stats.reserves, 1);
  assert.equal(h.stats.sends, 1);
});

test("unexpected RPC signature is ambiguous and must not be resubmitted", async () => {
  const h = harness("016");
  h.setReturnedSignature("a-different-valid-looking-signature");
  await assert.rejects(run(h), /RPC signature mismatch/);
  await assert.rejects(run(h), /SUBMISSION_LOCKED/);
  assert.equal(h.stats.reserves, 1);
  assert.equal(h.stats.sends, 1);
});

test("a corrupted database PREPARED record is never reserved or sent", async () => {
  const h = harness("017");
  h.setRecord({ ...h.record, signature: "substituted" });
  await assert.rejects(run(h), /CONFLICT/);
  assert.equal(h.stats.reserves, 0);
  assert.equal(h.stats.sends, 0);
});

test("a substituted reservation response cannot reach network transport", async () => {
  const h = harness("018");
  const original = h.store.reserveOneSubmission;
  h.store.reserveOneSubmission = async (id) => {
    const committed = await original(id);
    return { ...committed, signedTransaction: Buffer.from("wrong bytes") };
  };
  await assert.rejects(run(h), /CONFLICT/);
  assert.equal(h.record.phase, "SUBMISSION_RESERVED");
  assert.equal(h.stats.reserves, 1);
  assert.equal(h.stats.sends, 0);
});
