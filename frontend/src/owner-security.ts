/**
 * Devnet-only owner emergency controls. All policy changes require a fresh
 * owner-wallet signature; no agent secrets or payment instructions are used.
 * This module never forwards the legacy demo owner's API credential.
 */
import { Buffer } from "buffer";
import {
  Connection, PublicKey, TransactionInstruction,
  type AccountInfo,
} from "@solana/web3.js";
import {
  DEFAULT_PROGRAM_ID, DEVNET_RPC_URL, decodeOwnedVault, encodeU64LE,
} from "./onboarding";
import {
  buildOwnerPolicyTransaction, deriveAgentPda, deriveTaskPda,
  signAndBroadcastThroughDevnet,
  type OwnerWriteContext, type OwnerManagementWallet,
} from "./owner-management";

const REVOKE_TASK = Buffer.from([188, 70, 249, 6, 56, 255, 109, 40]);
const DEACTIVATE_AGENT = Buffer.from([205, 171, 239, 225, 82, 126, 96, 166]);
const SET_VAULT_PAUSED = Buffer.from([239, 131, 203, 69, 243, 11, 234, 153]);
const AGENT_ACCOUNT = Buffer.from([47, 166, 112, 147, 155, 197, 86, 7]);
const TASK_ACCOUNT = Buffer.from([79, 34, 229, 55, 88, 90, 55, 84]);
const MAX_U64 = (BigInt(1) << BigInt(64)) - BigInt(1);

export type SecurityTask = {
  taskPda: string;
  taskId: string;
  active: boolean;
};
export type SecurityAgent = {
  agentPda: string;
  authority: string;
  active: boolean;
  tasks: SecurityTask[];
};
export type SecurityResult = { signature: string; account: string };

function canonical(value: string): PublicKey {
  const key = new PublicKey(value);
  if (key.toBase58() !== value) throw new Error("Invalid noncanonical Solana address");
  return key;
}
function requireProgramAccount(
  info: AccountInfo<Buffer> | null,
  discriminator: Buffer,
  expectedLength: number,
): Buffer {
  if (!info || info.executable || !info.owner.equals(DEFAULT_PROGRAM_ID) ||
      info.data.length !== expectedLength ||
      !Buffer.from(info.data.subarray(0, 8)).equals(discriminator)) {
    throw new Error("Selected policy account is missing or invalid on Devnet");
  }
  return Buffer.from(info.data);
}

export function buildRevokeTaskInstruction(args: {
  owner: PublicKey; vault: PublicKey; agent: PublicKey; task: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: DEFAULT_PROGRAM_ID, data: REVOKE_TASK,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.agent, isSigner: false, isWritable: false },
      { pubkey: args.task, isSigner: false, isWritable: true },
    ],
  });
}

export function buildDeactivateAgentInstruction(args: {
  owner: PublicKey; vault: PublicKey; agent: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: DEFAULT_PROGRAM_ID, data: DEACTIVATE_AGENT,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.vault, isSigner: false, isWritable: false },
      { pubkey: args.agent, isSigner: false, isWritable: true },
    ],
  });
}

export function buildSetVaultPausedInstruction(args: {
  owner: PublicKey; vault: PublicKey; paused: boolean;
}): TransactionInstruction {
  if (typeof args.paused !== "boolean") throw new Error("Pause flag must be boolean");
  return new TransactionInstruction({
    programId: DEFAULT_PROGRAM_ID,
    data: Buffer.concat([SET_VAULT_PAUSED, Buffer.from([args.paused ? 1 : 0])]),
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.vault, isSigner: false, isWritable: true },
    ],
  });
}

/** Check on-chain owner/PDA/metadata, not just the browser's treasury response. */
async function verifiedContext(ctx: OwnerWriteContext) {
  if (ctx.snapshot.network !== "devnet") throw new Error("Security controls are Devnet-only");
  const owner = canonical(ctx.snapshot.owner);
  const vault = canonical(ctx.snapshot.vault);
  if (ctx.sessionOwner !== owner.toBase58() || !ctx.wallet.publicKey?.equals(owner)) {
    throw new Error("Connected wallet and authenticated owner do not match");
  }
  const connection = ctx.connection ?? new Connection(DEVNET_RPC_URL, "confirmed");
  const [program, info] = await Promise.all([
    connection.getAccountInfo(DEFAULT_PROGRAM_ID, "confirmed"),
    connection.getAccountInfo(vault, "confirmed"),
  ]);
  if (!program?.executable) throw new Error("AgentVault program unavailable on Devnet");
  const data = requireProgramAccount(info, Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]), 90);
  const decoded = decodeOwnedVault(vault, data, owner);
  if (!decoded || decoded.vaultId !== ctx.snapshot.vaultId ||
      decoded.tokenMint !== ctx.snapshot.tokenMint ||
      decoded.treasury !== ctx.snapshot.treasury ||
      decoded.paused !== ctx.snapshot.paused) {
    throw new Error("Vault owner, metadata or pause state changed; refresh before signing");
  }
  return { owner, vault, connection };
}

async function verifiedAgent(
  connection: Connection, vault: PublicKey, agent: SecurityAgent,
): Promise<PublicKey> {
  const authority = canonical(agent.authority);
  const agentPda = canonical(agent.agentPda);
  const [expected, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()], DEFAULT_PROGRAM_ID
  );
  if (!agentPda.equals(expected) || !deriveAgentPda(vault, authority).equals(expected)) {
    throw new Error("Agent PDA is not canonical for this vault");
  }
  const data = requireProgramAccount(
    await connection.getAccountInfo(agentPda, "confirmed"), AGENT_ACCOUNT, 74,
  );
  if (!new PublicKey(data.subarray(8, 40)).equals(vault) ||
      !new PublicKey(data.subarray(40, 72)).equals(authority) ||
      data[72] > 1 || data[73] !== bump || (data[72] === 1) !== agent.active) {
    throw new Error("Agent ownership or active state changed; refresh before signing");
  }
  return agentPda;
}

async function verifiedTask(
  connection: Connection, vault: PublicKey, agent: PublicKey, task: SecurityTask,
): Promise<PublicKey> {
  if (!/^(0|[1-9][0-9]*)$/.test(task.taskId)) throw new Error("Invalid task ID");
  const taskId = BigInt(task.taskId);
  if (taskId > MAX_U64) throw new Error("Task ID exceeds u64 range");
  const taskPda = canonical(task.taskPda);
  const [expected, bump] = PublicKey.findProgramAddressSync([
    Buffer.from("task"), agent.toBuffer(), Buffer.from(encodeU64LE(taskId)),
  ], DEFAULT_PROGRAM_ID);
  if (!taskPda.equals(expected) || !taskPda.equals(deriveTaskPda(agent, taskId))) {
    throw new Error("Task PDA is not canonical for the selected agent");
  }
  const data = requireProgramAccount(
    await connection.getAccountInfo(taskPda, "confirmed"), TASK_ACCOUNT, 146,
  );
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (!new PublicKey(data.subarray(8, 40)).equals(vault) ||
      !new PublicKey(data.subarray(40, 72)).equals(agent) ||
      view.getBigUint64(72, true) !== taskId || data[144] > 1 ||
      data[145] !== bump || (data[144] === 1) !== task.active ||
      view.getBigUint64(120, true) > view.getBigUint64(112, true)) {
    throw new Error("Task ownership, budget or active state changed; refresh before signing");
  }
  return taskPda;
}

/** Preserve signature on uncertain confirmation; never silently resubmit. */
async function sendControl(args: {
  connection: Connection;
  wallet: OwnerManagementWallet;
  owner: PublicKey;
  instruction: TransactionInstruction;
  account: PublicKey;
  verify: () => Promise<boolean>;
}): Promise<SecurityResult> {
  const { connection, wallet, owner, instruction, account, verify } = args;
  if (!wallet.publicKey?.equals(owner)) throw new Error("Owner wallet changed before signing");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = buildOwnerPolicyTransaction(owner, blockhash, instruction);
  if (!wallet.publicKey?.equals(owner)) throw new Error("Owner wallet changed before signing");
  const signature = await signAndBroadcastThroughDevnet(connection, wallet, tx);
  try {
    const result = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight }, "confirmed"
    );
    if (result.value.err) throw new Error("Transaction failed on-chain");
  } catch {
    const status = await connection.getSignatureStatuses(
      [signature], { searchTransactionHistory: true }
    ).then((response) => response.value[0]).catch(() => null);
    if (status?.err) throw new Error(`Devnet transaction ${signature} failed on-chain`);
    if (status?.confirmationStatus !== "confirmed" && status?.confirmationStatus !== "finalized") {
      throw new Error(`Devnet transaction ${signature} unverified; inspect before any retry`);
    }
  }
  if (!(await verify())) {
    throw new Error(`Devnet transaction ${signature} confirmed, but state not verified; refresh before retrying`);
  }
  return { signature, account: account.toBase58() };
}

export async function revokeOwnerTask(
  args: OwnerWriteContext & { agent: SecurityAgent; task: SecurityTask }
): Promise<SecurityResult> {
  const { connection, owner, vault } = await verifiedContext(args);
  const agent = await verifiedAgent(connection, vault, args.agent);
  const task = await verifiedTask(connection, vault, agent, args.task);
  if (!args.task.active) throw new Error("Task is already revoked");
  return sendControl({
    connection, wallet: args.wallet, owner, account: task,
    instruction: buildRevokeTaskInstruction({ owner, vault, agent, task }),
    verify: async () => {
      const data = requireProgramAccount(await connection.getAccountInfo(task, "confirmed"), TASK_ACCOUNT, 146);
      return data[144] === 0 && new PublicKey(data.subarray(8, 40)).equals(vault) &&
        new PublicKey(data.subarray(40, 72)).equals(agent);
    },
  });
}

export async function deactivateOwnerAgent(
  args: OwnerWriteContext & { agent: SecurityAgent }
): Promise<SecurityResult> {
  const { connection, owner, vault } = await verifiedContext(args);
  const agent = await verifiedAgent(connection, vault, args.agent);
  if (!args.agent.active) throw new Error("Agent is already deactivated");
  return sendControl({
    connection, wallet: args.wallet, owner, account: agent,
    instruction: buildDeactivateAgentInstruction({ owner, vault, agent }),
    verify: async () => {
      const data = requireProgramAccount(await connection.getAccountInfo(agent, "confirmed"), AGENT_ACCOUNT, 74);
      return data[72] === 0 && new PublicKey(data.subarray(8, 40)).equals(vault);
    },
  });
}

export async function setOwnerVaultPaused(
  args: OwnerWriteContext & { paused: boolean }
): Promise<SecurityResult> {
  const { connection, owner, vault } = await verifiedContext(args);
  if (args.paused === args.snapshot.paused) throw new Error("Vault already has requested pause state");
  return sendControl({
    connection, wallet: args.wallet, owner, account: vault,
    instruction: buildSetVaultPausedInstruction({ owner, vault, paused: args.paused }),
    verify: async () => {
      const info = await connection.getAccountInfo(vault, "confirmed");
      if (!info || info.executable || !info.owner.equals(DEFAULT_PROGRAM_ID)) return false;
      return decodeOwnedVault(vault, info.data, owner)?.paused === args.paused;
    },
  });
}
