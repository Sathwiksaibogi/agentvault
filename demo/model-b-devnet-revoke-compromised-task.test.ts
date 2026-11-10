import { strict as assert } from "node:assert";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  parseRevokeArgs,
  assertCompromisedTaskIsSafeToRevoke,
  COMPROMISED_TASK_ID,
  COMPROMISED_TASK_PDA,
  COMPROMISED_RECIPIENT,
  EXPECTED_AGENT_AUTHORITY,
  EXPECTED_GENESIS,
  EXPECTED_PROGRAM_ID,
  EXPECTED_VAULT,
} from "./model-b-devnet-revoke-compromised-task";

const pk = (s: string) => new PublicKey(s);
const agentKey = PublicKey.findProgramAddressSync(
  [
    Buffer.from("agent"),
    pk(EXPECTED_VAULT).toBuffer(),
    pk(EXPECTED_AGENT_AUTHORITY).toBuffer(),
  ],
  pk(EXPECTED_PROGRAM_ID)
)[0];
const owner = pk("J2GL63eJnVsmJipKkFiaLvwrdSiGnfj5ESpa1HcJXS2G");

function example() {
  return {
    programId: pk(EXPECTED_PROGRAM_ID),
    vaultKey: pk(EXPECTED_VAULT),
    stateOwner: owner,
    vault: { owner, totalReserved: { toString: () => "190000" } },
    agentKey,
    agent: {
      vault: pk(EXPECTED_VAULT),
      authority: pk(EXPECTED_AGENT_AUTHORITY),
    },
    taskKey: pk(COMPROMISED_TASK_PDA),
    task: {
      vault: pk(EXPECTED_VAULT),
      agent: agentKey,
      recipient: pk(COMPROMISED_RECIPIENT),
      taskId: { toString: () => COMPROMISED_TASK_ID },
      budget: { toString: () => "10000" },
      spent: { toString: () => "0" },
      nextNonce: { toString: () => "0" },
      active: true,
      genesisHash: pk(EXPECTED_GENESIS),
    },
  };
}

test("default mode is inspect; only exact --revoke authorizes live mutation", () => {
  assert.equal(parseRevokeArgs([]), "inspect");
  assert.equal(parseRevokeArgs(["--revoke"]), "revoke");
  for (const argv of [["--execute"], ["--revoke", "--revoke"], ["other"]]) {
    assert.throws(() => parseRevokeArgs(argv));
  }
});
test("recognizes only the intended untouched compromised Devnet task", () => {
  assert.equal(assertCompromisedTaskIsSafeToRevoke(example()), BigInt(10000));
});
test("refuses a different recipient", () => {
  const view = example();
  view.task.recipient = owner;
  assert.throws(() => assertCompromisedTaskIsSafeToRevoke(view), /recipient/);
});
test("refuses a spent or already used task", () => {
  const spent = example();
  spent.task.spent.toString = () => "1";
  assert.throws(
    () => assertCompromisedTaskIsSafeToRevoke(spent),
    /spending activity/
  );
  const nonce = example();
  nonce.task.nextNonce.toString = () => "1";
  assert.throws(
    () => assertCompromisedTaskIsSafeToRevoke(nonce),
    /nonce changed/
  );
});
test("refuses duplicate revocation of an inactive task", () => {
  const view = example();
  view.task.active = false;
  assert.throws(
    () => assertCompromisedTaskIsSafeToRevoke(view),
    /already inactive/
  );
});
test("refuses invalid reservation accounting", () => {
  const view = example();
  view.vault.totalReserved.toString = () => "9999";
  assert.throws(
    () => assertCompromisedTaskIsSafeToRevoke(view),
    /Reservation invariant/
  );
});
test("refuses another vault, chain, program, or relationship", () => {
  const v = example();
  v.task.vault = owner;
  assert.throws(() => assertCompromisedTaskIsSafeToRevoke(v));
  const g = example();
  g.task.genesisHash = owner;
  assert.throws(() => assertCompromisedTaskIsSafeToRevoke(g));
  const a = example();
  a.agent.authority = owner;
  assert.throws(() => assertCompromisedTaskIsSafeToRevoke(a));
});
