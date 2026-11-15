/**
 * Tests for Devnet acceptance preparation scripts.
 *
 * Verifies:
 * 1. submitAcceptancePaymentIntent dry run and parameters.
 * 2. signAgentPaymentDecision derivation, keypair checks, and cryptographic verification.
 * 3. Restrictive file permissions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  generateAcceptanceRequestId,
  submitAcceptancePaymentIntent,
  DEVNET_ACCEPTANCE_VAULT,
  DEVNET_ACCEPTANCE_TASK_ID,
  DEVNET_ACCEPTANCE_TASK_PDA,
  DEVNET_ACCEPTANCE_RECIPIENT,
  DEVNET_ACCEPTANCE_AMOUNT,
} from "./submit-devnet-acceptance-intent.js";
import {
  deriveTaskPda,
  loadVerifiedAgentKeypair,
  signAgentPaymentDecision,
} from "./sign-agent-payment-decision.js";
import { encodeAgentPaymentDecision } from "./model-a-worker.js";

test("acceptance submission: generates unique request IDs matching canonical schema", () => {
  const id1 = generateAcceptanceRequestId();
  const id2 = generateAcceptanceRequestId();
  assert.notEqual(id1, id2);
  assert.ok(/^[A-Za-z0-9_-]{8,64}$/.test(id1));
  assert.ok(id1.startsWith("req_devnet_acc_"));
});

test("acceptance submission: dry run validates cluster clock and target parameters without network submission", async () => {
  const result = await submitAcceptancePaymentIntent({ dryRun: true });
  assert.equal(result.status, "dry_run_validated");
  assert.equal(result.taskId, DEVNET_ACCEPTANCE_TASK_ID);
  assert.equal(result.amountBaseUnits, DEVNET_ACCEPTANCE_AMOUNT);
  assert.equal(result.recipient, DEVNET_ACCEPTANCE_RECIPIENT);
  assert.ok(BigInt(result.expiresAtUnix) > BigInt(0));
});

test("acceptance signing: deriveTaskPda computes canonical task PDA for Task #3", () => {
  const taskPda = deriveTaskPda(
    DEVNET_ACCEPTANCE_VAULT,
    "AeP6wgJ1BktbP7q4MyEuKbuXXbQJgoLgMtgbGDi7hp8L",
    "3"
  );
  assert.equal(taskPda, DEVNET_ACCEPTANCE_TASK_PDA);
});

test("acceptance signing: loadVerifiedAgentKeypair enforces strict 0600 file permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "av-key-perm-"));
  try {
    const keypair = Keypair.generate();
    const keyPath = join(root, "agent.json");
    // Write with loose permissions (0644)
    writeFileSync(keyPath, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o644 });

    assert.throws(
      () => loadVerifiedAgentKeypair(keyPath),
      /Refusing agent keypair file readable by others/
    );

    // Fix permissions to 0600
    chmodSync(keyPath, 0o600);
    const loaded = loadVerifiedAgentKeypair(keyPath);
    assert.equal(loaded.publicKey.toBase58(), keypair.publicKey.toBase58());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance signing: derives terms directly from persisted intent and creates verified Ed25519 signature", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-sign-test-"));
  try {
    const agentKeypair = Keypair.generate();
    const recipientKeypair = Keypair.generate();
    const requestId = "req_test_sign_flow_01";
    const amountBaseUnits = "1000";
    const expiresAtUnix = 1795050000;

    // 1. Stage persisted intent
    const inboxDir = join(root, "payment-intent-inbox");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(
      join(inboxDir, "intent.json"),
      JSON.stringify({
        version: 1,
        kind: "model-a-payment-intent",
        status: "received",
        network: "devnet",
        vault: DEVNET_ACCEPTANCE_VAULT,
        principalId: "test_dev",
        createdAtUnix: 1794760000,
        request: {
          requestId,
          agentAuthority: agentKeypair.publicKey.toBase58(),
          taskId: "3",
          recipient: recipientKeypair.publicKey.toBase58(),
          amountBaseUnits,
          expiresAtUnix: String(expiresAtUnix),
          reason: "Unit test signing flow",
        },
      })
    );

    // 2. Save agent keypair with 0600 permissions
    const keyPath = join(root, "agent-keypair.json");
    writeFileSync(keyPath, JSON.stringify(Array.from(agentKeypair.secretKey)), { mode: 0o600 });

    // 3. Dry run: computes terms without signing
    const dryRunDecision = await signAgentPaymentDecision({
      runtimeDir: root,
      requestId,
      dryRun: true,
    });
    assert.equal(dryRunDecision.requestId, requestId);
    assert.equal(dryRunDecision.signature, "");

    // 4. Full signing: signs with agent keypair and verifies
    const signedDecision = await signAgentPaymentDecision({
      runtimeDir: root,
      requestId,
      agentKeypairPath: keyPath,
    });
    assert.equal(signedDecision.decision, "PAY");
    assert.ok(signedDecision.signature);

    // Verify written file permissions (0600)
    const writtenFile = join(root, "agent-decisions", `${requestId}.json`);
    const st = statSync(writtenFile);
    assert.equal((st.mode & 0o077), 0, "Saved decision must be mode 0600");

    // Cryptographically verify signature using worker's canonical encoding
    const canonicalBytes = encodeAgentPaymentDecision(signedDecision);
    const sigBytes = Buffer.from(signedDecision.signature, "base64");
    const valid = nacl.sign.detached.verify(
      canonicalBytes,
      sigBytes,
      agentKeypair.publicKey.toBytes()
    );
    assert.equal(valid, true, "Signature must verify against agent public key");

    // Verify wrong signer fails closed
    const wrongKeypair = Keypair.generate();
    const wrongKeyPath = join(root, "wrong-keypair.json");
    writeFileSync(wrongKeyPath, JSON.stringify(Array.from(wrongKeypair.secretKey)), { mode: 0o600 });

    await assert.rejects(
      () =>
        signAgentPaymentDecision({
          runtimeDir: root,
          requestId,
          agentKeypairPath: wrongKeyPath,
        }),
      /Signer authority mismatch/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
