/** 7.6D.10 hotfix regression: native web3.js Connection to strict finality RPC. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";
import { inspectAndAttestModelBFinality } from "./model-b-finality-independent-witness";
import { adaptWeb3ConnectionForModelBFinality } from "./model-b-finality-witness-worker";

function fixture() {
  const fx = makeModelBPostgresFixture("modelb-native-rpc-adapter-01");
  return {
    record: fx.record,
    deployment: {
      genesisHash: fx.record.genesisHash,
      programId: fx.record.programId,
      vault: fx.record.vault,
    },
  };
}

test("native RPC omitted confirmationStatus stays UNRESOLVED without a receipt lookup", async () => {
  const fx = fixture();
  let receiptQueries = 0;
  // Synthetic native Connection: only the three read methods can be called.
  const native = {
    async getGenesisHash() {
      return fx.record.genesisHash;
    },
    async getSignatureStatuses() {
      return {
        context: { slot: 271 },
        value: [{ slot: 271, confirmations: null, err: null }],
      };
    },
    async getTransaction() {
      receiptQueries++;
      throw Error("receipt must not be requested");
    },
  } as unknown as Connection;
  const decision = await inspectAndAttestModelBFinality(
    "observer_a",
    randomBytes(32),
    fx.record,
    { ...fx.deployment, rpc: adaptWeb3ConnectionForModelBFinality(native) }
  );
  assert.equal(decision.status, "UNRESOLVED");
  assert.equal(decision.mac, null);
  assert.equal(receiptQueries, 0);
});

test("native RPC adapter preserves finalized signature, slot and outcome", async () => {
  const fx = fixture();
  let receiptQueries = 0;
  const native = {
    async getGenesisHash() {
      return fx.record.genesisHash;
    },
    async getSignatureStatuses() {
      return {
        context: { slot: 271 },
        value: [
          {
            slot: 271,
            confirmations: null,
            confirmationStatus: "finalized",
            err: null,
          },
        ],
      };
    },
    async getTransaction() {
      receiptQueries++;
      return {
        slot: 271,
        transaction: { signatures: [fx.record.signature] },
        meta: { err: null },
      };
    },
  } as unknown as Connection;
  const decision = await inspectAndAttestModelBFinality(
    "observer_b",
    randomBytes(32),
    fx.record,
    { ...fx.deployment, rpc: adaptWeb3ConnectionForModelBFinality(native) }
  );
  assert.equal(decision.status, "CONFIRMED");
  assert.equal(decision.finalizedSlot, 271);
  assert.ok(decision.mac);
  assert.equal(receiptQueries, 1);
});
