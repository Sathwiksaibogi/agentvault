import { strict as assert } from "node:assert";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { RUNTIME_DIR } from "./runtime-config";
import { webAgents } from "../frontend/src/webAgents";
import {
  WEB_AGENT_KEYS_DIR,
  WEB_EXECUTION_DIR,
  WEB_APPROVAL_DIR,
  assertWebDevnetConfig,
  expectedWebGenesisHash,
  loadWebSignedApproval,
} from "./web-executor-config";

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

assertWebDevnetConfig();
assert.equal(webAgents.agents.length, 2);
assert.notEqual(webAgents.agents[0].authority, webAgents.agents[1].authority);
assert.ok(inside(WEB_AGENT_KEYS_DIR, WEB_EXECUTION_DIR));
assert.ok(!inside(RUNTIME_DIR, WEB_EXECUTION_DIR));
assert.ok(!inside(WEB_EXECUTION_DIR, WEB_APPROVAL_DIR));
assert.ok(WEB_APPROVAL_DIR.endsWith("web-approvals"));
assert.ok(expectedWebGenesisHash().length > 0);
assert.throws(() => loadWebSignedApproval("../state.json"));
console.log(
  "PASS: Vault 2 runtime directories and agent identities are isolated"
);
console.log("PASS: invalid approval request IDs rejected");
console.log("No Gemini request, transaction signing or broadcast.");
