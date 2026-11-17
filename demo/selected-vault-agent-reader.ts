/**
 * Devnet-only, read-only agent/task projection for an already verified vault.
 *
 * The caller MUST independently authenticate the wallet session, pin the
 * Devnet genesis and reverify owner/vault/treasury on-chain on EVERY request.
 * `Program.account.*.all()` supplies discriminator-decoded, program-owned
 * Anchor accounts. Do not use arbitrary browser-supplied account records.
 *
 * No off-chain demo labels, approvals or payments are included.
 */
import { PublicKey } from "@solana/web3.js";
import type { VerifiedOwnerVault } from "./owner-vault-verifier";

const PROGRAM_ID = new PublicKey("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");
const MAX_AGENT_ACCOUNTS = 2_000;
const MAX_TASK_ACCOUNTS = 2_000;
const MAX_SCOPED_AGENTS = 128;
const MAX_SCOPED_TASKS = 512;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const I64_MIN = -(BigInt(1) << BigInt(63));
const I64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);

type RecordEntry = { publicKey: PublicKey; account: unknown };

export type ScopedTask = {
  taskPda: string;
  taskId: string;
  recipient: string;
  budgetBaseUnits: string;
  spentBaseUnits: string;
  remainingBaseUnits: string;
  nextNonce: string;
  expiresAtUnix: string;
  active: boolean;
};
export type ScopedAgent = {
  agentPda: string;
  authority: string;
  active: boolean;
  tasks: ScopedTask[];
};
export type SelectedVaultAgentsResponse = {
  network: "devnet";
  vault: string;
  owner: string;
  agents: ScopedAgent[];
};

function reject(): never {
  throw new Error("Selected-vault agent/task account verification failed");
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}
function key(value: unknown): PublicKey {
  if (!(value instanceof PublicKey)) reject();
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") reject();
  return value;
}
function integer(value: unknown, signed = false): bigint {
  let raw: string;
  if (typeof value === "bigint") raw = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value)) raw = String(value);
  else if (value && typeof value === "object" && typeof (value as { toString?: unknown }).toString === "function") {
    raw = (value as { toString: (base?: number) => string }).toString(10);
  } else reject();
  if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) reject();
  const parsed = BigInt(raw);
  if (signed ? (parsed < I64_MIN || parsed > I64_MAX) : (parsed < BigInt(0) || parsed > U64_MAX)) reject();
  return parsed;
}
function bumpOf(value: unknown, expected: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value !== expected) reject();
}
function u64Bytes(value: bigint): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(value);
  return result;
}

/**
 * Pure verification/projection. All records MUST come from Anchor's two
 * program-owned account namespaces; foreign-vault records are discarded.
 * Any malformed record that *claims* this vault/agent fails the whole read.
 */
export function projectVerifiedVaultAgentsAndTasks(args: {
  verified: VerifiedOwnerVault;
  agentAccounts: readonly RecordEntry[];
  taskAccounts: readonly RecordEntry[];
}): SelectedVaultAgentsResponse {
  const { verified, agentAccounts, taskAccounts } = args;
  if (agentAccounts.length > MAX_AGENT_ACCOUNTS || taskAccounts.length > MAX_TASK_ACCOUNTS) reject();
  const vault = new PublicKey(verified.vault);
  const owner = new PublicKey(verified.owner);
  if (vault.toBase58() !== verified.vault || owner.toBase58() !== verified.owner) reject();

  const agents = new Map<string, ScopedAgent>();
  for (const record of agentAccounts) {
    const data = obj(record.account);
    // Other customers' accounts are expected; never display them.
    const parent = key(data.vault);
    if (!parent.equals(vault)) continue;
    const authority = key(data.authority);
    const [expected, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()], PROGRAM_ID
    );
    if (!key(record.publicKey).equals(expected)) reject();
    bumpOf(data.bump, bump);
    const address = expected.toBase58();
    if (agents.has(address) || agents.size >= MAX_SCOPED_AGENTS) reject();
    agents.set(address, {
      agentPda: address,
      authority: authority.toBase58(),
      active: flag(data.active),
      tasks: [],
    });
  }

  let scopedTasks = 0;
  const seenTasks = new Set<string>();
  for (const record of taskAccounts) {
    const data = obj(record.account);
    const parent = key(data.agent);
    const agent = agents.get(parent.toBase58());
    if (!agent) continue;
    if (++scopedTasks > MAX_SCOPED_TASKS) reject();
    const id = integer(data.taskId);
    const [expected, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), parent.toBuffer(), u64Bytes(id)], PROGRAM_ID
    );
    const taskPda = key(record.publicKey);
    if (!taskPda.equals(expected) || seenTasks.has(taskPda.toBase58())) reject();
    seenTasks.add(taskPda.toBase58());
    bumpOf(data.bump, bump);
    if (data.vault !== undefined && !key(data.vault).equals(vault)) reject();
    const budget = integer(data.budget);
    const spent = integer(data.spent);
    if (spent > budget) reject();
    agent.tasks.push({
      taskPda: taskPda.toBase58(),
      taskId: id.toString(),
      recipient: key(data.recipient).toBase58(),
      budgetBaseUnits: budget.toString(),
      spentBaseUnits: spent.toString(),
      remainingBaseUnits: (budget - spent).toString(),
      nextNonce: integer(data.nextNonce).toString(),
      expiresAtUnix: integer(data.expiresAt, true).toString(),
      active: flag(data.active),
    });
  }

  const ordered = [...agents.values()].sort((a, b) => a.agentPda.localeCompare(b.agentPda));
  for (const agent of ordered) {
    agent.tasks.sort((a, b) => {
      const left = BigInt(a.taskId);
      const right = BigInt(b.taskId);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
  return { network: "devnet", vault: verified.vault, owner: verified.owner, agents: ordered };
}
