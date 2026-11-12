import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const normalize = (name: string) => name.replace(/_/g, "").toLowerCase();
test("generated AgentVault IDL agrees with owner emergency-control account order", () => {
  type IdlInstruction = {
    name: string;
    discriminator: number[];
    accounts: { name: string; writable?: boolean; signer?: boolean }[];
    args: { name: string; type: unknown }[];
  };
  const idl = JSON.parse(readFileSync("target/idl/agentvault.json", "utf8")) as {
    instructions: IdlInstruction[];
  };
  const cases = [
    { name: "revoke_task", discriminator: [188, 70, 249, 6, 56, 255, 109, 40],
      keys: [["owner", false, true], ["vault", true, false],
        ["agent", false, false], ["task", true, false]] },
    { name: "deactivate_agent", discriminator: [205, 171, 239, 225, 82, 126, 96, 166],
      keys: [["owner", false, true], ["vault", false, false], ["agent", true, false]] },
    { name: "set_vault_paused", discriminator: [239, 131, 203, 69, 243, 11, 234, 153],
      keys: [["owner", false, true], ["vault", true, false]] },
  ] as const;
  for (const expected of cases) {
    const ix = idl.instructions.find((entry) => normalize(entry.name) === normalize(expected.name));
    assert.ok(ix, `Missing IDL instruction ${expected.name}`);
    assert.deepEqual(ix.discriminator, expected.discriminator);
    assert.deepEqual(ix.accounts.map((key) => [normalize(key.name), !!key.writable, !!key.signer]),
      expected.keys.map(([name, writable, signer]) => [name, writable, signer]));
    if (expected.name === "set_vault_paused") {
      assert.deepEqual(ix.args.map((arg) => [normalize(arg.name), arg.type]), [["paused", "bool"]]);
    } else assert.equal(ix.args.length, 0);
  }
});
