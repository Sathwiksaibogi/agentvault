/** Isolated public scope for a selected-vault Model A Devnet request. */
import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

export const SELECTED_VAULT_PROGRAM =
  "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d";

export function canonicalVault(input: string): PublicKey {
  const key = new PublicKey(input);
  assert.equal(key.toBase58(), input, "Expected canonical vault address");
  return key;
}

export function selectedVaultExecutionDir(vault: PublicKey): string {
  return join(
    homedir(),
    ".config",
    "agentvault",
    "selected-vault-execution",
    "devnet",
    vault.toBase58()
  );
}

export function parseExecutionArguments(args: string[]): {
  approvalFile: string;
  vault: PublicKey;
  execute: boolean;
  agentKeyFile: string | null;
} {
  // --execute cannot appear without an explicit agent key file.
  assert.ok(
    args.length === 2 || args.length === 5,
    "Usage: execute-selected-vault-payment.ts <approval.json> <vault> [--execute --agent-key /absolute/path/agent.json]"
  );
  const [approvalPath, vaultString] = args;
  assert.ok(isAbsolute(approvalPath), "Approval path must be absolute");
  const execute = args.length === 5;
  if (execute) {
    assert.equal(
      args[2],
      "--execute",
      "Only the explicit --execute flag enables broadcast"
    );
    assert.equal(
      args[3],
      "--agent-key",
      "Expected --agent-key after --execute"
    );
    assert.ok(isAbsolute(args[4]), "Agent key path must be absolute");
  }
  return {
    approvalFile: resolve(approvalPath),
    vault: canonicalVault(vaultString),
    execute,
    agentKeyFile: execute ? resolve(args[4]) : null,
  };
}

export function checkedAgentKeyPath(
  keyFile: string,
  projectDir: string
): string {
  assert.ok(isAbsolute(keyFile), "Agent key path must be absolute");
  assert.ok(
    !lstatSync(keyFile).isSymbolicLink(),
    "Refusing symlinked agent key"
  );
  const path = realpathSync(keyFile);
  const project = realpathSync(projectDir);
  assert.ok(
    path !== project && !path.startsWith(project + "/"),
    "Agent keys must stay outside the Git workspace"
  );
  const stat = statSync(path);
  assert.ok(stat.isFile(), "Agent key is not a regular file");
  assert.ok(
    (stat.mode & 0o077) === 0,
    "Agent key file is group/world accessible; chmod 600 before execution"
  );
  assert.ok(stat.size > 0 && stat.size < 4096, "Unexpected agent key size");
  return path;
}
