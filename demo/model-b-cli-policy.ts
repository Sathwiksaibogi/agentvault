import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";

import type { AgentId } from "./workflow-policy";

export type ModelBCliArguments = {
  requestId: string;
  mode: "preview" | "execute";
};

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;
const USAGE =
  "Usage: execute-ai-workflow-model-b.ts <request-id> [--preview|--execute]";

/** Strict parsing prevents accidentally treating unknown modes as execution. */
export function parseModelBCliArguments(
  args: readonly string[]
): ModelBCliArguments {
  assert.ok(args.length >= 1 && args.length <= 2, USAGE);
  const [requestId, flag] = args;
  assert.ok(
    requestId &&
      REQUEST_ID_PATTERN.test(requestId) &&
      !requestId.startsWith("--"),
    USAGE
  );

  if (flag === undefined || flag === "--preview") {
    return { requestId, mode: "preview" };
  }
  assert.equal(flag, "--execute", USAGE);
  return { requestId, mode: "execute" };
}

/** Check before fetching approvals, making RPC calls, or loading keys. */
export function assertModelBExecutionAllowed(
  network: string,
  interactive: boolean
): void {
  assert.equal(network, "devnet", "Model B execution is Devnet-only");
  assert.equal(
    interactive,
    true,
    "Model B execution requires an interactive terminal"
  );
}

/** Load ONLY the selected agent's existing key. Never load an owner key. */
export function loadModelBAgentSigner(
  runtimeDir: string,
  agent: AgentId
): Keypair {
  assert.ok(
    agent === "agent-a" || agent === "agent-b",
    "Unknown Model B agent"
  );
  const path = join(runtimeDir, `${agent}.json`);
  const metadata = lstatSync(path);
  assert.ok(
    metadata.isFile() && !metadata.isSymbolicLink(),
    "Model B agent key must be a regular file"
  );
  assert.equal(
    metadata.mode & 0o022,
    0,
    "Model B agent key must not be group/world-writable"
  );

  const secret = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assert.ok(
    Array.isArray(secret) &&
      secret.length === 64 &&
      secret.every(
        (value: unknown) =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0 &&
          value <= 255
      ),
    "Invalid Model B agent keypair file"
  );
  return Keypair.fromSecretKey(Uint8Array.from(secret as number[]));
}
