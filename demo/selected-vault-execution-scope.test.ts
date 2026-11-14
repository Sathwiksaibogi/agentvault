import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalVault,
  selectedVaultExecutionDir,
  parseExecutionArguments,
  checkedAgentKeyPath,
} from "./selected-vault-execution-scope";

const vault = Keypair.generate().publicKey.toBase58();
const otherVault = Keypair.generate().publicKey.toBase58();

test("preview is default, not live execution", () => {
  const args = parseExecutionArguments(["/tmp/approval.json", vault]);
  assert.equal(args.execute, false);
  assert.equal(args.agentKeyFile, null);
});

test("live execution requires explicit exact --execute --agent-key flags", () => {
  assert.throws(() =>
    parseExecutionArguments(["/tmp/approval.json", vault, "--execute"])
  );
  assert.throws(() =>
    parseExecutionArguments([
      "/tmp/approval.json",
      vault,
      "--execute",
      "--agent-key",
      "relative.json",
    ])
  );
  assert.throws(() =>
    parseExecutionArguments([
      "/tmp/approval.json",
      vault,
      "--preview",
      "--agent-key",
      "/tmp/k.json",
    ])
  );
  assert.throws(() =>
    parseExecutionArguments([
      "/tmp/approval.json",
      vault,
      "--execute",
      "--agent-key",
      "/tmp/k.json",
      "extra",
    ])
  );
  const args = parseExecutionArguments([
    "/tmp/approval.json",
    vault,
    "--execute",
    "--agent-key",
    "/tmp/key.json",
  ]);
  assert.equal(args.execute, true);
  assert.equal(args.agentKeyFile, "/tmp/key.json");
});

test("runtime journal is isolated per exact selected vault", () => {
  const first = selectedVaultExecutionDir(canonicalVault(vault));
  const second = selectedVaultExecutionDir(canonicalVault(otherVault));
  assert.notEqual(first, second);
  assert.ok(first.endsWith(`/devnet/${vault}`));
});

test("agent key file must be outside the Git workspace and private", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentvault-signer-"));
  try {
    mkdirSync(join(dir, "project"));
    const privateFile = join(dir, "agent.json");
    writeFileSync(privateFile, "[1]", { mode: 0o600 });
    assert.equal(
      checkedAgentKeyPath(privateFile, join(dir, "project")),
      privateFile
    );
    chmodSync(privateFile, 0o644);
    assert.throws(
      () => checkedAgentKeyPath(privateFile, join(dir, "project")),
      /group\/world/
    );
    chmodSync(privateFile, 0o600);
    const link = join(dir, "link.json");
    symlinkSync(privateFile, link);
    assert.throws(
      () => checkedAgentKeyPath(link, join(dir, "project")),
      /symlink/
    );
    const inProject = join(dir, "project", "agent.json");
    writeFileSync(inProject, "[1]", { mode: 0o600 });
    assert.throws(
      () => checkedAgentKeyPath(inProject, join(dir, "project")),
      /outside the Git workspace/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
