import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  loadOptionalAgentSigner,
  resolveWorkerConfig,
  createConfiguredWorker,
} from "./model-a-worker-runner";

test("worker runner: defaults to simulated mode and resolves safe configurations", () => {
  const origEnv = { ...process.env };
  try {
    delete process.env.AGENTVAULT_WORKER_MODE;
    delete process.env.AGENTVAULT_VAULT;
    delete process.env.AGENTVAULT_POLL_INTERVAL_MS;

    const config = resolveWorkerConfig();
    assert.equal(config.mode, "simulated", "Worker must default to simulated mode");
    assert.ok(config.vault.length >= 32, "Vault must be configured");
    assert.ok(config.pollIntervalMs >= 500, "Polling interval must be at least 500ms");
    assert.ok(config.runtimeDir.length > 0, "Runtime directory must be set");
  } finally {
    process.env = origEnv;
  }
});

test("worker runner: loadOptionalAgentSigner rejects insecure permissions and invalid secret", () => {
  const root = mkdtempSync(join(tmpdir(), "av-key-test-"));
  try {
    const keyPath = join(root, "agent.json");
    const kp = Keypair.generate();
    writeFileSync(keyPath, JSON.stringify(Array.from(kp.secretKey)));
    chmodSync(keyPath, 0o666); // Insecure permissions

    assert.throws(
      () => loadOptionalAgentSigner(keyPath),
      /Agent keypair file permissions must be 0600/
    );

    chmodSync(keyPath, 0o600);
    const loaded = loadOptionalAgentSigner(keyPath);
    assert.ok(loaded);
    assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker runner: createConfiguredWorker instantiates ModelAWorker and manages lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-runner-test-"));
  try {
    const { worker, stop } = await createConfiguredWorker({
      runtimeDir: root,
      mode: "simulated",
      pollIntervalMs: 1000,
      vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
    });

    assert.equal(worker.isRunning(), false);
    worker.start();
    assert.equal(worker.isRunning(), true);
    stop();
    assert.equal(worker.isRunning(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
