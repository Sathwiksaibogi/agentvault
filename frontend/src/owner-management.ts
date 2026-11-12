/**
 * Devnet-only owner-signed Model A configuration transactions.
 * No API token, agent secret or payment signing is handled here.
 * The backend remains a read-only, per-vault session gateway.
 */
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  DEFAULT_PROGRAM_ID,
  DEVNET_RPC_URL,
  TOKEN_PROGRAM_ID,
  decodeOwnedVault,
  deriveTreasury,
  encodeU64LE,
  type SignAndSendWallet,
} from "./onboarding";

const REGISTER_AGENT_DISCRIMINATOR = Buffer.from([135, 157, 66, 195, 2, 113, 175, 30]);
const CREATE_TASK_DISCRIMINATOR = Buffer.from([194, 80, 6, 180, 232, 127, 48, 171]);
const MAX_U64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const MAX_I64 = (BigInt(1) << BigInt(63)) - BigInt(1);

/** Avoid floating-point amounts, scientific notation, rounding, and exponent notation. */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Unsupported mint decimal precision");
  }
  if (!/^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.test(amount)) {
    throw new Error("Use a positive decimal token amount without commas or exponents");
  }
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) throw new Error("Amount has too many decimal places");
  const base = BigInt(whole) * BigInt(10) ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (base < BigInt(1) || base > MAX_U64) throw new Error("Budget outside supported u64 range");
  return base;
}

export function parseU64Id(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Task ID must be an unsigned integer");
  const result = BigInt(value);
  if (result > MAX_U64) throw new Error("Task ID exceeds u64 range");
  return result;
}

export function parseExpiryHours(hours: string, nowMs = Date.now()): bigint {
  if (!/^[1-9][0-9]{0,5}$/.test(hours)) throw new Error("Expiry must be whole hours greater than zero");
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  const expiry = nowSec + BigInt(hours) * BigInt(3600);
  if (expiry > MAX_I64) throw new Error("Expiry outside supported i64 range");
  return expiry;
}

function encodeI64LE(value: bigint): Buffer {
  if (value < -(BigInt(1) << BigInt(63)) || value > MAX_I64) {
    throw new Error("Expiry outside supported i64 range");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return Buffer.from(bytes);
}

function canonical(value: string): PublicKey {
  const parsed = new PublicKey(value);
  if (parsed.toBase58() !== value) throw new Error("Invalid noncanonical public key");
  return parsed;
}

export function deriveAgentPda(vault: PublicKey, authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()],
    DEFAULT_PROGRAM_ID
  )[0];
}

export function deriveTaskPda(agent: PublicKey, taskId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("task"), agent.toBuffer(), Buffer.from(encodeU64LE(taskId))],
    DEFAULT_PROGRAM_ID
  )[0];
}

export function buildRegisterAgentInstruction(args: {
  owner: PublicKey;
  vault: PublicKey;
  authority: PublicKey;
}): { agent: PublicKey; instruction: TransactionInstruction } {
  if (!PublicKey.isOnCurve(args.authority.toBytes())) {
    throw new Error("Agent authority must be a signing-wallet public key, not a PDA");
  }
  const agent = deriveAgentPda(args.vault, args.authority);
  return {
    agent,
    instruction: new TransactionInstruction({
      programId: DEFAULT_PROGRAM_ID,
      data: Buffer.concat([REGISTER_AGENT_DISCRIMINATOR, args.authority.toBuffer()]),
      keys: [
        { pubkey: args.owner, isSigner: true, isWritable: true },
        { pubkey: args.vault, isSigner: false, isWritable: true },
        { pubkey: agent, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }),
  };
}

export function buildCreateTaskInstruction(args: {
  owner: PublicKey;
  vault: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  recipient: PublicKey;
  taskId: bigint;
  budget: bigint;
  expiresAt: bigint;
}): { task: PublicKey; instruction: TransactionInstruction } {
  if (args.budget < BigInt(1) || args.budget > MAX_U64) throw new Error("Invalid task budget");
  if (args.expiresAt < BigInt(1) || args.expiresAt > MAX_I64) throw new Error("Invalid expiration");
  const task = deriveTaskPda(args.agent, args.taskId);
  const treasury = deriveTreasury(args.vault, args.mint);
  return {
    task,
    instruction: new TransactionInstruction({
      programId: DEFAULT_PROGRAM_ID,
      data: Buffer.concat([
        CREATE_TASK_DISCRIMINATOR,
        Buffer.from(encodeU64LE(args.taskId)),
        Buffer.from(encodeU64LE(args.budget)),
        args.recipient.toBuffer(),
        encodeI64LE(args.expiresAt),
      ]),
      keys: [
        { pubkey: args.owner, isSigner: true, isWritable: true },
        { pubkey: args.vault, isSigner: false, isWritable: true },
        { pubkey: args.agent, isSigner: false, isWritable: false },
        { pubkey: args.mint, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: false },
        { pubkey: task, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }),
  };
}

export type SelectedVaultSnapshot = {
  network: "devnet";
  owner: string;
  vault: string;
  vaultId: string;
  tokenMint: string;
  treasury: string;
  decimals: number;
  paused: boolean;
  availableBaseUnits: string;
};

export type SelectedAgentSnapshot = {
  agentPda: string;
  authority: string;
  active: boolean;
};

export type OwnerWriteContext = {
  wallet: SignAndSendWallet;
  snapshot: SelectedVaultSnapshot;
  /** Caller must have an authenticated, vault-scoped owner session. */
  sessionOwner: string;
  connection?: Connection;
};

/** Fail closed against stale/wrongly selected vault before prompting Phantom. */
async function preflight(ctx: OwnerWriteContext): Promise<{
  connection: Connection;
  owner: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
}> {
  const connection = ctx.connection ?? new Connection(DEVNET_RPC_URL, "confirmed");
  if (ctx.snapshot.network !== "devnet") throw new Error("Only Devnet owner configuration is enabled");
  const owner = canonical(ctx.snapshot.owner);
  const vault = canonical(ctx.snapshot.vault);
  const mint = canonical(ctx.snapshot.tokenMint);
  if (ctx.sessionOwner !== ctx.snapshot.owner || !ctx.wallet.publicKey?.equals(owner)) {
    throw new Error("Connected wallet and authenticated owner do not match");
  }
  const [program, info] = await Promise.all([
    connection.getAccountInfo(DEFAULT_PROGRAM_ID, "confirmed"),
    connection.getAccountInfo(vault, "confirmed"),
  ]);
  if (!program?.executable || !info || info.executable || !info.owner.equals(DEFAULT_PROGRAM_ID)) {
    throw new Error("Program or selected vault unavailable on Devnet");
  }
  const decoded = decodeOwnedVault(vault, info.data, owner);
  if (!decoded || decoded.paused || decoded.vaultId !== ctx.snapshot.vaultId ||
      decoded.tokenMint !== ctx.snapshot.tokenMint || decoded.treasury !== ctx.snapshot.treasury) {
    throw new Error("Selected vault ownership, metadata or status changed; refresh first");
  }
  return { connection, owner, vault, mint };
}

async function sendAndVerify(args: {
  connection: Connection;
  wallet: SignAndSendWallet;
  owner: PublicKey;
  instruction: TransactionInstruction;
  createdPda: PublicKey;
}): Promise<{ signature: string; account: string }> {
  const { connection, wallet, owner, instruction, createdPda } = args;
  if (!wallet.publicKey?.equals(owner)) throw new Error("Wallet changed before signing");
  const existing = await connection.getAccountInfo(createdPda, "confirmed");
  if (existing) throw new Error("Account already exists; refresh the dashboard");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
  transaction.add(instruction);
  if (!wallet.publicKey?.equals(owner)) throw new Error("Wallet changed before signing");
  const { signature } = await wallet.signAndSendTransaction(transaction);
  try {
    const result = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight }, "confirmed"
    );
    if (result.value.err) throw new Error("Transaction failed on-chain");
  } catch {
    // An expired blockhash or RPC timeout alone is not proof of failure.
    const status = await connection.getSignatureStatuses(
      [signature], { searchTransactionHistory: true }
    ).then((result) => result.value[0]).catch(() => null);
    if (status?.err) {
      throw new Error(`Devnet transaction ${signature} failed on-chain; inspect Explorer`);
    }
    if (status?.confirmationStatus !== "confirmed" &&
        status?.confirmationStatus !== "finalized") {
      throw new Error(
        `Devnet transaction ${signature} is unverified (possibly expired). ` +
        "Check its signature and agent/task PDA before retrying. Never automatically resubmit."
      );
    }
  }
  const account = await connection.getAccountInfo(createdPda, "confirmed");
  if (!account || account.executable || !account.owner.equals(DEFAULT_PROGRAM_ID)) {
    throw new Error("Transaction confirmed but account verification failed; refresh and inspect the signature");
  }
  return { signature, account: createdPda.toBase58() };
}

export async function registerOwnerAgent(args: OwnerWriteContext & { authority: string }) {
  const authority = canonical(args.authority);
  if (!PublicKey.isOnCurve(authority.toBytes())) {
    throw new Error("Agent authority must be a signing-wallet public key, not a PDA");
  }
  const { connection, owner, vault } = await preflight(args);
  const { agent, instruction } = buildRegisterAgentInstruction({ owner, vault, authority });
  return sendAndVerify({ connection, wallet: args.wallet, owner, instruction, createdPda: agent });
}

export async function createOwnerTask(args: OwnerWriteContext & {
  agent: SelectedAgentSnapshot;
  recipient: string;
  taskId: string;
  budget: string;
  expiresInHours: string;
}) {
  const { connection, owner, vault, mint } = await preflight(args);
  const agentAuthority = canonical(args.agent.authority);
  const agent = canonical(args.agent.agentPda);
  if (!args.agent.active || !deriveAgentPda(vault, agentAuthority).equals(agent)) {
    throw new Error("Selected agent is inactive or belongs to another vault");
  }
  const agentInfo = await connection.getAccountInfo(agent, "confirmed");
  if (!agentInfo || agentInfo.executable || !agentInfo.owner.equals(DEFAULT_PROGRAM_ID)) {
    throw new Error("Selected agent missing from Devnet; refresh first");
  }
  const budget = parseTokenAmount(args.budget, args.snapshot.decimals);
  const available = BigInt(args.snapshot.availableBaseUnits);
  if (available < budget) throw new Error("Budget exceeds currently available treasury funds");
  const taskId = parseU64Id(args.taskId);
  const recipient = canonical(args.recipient);
  const expiresAt = parseExpiryHours(args.expiresInHours);
  const { task, instruction } = buildCreateTaskInstruction({
    owner, vault, agent, mint, recipient, taskId, budget, expiresAt,
  });
  return sendAndVerify({ connection, wallet: args.wallet, owner, instruction, createdPda: task });
}
