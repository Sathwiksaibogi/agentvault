/** 7.6D.10: offline witness verification; fake RPC is test-only. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";
import type { ModelBPaymentRecord } from "./model-b-postgres-payment-store";
import type { ModelBFinalityRpc } from "./model-b-postgres-chain-inspection";
import {
  inspectAndAttestModelBFinality,
  type WitnessDeployment,
} from "./model-b-finality-independent-witness";
import {
  encodeModelBFinalityAttestation,
  signModelBFinalityAttestation,
} from "./model-b-finality-attestation-codec";
import { parsePrivateWitnessConfiguration } from "./model-b-finality-witness-worker";

function setup(
  overrides: {
    status?: "processed" | "confirmed" | "finalized";
    statusError?: unknown | null;
    receiptError?: unknown | null;
    receiptSlot?: number;
    receiptSignature?: string;
    wrongGenesis?: "before" | "after";
    unavailable?: boolean;
  } = {}
) {
  const fx = makeModelBPostgresFixture("modelb-witness-verified-01");
  const record = fx.record;
  const calls: string[] = [];
  let genesisCount = 0;
  const rpc: ModelBFinalityRpc = {
    async getGenesisHash() {
      calls.push("genesis");
      genesisCount++;
      if (
        (overrides.wrongGenesis === "before" && genesisCount === 1) ||
        (overrides.wrongGenesis === "after" && genesisCount > 1)
      ) {
        return Keypair.generate().publicKey.toBase58();
      }
      return record.genesisHash;
    },
    async getSignatureStatuses(signatures, config) {
      calls.push("status");
      assert.deepEqual(signatures, [record.signature]);
      assert.deepEqual(config, { searchTransactionHistory: true });
      if (overrides.unavailable) throw Error("RPC unavailable");
      return {
        value: [
          {
            slot: 271,
            confirmationStatus: overrides.status ?? "finalized",
            err: overrides.statusError ?? null,
          },
        ],
      };
    },
    async getTransaction(signature, config) {
      calls.push("receipt");
      assert.equal(signature, record.signature);
      assert.deepEqual(config, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      return {
        slot: overrides.receiptSlot ?? 271,
        transaction: {
          signatures: [overrides.receiptSignature ?? record.signature!],
        },
        meta: {
          err:
            overrides.receiptError === undefined
              ? overrides.statusError ?? null
              : overrides.receiptError,
        },
      };
    },
  };
  const deployment: WitnessDeployment = {
    genesisHash: record.genesisHash,
    programId: record.programId,
    vault: record.vault,
    rpc,
  };
  return { record, deployment, calls };
}

const freshKey = () => randomBytes(32);

test("own finalized success yields a MAC for the exact immutable record", async () => {
  const { record, deployment, calls } = setup();
  const key = freshKey();
  const result = await inspectAndAttestModelBFinality(
    "observer_a",
    key,
    record,
    deployment
  );
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.finalizedSlot, 271);
  assert.equal(result.requestId, record.requestId);
  assert.equal("signedTransaction" in result, false);
  assert.deepEqual(calls, ["genesis", "status", "receipt", "genesis"]);
  assert.ok(result.mac);
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
  assert.equal(
    result.mac,
    signModelBFinalityAttestation(
      key,
      encodeModelBFinalityAttestation(identity, "CONFIRMED", 271)
    )
  );
  assert.notEqual(
    result.mac,
    signModelBFinalityAttestation(
      key,
      encodeModelBFinalityAttestation(identity, "FAILED", 271)
    )
  );
});

test("a finalized instruction error signs FAILED, never success", async () => {
  const error = { InstructionError: [1, { Custom: 9 }] };
  const fx = setup({ statusError: error, receiptError: error });
  const decision = await inspectAndAttestModelBFinality(
    "observer_b",
    freshKey(),
    fx.record,
    fx.deployment
  );
  assert.equal(decision.status, "FAILED");
  assert.equal(decision.finalizedSlot, 271);
});

test("confirmed-only evidence remains unresolved and NEVER receives a MAC", async () => {
  const fx = setup({ status: "confirmed" });
  const decision = await inspectAndAttestModelBFinality(
    "observer_a",
    freshKey(),
    fx.record,
    fx.deployment
  );
  assert.equal(decision.status, "UNRESOLVED");
  assert.equal(decision.mac, null);
  assert.equal(decision.finalizedSlot, null);
  assert.deepEqual(fx.calls, ["genesis", "status"]);
});

test("contradictory receipt and status cannot create a terminal MAC", async () => {
  const fx = setup({
    statusError: { InstructionError: [0, "InvalidArgument"] },
    receiptError: null,
  });
  const decision = await inspectAndAttestModelBFinality(
    "observer_a",
    freshKey(),
    fx.record,
    fx.deployment
  );
  assert.equal(decision.status, "UNRESOLVED");
  assert.equal(decision.mac, null);
});

test("mismatching receipt slot and signature cannot be attested", async () => {
  for (const override of [
    { receiptSlot: 272 },
    { receiptSignature: Keypair.generate().publicKey.toBase58() },
  ]) {
    const fx = setup(override);
    const decision = await inspectAndAttestModelBFinality(
      "observer_b",
      freshKey(),
      fx.record,
      fx.deployment
    );
    assert.equal(decision.status, "UNRESOLVED");
    assert.equal(decision.mac, null);
  }
});

test("a different genesis before or after inspection is denied, never attested", async () => {
  for (const when of ["before", "after"] as const) {
    const fx = setup({ wrongGenesis: when });
    await assert.rejects(
      inspectAndAttestModelBFinality(
        "observer_a",
        freshKey(),
        fx.record,
        fx.deployment
      ),
      /genesis differs|genesis changed/
    );
  }
});

test("corrupted original signed transaction cannot reach witness RPC", async () => {
  const fx = setup();
  await assert.rejects(
    inspectAndAttestModelBFinality(
      "observer_a",
      freshKey(),
      {
        ...fx.record,
        signedTransactionSha256: "0".repeat(64),
      },
      fx.deployment
    ),
    /digest mismatch/
  );
  assert.deepEqual(fx.calls, []);
});

test("wrong vault, program or ledger is rejected before RPC", async () => {
  const fx = setup();
  for (const changed of ["vault", "genesisHash", "programId"] as const) {
    const altered: ModelBPaymentRecord = {
      ...fx.record,
      [changed]: Keypair.generate().publicKey.toBase58(),
    };
    await assert.rejects(
      inspectAndAttestModelBFinality(
        "observer_b",
        freshKey(),
        altered,
        fx.deployment
      ),
      /payment differs from pinned deployment/
    );
  }
  assert.deepEqual(fx.calls, []);
});

test("witness refuses unreserved and terminal payments without RPC access", async () => {
  for (const phase of ["CLAIMED", "PREPARED", "FAILED", "CONFIRMED"] as const) {
    const fx = setup();
    await assert.rejects(
      inspectAndAttestModelBFinality(
        "observer_a",
        freshKey(),
        { ...fx.record, phase },
        fx.deployment
      ),
      /Only submitted or unresolved/
    );
    assert.deepEqual(fx.calls, []);
  }
});

test("missing RPC result fails closed, with no fallback to caller finality", async () => {
  const fx = setup({ unavailable: true });
  await assert.rejects(
    inspectAndAttestModelBFinality(
      "observer_a",
      freshKey(),
      fx.record,
      fx.deployment
    ),
    /RPC unavailable/
  );
  assert.deepEqual(fx.calls, ["genesis", "status"]);
});

test("malformed secret, witness identity or deployment denies before RPC", async () => {
  const fx = setup();
  const badKey = Buffer.alloc(12);
  await assert.rejects(
    inspectAndAttestModelBFinality(
      "observer_a",
      badKey,
      fx.record,
      fx.deployment
    ),
    /key must be 32/
  );
  await assert.rejects(
    inspectAndAttestModelBFinality(
      "observer_c" as never,
      freshKey(),
      fx.record,
      fx.deployment
    ),
    /invalid witness identity/
  );
  await assert.rejects(
    inspectAndAttestModelBFinality("observer_a", freshKey(), fx.record, {
      ...fx.deployment,
      programId: Keypair.generate().publicKey.toBase58(),
    }),
    /invalid independently pinned deployment/
  );
  assert.deepEqual(fx.calls, []);
});

test("runtime config rejects privileged credentials, sibling keys and insecure RPC", () => {
  const fx = setup();
  const env: NodeJS.ProcessEnv = {
    AGENTVAULT_MODEL_B_PRIVATE_SCHEMA: "private_modelb",
    AGENTVAULT_MODEL_B_READER_DATABASE_URL:
      "postgresql://reader:secret@127.0.0.1:5432/agentvault_test_76c3",
    AGENTVAULT_MODEL_B_WITNESS_ID: "observer_a",
    AGENTVAULT_MODEL_B_WITNESS_KEY_HEX: freshKey().toString("hex"),
    AGENTVAULT_MODEL_B_WITNESS_RPC_URL: "https://api.devnet.solana.com",
    AGENTVAULT_MODEL_B_WITNESS_GENESIS_HASH: fx.record.genesisHash,
    AGENTVAULT_MODEL_B_WITNESS_PROGRAM_ID: AGENTVAULT_PROGRAM_ID.toBase58(),
    AGENTVAULT_MODEL_B_WITNESS_VAULT: fx.record.vault,
  };
  assert.equal(parsePrivateWitnessConfiguration(env).witnessId, "observer_a");
  for (const key of [
    "AGENTVAULT_TEST_DATABASE_URL",
    "AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL",
    "AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL",
    "AGENTVAULT_MODEL_B_WITNESS_OTHER_KEY_HEX",
  ]) {
    assert.throws(
      () => parsePrivateWitnessConfiguration({ ...env, [key]: "leaked" }),
      /privileged or sibling/
    );
  }
  for (const url of [
    "http://localhost:8899",
    "file:///tmp/rpc",
    "https://user:pass@rpc.invalid",
  ]) {
    assert.throws(
      () =>
        parsePrivateWitnessConfiguration({
          ...env,
          AGENTVAULT_MODEL_B_WITNESS_RPC_URL: url,
        }),
      /HTTPS RPC/
    );
  }
  assert.throws(
    () =>
      parsePrivateWitnessConfiguration({
        ...env,
        AGENTVAULT_MODEL_B_WITNESS_KEY_HEX: "00".repeat(32),
      }),
    /unsafe witness key/
  );
  assert.throws(
    () =>
      parsePrivateWitnessConfiguration({
        ...env,
        AGENTVAULT_MODEL_B_WITNESS_VAULT: "invalid",
      }),
    /invalid pinned deployment/
  );
  assert.throws(
    () =>
      parsePrivateWitnessConfiguration({
        ...env,
        AGENTVAULT_MODEL_B_WITNESS_PROGRAM_ID:
          Keypair.generate().publicKey.toBase58(),
      }),
    /invalid pinned deployment/
  );
});

test("live witness worker contains no signing/broadcast or fabricated test RPC path", () => {
  const live = readFileSync(
    resolve("demo/model-b-finality-witness-worker.ts"),
    "utf8"
  );
  assert.match(live, /openModelBReaderDatabase/);
  assert.match(live, /new Connection\(config\.rpcUrl/);
  assert.match(live, /process\.send/);
  assert.doesNotMatch(
    live,
    /(?:sendRawTransaction|sendTransaction|signTransaction|reserveOneSubmission)\s*\(/
  );
  assert.doesNotMatch(
    live,
    /WITNESS_TEST_FIXTURE|fixture-worker|MODEL_B_TEST_WITNESS/
  );
});

test("independent test subprocesses sign only their own inspected fixture observations", () => {
  const fx = setup();
  const fixture = Buffer.from(
    JSON.stringify({
      ...fx.record,
      signedTransaction: undefined,
      signedTransactionHex: fx.record.signedTransaction!.toString("hex"),
    })
  ).toString("base64");
  const results: { witnessId: string; mac: string; calls: string[] }[] = [];
  for (const witnessId of ["observer_a", "observer_b"]) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AGENTVAULT_WITNESS_TEST_FIXTURE: fixture,
      AGENTVAULT_WITNESS_TEST_ID: witnessId,
      AGENTVAULT_WITNESS_TEST_KEY_HEX: freshKey().toString("hex"),
    };
    const spawned = spawnSync(
      "pnpm",
      ["exec", "tsx", "demo/model-b-finality-witness-fixture-worker.ts"],
      {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 256 * 1024,
      }
    );
    assert.equal(spawned.error, undefined);
    assert.equal(spawned.status, 0, "independent synthetic witness failed");
    const marker = spawned.stdout
      .split("\n")
      .find((line) => line.startsWith("MODEL_B_TEST_WITNESS:"));
    assert.ok(marker, "test subprocess did not return a result");
    const parsed = JSON.parse(marker.slice("MODEL_B_TEST_WITNESS:".length));
    assert.equal(parsed.decision.status, "CONFIRMED");
    assert.equal(parsed.decision.finalizedSlot, 271);
    assert.deepEqual(parsed.calls, ["genesis", "status", "receipt", "genesis"]);
    assert.doesNotMatch(spawned.stdout + spawned.stderr, /postgresql:\/\//);
    results.push({
      witnessId: parsed.decision.witnessId,
      mac: parsed.decision.mac,
      calls: parsed.calls,
    });
  }
  assert.deepEqual(
    results.map((r) => r.witnessId),
    ["observer_a", "observer_b"]
  );
  assert.notEqual(results[0].mac, results[1].mac);
});
