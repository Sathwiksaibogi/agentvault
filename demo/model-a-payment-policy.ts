/**
 * Model A inbox policy preflight: Devnet ONLY, never payment authorization.
 *
 * The authenticated vault must come from a trusted API-key principal, never
 * a request body. The selected vault, treasury, agent and task are checked
 * against on-chain data before the intake store is called.
 *
 * A separate execution worker MUST repeat these checks and enforce the
 * signed-transaction journal and on-chain constraints before spending.
 */
import { PublicKey } from "@solana/web3.js";
import {
  validateModelAPaymentIntent,
  type ModelAPaymentIntentInput,
  type TrustedPaymentIntakeScope,
} from "./model-a-payment-intake";
import {
  verifyOwnerVaultOnChain,
  type ConfirmedAccountReader,
  type VerifiedOwnerVault,
} from "./owner-vault-verifier";

const PROGRAM = new PublicKey("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");
const MAX_U64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const MAX_I64 = (BigInt(1) << BigInt(63)) - BigInt(1);
const MIN_I64 = -(BigInt(1) << BigInt(63));

export type ModelAPolicyAccountReader = {
  fetchAgent: (agentPda: PublicKey) => Promise<unknown>;
  fetchTask: (taskPda: PublicKey) => Promise<unknown>;
};

export type DevnetPolicyRpc = ConfirmedAccountReader & {
  getGenesisHash: () => Promise<string>;
};

export type VerifiedModelAPaymentPolicy = {
  request: ModelAPaymentIntentInput;
  vault: VerifiedOwnerVault;
  agentPda: string;
  taskPda: string;
  nextNonce: string;
  remainingBaseUnits: string;
};

function invalid(): never {
  throw new Error(
    "Model A payment request does not match an active on-chain policy"
  );
}

function dataObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  return input as Record<string, unknown>;
}

function key(input: unknown): PublicKey {
  if (!(input instanceof PublicKey)) invalid();
  return input;
}

function canonical(address: string): PublicKey {
  try {
    const value = new PublicKey(address);
    if (value.toBase58() !== address) invalid();
    return value;
  } catch {
    return invalid();
  }
}

function integer(input: unknown, signed = false): bigint {
  let raw: string;
  if (typeof input === "bigint") raw = input.toString();
  else if (typeof input === "number" && Number.isSafeInteger(input))
    raw = String(input);
  else if (
    input &&
    typeof input === "object" &&
    typeof (input as { toString?: unknown }).toString === "function"
  ) {
    raw = (input as { toString: (radix?: number) => string }).toString(10);
  } else invalid();
  if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) invalid();
  const value = BigInt(raw);
  if (
    signed
      ? value < MIN_I64 || value > MAX_I64
      : value < BigInt(0) || value > MAX_U64
  )
    invalid();
  return value;
}

function matchesBump(data: Record<string, unknown>, bump: number): void {
  if (data.bump !== bump) invalid();
}

/** Fail-closed, read-only preflight. Returns NO spending capability. */
export async function verifyModelAPaymentIntentPolicy(args: {
  rpc: DevnetPolicyRpc;
  accounts: ModelAPolicyAccountReader;
  expectedDevnetGenesisHash: string;
  trustedScope: TrustedPaymentIntakeScope;
  input: unknown;
}): Promise<VerifiedModelAPaymentPolicy> {
  const { rpc, accounts, trustedScope } = args;
  if (
    trustedScope.network !== "devnet" ||
    !/^[A-Za-z0-9._:@-]{1,128}$/.test(trustedScope.principalId) ||
    !Number.isSafeInteger(trustedScope.nowUnix) ||
    trustedScope.nowUnix < 0
  )
    invalid();
  const requested = validateModelAPaymentIntent(
    args.input,
    trustedScope.nowUnix
  );
  const vaultPda = canonical(trustedScope.vault);
  const authority = canonical(requested.agentAuthority);
  const recipient = canonical(requested.recipient);
  if (!args.expectedDevnetGenesisHash) invalid();
  if ((await rpc.getGenesisHash()) !== args.expectedDevnetGenesisHash)
    invalid();

  // Derive the on-chain owner from the authenticated vault's account; do not
  // trust an owner field supplied by an HTTP client.
  const rawVault = await rpc.getAccountInfo(vaultPda, "confirmed");
  if (
    !rawVault ||
    !rawVault.owner.equals(PROGRAM) ||
    rawVault.data.length !== 90
  )
    invalid();
  const vaultOwner = new PublicKey(rawVault.data.subarray(8, 40));
  const vault = await verifyOwnerVaultOnChain({
    rpc,
    ownerAddress: vaultOwner.toBase58(),
    vaultAddress: vaultPda.toBase58(),
  });
  if (vault.paused) invalid();

  const [agentPda, agentBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultPda.toBuffer(), authority.toBuffer()],
    PROGRAM
  );
  const agent = dataObject(await accounts.fetchAgent(agentPda));
  if (
    !key(agent.vault).equals(vaultPda) ||
    !key(agent.authority).equals(authority) ||
    agent.active !== true
  )
    invalid();
  matchesBump(agent, agentBump);

  const taskId = BigInt(requested.taskId);
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(taskId, 0);
  const [taskPda, taskBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), agentPda.toBuffer(), idBytes],
    PROGRAM
  );
  const task = dataObject(await accounts.fetchTask(taskPda));
  if (
    !key(task.agent).equals(agentPda) ||
    (task.vault !== undefined && !key(task.vault).equals(vaultPda)) ||
    !key(task.recipient).equals(recipient) ||
    task.active !== true
  )
    invalid();
  matchesBump(task, taskBump);
  if (integer(task.taskId) !== taskId) invalid();

  const budget = integer(task.budget);
  const spent = integer(task.spent);
  const nonce = integer(task.nextNonce);
  const expiry = integer(task.expiresAt, true);
  const amount = BigInt(requested.amountBaseUnits);
  const requestExpiry = BigInt(requested.expiresAtUnix);
  if (
    spent > budget ||
    amount > budget - spent ||
    budget - spent > BigInt(vault.totalReservedBaseUnits) ||
    expiry <= BigInt(trustedScope.nowUnix) ||
    requestExpiry > expiry
  )
    invalid();

  return {
    request: requested,
    vault,
    agentPda: agentPda.toBase58(),
    taskPda: taskPda.toBase58(),
    nextNonce: nonce.toString(),
    remainingBaseUnits: (budget - spent).toString(),
  };
}
