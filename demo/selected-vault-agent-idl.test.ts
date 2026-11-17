import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const idl = JSON.parse(readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")) as {
  accounts?: { name: string }[];
  types?: { name: string; type?: { kind: string; fields?: { name: string }[] } }[];
};

function normalize(name: string): string {
  return name.replace(/_/g, "").toLowerCase();
}

test("deployed Anchor IDL exposes agent/task fields required by scoped readers", () => {
  for (const kind of ["agent", "task"]) {
    assert.ok(idl.accounts?.some((entry) => normalize(entry.name) === kind), `Missing ${kind} IDL account`);
  }
  const expectations: Record<string, string[]> = {
    Agent: ["vault", "authority", "active", "bump"],
    Task: ["agent", "taskId", "recipient", "budget", "spent", "nextNonce", "expiresAt", "active", "bump"],
  };
  for (const [name, expected] of Object.entries(expectations)) {
    const type = idl.types?.find((entry) => normalize(entry.name) === normalize(name));
    assert.equal(type?.type?.kind, "struct", `${name} account struct missing`);
    const fields = (type?.type?.fields ?? []).map((field) => normalize(field.name));
    for (const field of expected) {
      assert.ok(fields.includes(normalize(field)), `${name}.${field} missing; actual fields: ${fields.join(", ")}`);
    }
  }
});
