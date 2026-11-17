import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  MODEL_B_SANDBOX_DESCRIPTION,
  MODEL_B_SANDBOX_REQUEST,
  selectModelBDevnetSandboxInstruction,
  type ModelBDevnetSandboxContext,
} from "./model-b-devnet-sandbox";

function valid(): ModelBDevnetSandboxContext {
  return {
    network: "devnet",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    programId: "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d",
    owner: "J2GL63eJnVsmJipKkFiaLvwrdSiGnfj5ESpa1HcJXS2G",
    vault: "9uwN9YvPXKTdnRjKth6uAxK9AcWWLA5ckXMGdb5KbuXB",
    requestId: MODEL_B_SANDBOX_REQUEST,
    assignedAgent: "agent-a",
    kind: "procurement",
    agentAuthority: "24y99x9EPoJ2ToqygjM37eU9AXz3aFwiDcHFv87LXQfQ",
    taskId: 1003,
    approvedTaskPda: "5GXdEvq6J9W6N4wDwEaKGpPdoWHenQrQ9dMkAVsvRPo5",
    recipient: "4wYomRn46zRQFFxrovWpeGXesQzAU8YhGeVVpBfZPm5e",
    amountBaseUnits: 1000,
    description: MODEL_B_SANDBOX_DESCRIPTION,
  };
}

test("explicit flag and every pinned field permit only a sandbox model instruction", () => {
  const message = selectModelBDevnetSandboxInstruction("1", valid());
  assert.match(message!, /Devnet-only evaluation profile/);
  assert.match(message!, /REJECT/);
  assert.doesNotMatch(message!, /systemInstruction:/);
});

test("normal production Model B workflow has no sandbox instruction", () => {
  const normal = {
    ...valid(),
    requestId: "procurement-009",
    taskId: 7,
    recipient: "test-normal",
  };
  assert.equal(selectModelBDevnetSandboxInstruction(undefined, normal), null);
  assert.equal(selectModelBDevnetSandboxInstruction("0", normal), null);
});

test("sandbox context cannot use cached PAY when opt-in is absent", () => {
  assert.throws(
    () => selectModelBDevnetSandboxInstruction(undefined, valid()),
    /explicit/
  );
  assert.throws(
    () => selectModelBDevnetSandboxInstruction("0", valid()),
    /explicit/
  );
});

test("sandbox task cannot be used without opt-in, even for another request", () => {
  assert.throws(
    () =>
      selectModelBDevnetSandboxInstruction(undefined, {
        ...valid(),
        requestId: "some-new-request",
      }),
    /explicit/
  );
});

test("sandbox recipient cannot be reused by other tasks without opt-in", () => {
  assert.throws(
    () =>
      selectModelBDevnetSandboxInstruction(undefined, {
        ...valid(),
        requestId: "other-request",
        taskId: 999,
      }),
    /explicit/
  );
});

test("invalid flag is never treated as opt-in", () => {
  assert.throws(
    () => selectModelBDevnetSandboxInstruction("true", valid()),
    /Invalid/
  );
});

test("opt-in cannot apply to a different request or task", () => {
  for (const property of ["requestId", "taskId", "approvedTaskPda"] as const) {
    assert.throws(
      () =>
        selectModelBDevnetSandboxInstruction("1", {
          ...valid(),
          [property]: property === "taskId" ? 999 : "wrong",
        }),
      /mismatch/
    );
  }
});

test("opt-in cannot apply to another ledger, owner, vault, program or agent", () => {
  for (const property of [
    "network",
    "genesisHash",
    "programId",
    "owner",
    "vault",
    "assignedAgent",
    "agentAuthority",
    "kind",
  ] as const) {
    assert.throws(
      () =>
        selectModelBDevnetSandboxInstruction("1", {
          ...valid(),
          [property]: "wrong",
        }),
      /mismatch/
    );
  }
});

test("opt-in rejects another recipient, payment amount or description", () => {
  for (const property of [
    "recipient",
    "amountBaseUnits",
    "description",
  ] as const) {
    assert.throws(
      () =>
        selectModelBDevnetSandboxInstruction("1", {
          ...valid(),
          [property]: property === "amountBaseUnits" ? 999 : "wrong",
        }),
      /mismatch/
    );
  }
});

test("integration is wired before AI receipt cache and remains PAY-only", () => {
  const source = readFileSync(
    join(__dirname, "ai-workflow-model-b.ts"),
    "utf8"
  );
  const guard = source.indexOf(
    "const sandboxInstruction = selectModelBDevnetSandboxInstruction("
  );
  const receipt = source.indexOf("await resolveModelBAiDecision(");
  assert.ok(
    guard >= 0 && receipt > guard,
    "sandbox gate must precede receipt read"
  );
  assert.match(
    source,
    /requireModelBPayRecommendation\(\s*await evaluateWithGemini\(workflow, sandboxInstruction\)/
  );
  assert.match(
    source,
    /sandboxInstruction \? "\\n" \+ sandboxInstruction : ""/
  );
});
