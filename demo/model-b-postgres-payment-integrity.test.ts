import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import test from "node:test";

import {
  PostgresModelBPaymentStore,
  validateAuthorizedModelBPayment,
  type AuthorizedSignedModelBPayment,
} from "./model-b-postgres-payment-store";
import {
  makeModelBPostgresFixture,
  signatureBase58,
} from "./model-b-postgres-payment-fixture";

function mockStore() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const store = new PostgresModelBPaymentStore({
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rowCount: 0, rows: [] };
    },
  } as never);
  return { store, calls };
}

async function mustRejectBeforeDatabase(
  payment: AuthorizedSignedModelBPayment,
  pattern: RegExp
): Promise<void> {
  const { store, calls } = mockStore();
  await assert.rejects(store.persistSignedPayment(payment), pattern);
  assert.equal(calls.length, 0, "invalid payment reached PostgreSQL");
}

test("valid Model B payment verifies both approvals and binds the original claim in SQL", async () => {
  const fixture = makeModelBPostgresFixture("modelb-integrity-001");
  const result = validateAuthorizedModelBPayment(fixture.payment);
  assert.deepEqual(result.bytes, fixture.payment.signedTransaction);
  assert.deepEqual(result.claim, fixture.claim);

  const { store, calls } = mockStore();
  await assert.rejects(
    store.persistSignedPayment(fixture.payment),
    /already transitioned/
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /phase = 'CLAIMED'/);
  for (const [name, index] of [
    ["genesis_hash", 6],
    ["program_id", 7],
    ["vault", 8],
    ["workflow_digest", 9],
    ["payment_digest", 10],
  ] as const) {
    assert.match(calls[0].sql, new RegExp(`${name} = \\$${index}`));
  }
  assert.deepEqual(calls[0].params.slice(5), [
    fixture.claim.genesisHash,
    fixture.claim.programId,
    fixture.claim.vault,
    fixture.claim.workflowDigest,
    fixture.claim.paymentDigest,
  ]);
});

test("plain signed SOL transfers and missing binding cannot reach PostgreSQL", async () => {
  const fixture = makeModelBPostgresFixture("modelb-integrity-002");
  const signer = fixture.agentSigner;
  const tx = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    })
  );
  tx.sign(signer);
  await mustRejectBeforeDatabase(
    {
      ...fixture.payment,
      signedTransaction: tx.serialize(),
      signature: signatureBase58(tx.signature!),
    },
    /Model B|exactly three|message mismatch|instruction/
  );
  await mustRejectBeforeDatabase(
    { ...fixture.payment, binding: undefined } as never,
    /binding is required/
  );
});

test("altered request, signature, validity height, or signed bytes fail before SQL", async () => {
  const fixture = makeModelBPostgresFixture("modelb-integrity-003");
  await mustRejectBeforeDatabase(
    { ...fixture.payment, requestId: "modelb-integrity-099" },
    /request ID/i
  );
  await mustRejectBeforeDatabase(
    { ...fixture.payment, signature: "not-the-agent-signature" },
    /signature/
  );
  await mustRejectBeforeDatabase(
    { ...fixture.payment, lastValidBlockHeight: 0 },
    /positive last-valid block height/
  );
  const corrupted = Buffer.from(fixture.payment.signedTransaction);
  corrupted[corrupted.length - 1] ^= 1;
  await mustRejectBeforeDatabase(
    { ...fixture.payment, signedTransaction: corrupted },
    /signature|serialized/
  );
});

test("extra transfer and altered Model B payment args cannot reach PostgreSQL", async () => {
  const fixture = makeModelBPostgresFixture("modelb-integrity-004");
  const extra = Transaction.from(fixture.payment.signedTransaction);
  extra.add(
    SystemProgram.transfer({
      fromPubkey: fixture.agentSigner.publicKey,
      // Reuse an already-compiled account to avoid a size-limit-only failure.
      toPubkey: new PublicKey(fixture.binding.paymentApproval.recipient),
      lamports: 1,
    })
  );
  extra.sign(fixture.agentSigner);
  await mustRejectBeforeDatabase(
    {
      ...fixture.payment,
      signedTransaction: extra.serialize(),
      signature: signatureBase58(extra.signature!),
    },
    /message mismatch|exactly three|Model B|length/
  );

  const changed = Transaction.from(fixture.payment.signedTransaction);
  changed.instructions[2].data = Buffer.from(changed.instructions[2].data);
  changed.instructions[2].data[8] ^= 1;
  changed.sign(fixture.agentSigner);
  await mustRejectBeforeDatabase(
    {
      ...fixture.payment,
      signedTransaction: changed.serialize(),
      signature: signatureBase58(changed.signature!),
    },
    /message mismatch|amount|Model B|1000|1001|length/
  );
});

test("forged workflow or payment owner signature cannot reach PostgreSQL", async () => {
  const fixture = makeModelBPostgresFixture("modelb-integrity-005");
  const workflow = fixture.binding.signedWorkflow;
  const wrongWorkflowSignature = Buffer.from(workflow.signature, "base64");
  wrongWorkflowSignature[3] ^= 1;
  await mustRejectBeforeDatabase(
    {
      ...fixture.payment,
      binding: {
        ...fixture.binding,
        signedWorkflow: {
          ...workflow,
          signature: wrongWorkflowSignature.toString("base64"),
        },
      },
    },
    /signature|Model B/
  );

  const wrongPaymentSignature = Buffer.from(
    fixture.binding.signatureBase64,
    "base64"
  );
  wrongPaymentSignature[5] ^= 1;
  await mustRejectBeforeDatabase(
    {
      ...fixture.payment,
      binding: {
        ...fixture.binding,
        signatureBase64: wrongPaymentSignature.toString("base64"),
      },
    },
    /signature|Model B/
  );
});

test("nonce, agent PDA, recipient and owner-signed amount substitution fail", async () => {
  const fixture = makeModelBPostgresFixture("modelb-integrity-006");
  await mustRejectBeforeDatabase(
    {
      ...fixture.payment,
      binding: { ...fixture.binding, nextNonce: "1" },
    },
    /nonce|binding|mismatch/
  );
  await mustRejectBeforeDatabase(
    {
      ...fixture.payment,
      binding: { ...fixture.binding, agentPda: Keypair.generate().publicKey },
    },
    /agent PDA|mismatch/
  );
  await mustRejectBeforeDatabase(
    {
      ...fixture.payment,
      binding: {
        ...fixture.binding,
        paymentApproval: {
          ...fixture.binding.paymentApproval,
          recipient: Keypair.generate().publicKey.toBase58(),
        },
      },
    },
    /recipient|binding|mismatch/
  );
  await mustRejectBeforeDatabase(
    {
      ...fixture.payment,
      binding: {
        ...fixture.binding,
        paymentApproval: {
          ...fixture.binding.paymentApproval,
          amountBaseUnits: "1001",
        },
      },
    },
    /amount|binding|mismatch/
  );
});

test("caller-supplied stale time cannot revive an expired payment", async () => {
  const fixture = makeModelBPostgresFixture(
    "modelb-integrity-007",
    Math.floor(Date.now() / 1000) - 7200
  );
  await mustRejectBeforeDatabase(fixture.payment, /expired|expiry/);
});
