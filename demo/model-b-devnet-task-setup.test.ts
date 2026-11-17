import assert from "node:assert/strict";
import { test } from "node:test";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  DEVNET_AGENT_AUTHORITIES,
  deriveApprovedTaskPda,
  parseModelBTaskArgs,
  validateModelBTaskPlan,
} from "./model-b-devnet-task-setup";

const args = [
  "--agent",
  "agent-a",
  "--task-id",
  "1001",
  "--budget",
  "20000",
  "--recipient",
  "owner",
];
const pub = () => Keypair.generate().publicKey;
const owner = pub();
const mint = pub();
const vault = pub();
const programId = pub();
const agentAuthority = new PublicKey(DEVNET_AGENT_AUTHORITIES["agent-a"]);

function fixture() {
  const parsed = parseModelBTaskArgs(args);
  return {
    parsed,
    ctx: {
      state: {
        genesisHash: pub().toBase58(),
        owner: owner.toBase58(),
        mint: mint.toBase58(),
        vault: vault.toBase58(),
        programId: programId.toBase58(),
        vaultId: "1",
        treasury: pub().toBase58(),
      },
      vault: {
        owner,
        tokenMint: mint,
        paused: false,
        totalReserved: new BN(160000),
      },
      agent: { vault, authority: agentAuthority, active: true },
      treasuryBalance: BigInt("310000"),
      nowUnix: BigInt("1794300000"),
      taskAlreadyExists: false,
    },
  };
}

test("defaults to inspection with an explicit owner-recipient test plan", () => {
  assert.deepEqual(parseModelBTaskArgs(args), {
    mode: "inspect",
    agent: "agent-a",
    taskId: "1001",
    budget: "20000",
    recipient: "owner",
    expiresHours: 24,
  });
});
test("only exact --create permits the creation mode", () => {
  assert.equal(parseModelBTaskArgs([...args, "--create"]).mode, "create");
  assert.throws(() => parseModelBTaskArgs([...args, "--send"]), /unknown flag/);
  assert.throws(
    () => parseModelBTaskArgs([...args, "--create", "--create"]),
    /Duplicate/
  );
});
test("rejects missing and repeated CLI parameters", () => {
  assert.throws(() => parseModelBTaskArgs(["--agent", "agent-a"]), /Usage/);
  assert.throws(
    () => parseModelBTaskArgs([...args, "--budget", "1"]),
    /Duplicate/
  );
  assert.throws(() => parseModelBTaskArgs([...args, "--budget"]), /Duplicate/);
});
test("rejects invalid agents and noncanonical task IDs", () => {
  assert.throws(
    () => parseModelBTaskArgs(["--agent", "bad", ...args.slice(2)]),
    /Usage/
  );
  assert.throws(
    () =>
      parseModelBTaskArgs([
        "--agent",
        "agent-a",
        "--task-id",
        "01",
        ...args.slice(4),
      ]),
    /task ID/
  );
  assert.throws(
    () =>
      parseModelBTaskArgs([
        "--agent",
        "agent-a",
        "--task-id",
        "18446744073709551616",
        ...args.slice(4),
      ]),
    /exceeds u64/
  );
});
test("rejects zero and oversized budgets", () => {
  assert.throws(
    () =>
      parseModelBTaskArgs([
        ...args.slice(0, 4),
        "--budget",
        "0",
        ...args.slice(6),
      ]),
    /Demo budget/
  );
  assert.throws(
    () =>
      parseModelBTaskArgs([
        ...args.slice(0, 4),
        "--budget",
        "50001",
        ...args.slice(6),
      ]),
    /Demo budget/
  );
});
test("rejects inappropriate expiry durations", () => {
  assert.throws(
    () => parseModelBTaskArgs([...args, "--expires-hours", "0"]),
    /Expiry/
  );
  assert.throws(
    () => parseModelBTaskArgs([...args, "--expires-hours", "73"]),
    /Expiry/
  );
});
test("rejects malformed and default recipient", () => {
  assert.throws(
    () => parseModelBTaskArgs([...args.slice(0, 7), "bad-key"]),
    /Invalid public key input|Non-base58|Invalid recipient/
  );
  assert.throws(
    () =>
      parseModelBTaskArgs([
        ...args.slice(0, 7),
        SystemProgram.programId.toBase58(),
      ]),
    /Invalid recipient/
  );
});
test("ApprovedTask derives exactly from agent, little-endian task ID and namespace", () => {
  const pda = deriveApprovedTaskPda(pub(), "1001", programId);
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt("1001"));
  const agent = pub();
  const b = deriveApprovedTaskPda(agent, "1001", programId);
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agent.toBuffer(), id],
    programId
  )[0];
  assert.ok(b.equals(expected));
  assert.ok(!pda.equals(b));
});
test("valid plan respects reservation conservation and uses owner as recipient", () => {
  const f = fixture();
  const result = validateModelBTaskPlan(f.parsed, f.ctx);
  assert.equal(result.freeBalance, BigInt("150000"));
  assert.equal(
    result.expiryUnix,
    f.ctx.nowUnix + BigInt("24") * BigInt("3600")
  );
  assert.ok(result.recipient.equals(owner));
});
test("rejects paused vault, inactive agent, duplicate task", () => {
  const f = fixture();
  f.ctx.vault.paused = true;
  assert.throws(() => validateModelBTaskPlan(f.parsed, f.ctx), /paused/);
  f.ctx.vault.paused = false;
  f.ctx.agent.active = false;
  assert.throws(() => validateModelBTaskPlan(f.parsed, f.ctx), /inactive/);
  f.ctx.agent.active = true;
  f.ctx.taskAlreadyExists = true;
  assert.throws(
    () => validateModelBTaskPlan(f.parsed, f.ctx),
    /already exists/
  );
});
test("rejects mismatch in owner, mint, agent and vault relationships", () => {
  const f = fixture();
  f.ctx.vault.owner = pub();
  assert.throws(() => validateModelBTaskPlan(f.parsed, f.ctx), /owner differs/);
  f.ctx.vault.owner = owner;
  f.ctx.vault.tokenMint = pub();
  assert.throws(() => validateModelBTaskPlan(f.parsed, f.ctx), /mint differs/);
  f.ctx.vault.tokenMint = mint;
  f.ctx.agent.vault = pub();
  assert.throws(() => validateModelBTaskPlan(f.parsed, f.ctx), /another Vault/);
  f.ctx.agent.vault = vault;
  f.ctx.agent.authority = pub();
  assert.throws(
    () => validateModelBTaskPlan(f.parsed, f.ctx),
    /pinned Devnet authority/
  );
});
test("rejects overspending or undercollateralized treasury", () => {
  const f = fixture();
  f.ctx.treasuryBalance = BigInt("170000");
  assert.throws(
    () => validateModelBTaskPlan(f.parsed, f.ctx),
    /Insufficient unreserved/
  );
  f.ctx.treasuryBalance = BigInt("100000");
  assert.throws(
    () => validateModelBTaskPlan(f.parsed, f.ctx),
    /undercollateralized/
  );
});
test("rejects impossible on-chain clock", () => {
  const f = fixture();
  f.ctx.nowUnix = BigInt("-1");
  assert.throws(
    () => validateModelBTaskPlan(f.parsed, f.ctx),
    /Unexpected chain clock/
  );
});
