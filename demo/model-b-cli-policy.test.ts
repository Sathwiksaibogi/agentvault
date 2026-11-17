import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair } from "@solana/web3.js";

import {
  assertModelBExecutionAllowed,
  loadModelBAgentSigner,
  parseModelBCliArguments,
} from "./model-b-cli-policy";

test("defaults Model B CLI to preview", () => {
  assert.deepEqual(parseModelBCliArguments(["modelb-cli-001"]), {
    requestId: "modelb-cli-001",
    mode: "preview",
  });
});

test("accepts explicit Model B preview", () => {
  assert.equal(
    parseModelBCliArguments(["modelb-cli-001", "--preview"]).mode,
    "preview"
  );
});

test("only exact --execute flag selects execution", () => {
  assert.equal(
    parseModelBCliArguments(["modelb-cli-001", "--execute"]).mode,
    "execute"
  );
  for (const flag of ["--EXECUTE", "execute", "--execute=true", "--send"]) {
    assert.throws(() => parseModelBCliArguments(["modelb-cli-001", flag]));
  }
});

test("rejects missing or malformed Model B request IDs", () => {
  for (const args of [
    [],
    ["a"],
    ["../escape"],
    ["a".repeat(65)],
    ["abc.def_123"],
    ["--execute"],
  ]) {
    assert.throws(() => parseModelBCliArguments(args));
  }
});

test("rejects extra Model B CLI arguments", () => {
  assert.throws(() =>
    parseModelBCliArguments(["modelb-cli-001", "--preview", "--execute"])
  );
  assert.throws(() =>
    parseModelBCliArguments(["modelb-cli-001", "--execute", "--preview"])
  );
});

test("permits interactive Devnet Model B execution", () => {
  assert.doesNotThrow(() => assertModelBExecutionAllowed("devnet", true));
});

test("rejects localnet and mainnet execution before any evaluator work", () => {
  for (const network of ["localnet", "mainnet-beta", "testnet", "DEVNET", ""]) {
    assert.throws(
      () => assertModelBExecutionAllowed(network, true),
      /Devnet-only/
    );
  }
});

test("rejects Devnet Model B execution without a terminal", () => {
  assert.throws(
    () => assertModelBExecutionAllowed("devnet", false),
    /interactive terminal/
  );
});

test("loads only a valid assigned agent keypair", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentvault-modelb-cli-"));
  try {
    const agent = Keypair.generate();
    writeFileSync(
      join(directory, "agent-b.json"),
      JSON.stringify(Array.from(agent.secretKey)),
      { mode: 0o600 }
    );
    const restored = loadModelBAgentSigner(directory, "agent-b");
    assert.ok(restored.publicKey.equals(agent.publicKey));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects unauthorized agent names before touching the filesystem", () => {
  assert.throws(
    () =>
      loadModelBAgentSigner(
        "/directory-does-not-exist",
        "../owner" as "agent-a"
      ),
    /Unknown Model B agent/
  );
});

test("rejects malformed agent keypair files", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentvault-modelb-cli-"));
  try {
    const path = join(directory, "agent-a.json");
    for (const value of [
      [],
      [1],
      Array(64).fill(256),
      Array(64).fill("0"),
      { secretKey: [] },
    ]) {
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
      assert.throws(
        () => loadModelBAgentSigner(directory, "agent-a"),
        /Invalid Model B agent keypair/
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects symlinked agent signing keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentvault-modelb-cli-"));
  try {
    const target = join(directory, "real.json");
    writeFileSync(
      target,
      JSON.stringify(Array.from(Keypair.generate().secretKey)),
      { mode: 0o600 }
    );
    symlinkSync(target, join(directory, "agent-a.json"));
    assert.throws(
      () => loadModelBAgentSigner(directory, "agent-a"),
      /regular file/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects agent signing key directories", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentvault-modelb-cli-"));
  try {
    mkdirSync(join(directory, "agent-a.json"));
    assert.throws(
      () => loadModelBAgentSigner(directory, "agent-a"),
      /regular file/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects group/world-writable agent secret files", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentvault-modelb-cli-"));
  try {
    writeFileSync(
      join(directory, "agent-a.json"),
      JSON.stringify(Array.from(Keypair.generate().secretKey)),
      { mode: 0o600 }
    );
    chmodSync(join(directory, "agent-a.json"), 0o666);
    assert.throws(
      () => loadModelBAgentSigner(directory, "agent-a"),
      /group\/world-writable/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
