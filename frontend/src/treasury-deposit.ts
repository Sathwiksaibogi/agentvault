/**
 * Devnet-only SPL Token (legacy Token Program) deposits.
 *
 * A deposit is an ordinary Token Program TransferChecked from the authenticated
 * owner's associated token account into the verified vault ATA. The AgentVault
 * on-chain program and its payment execution paths are not called or changed.
 */
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  type AccountInfo,
} from "@solana/web3.js";
import {
  DEFAULT_PROGRAM_ID,
  DEVNET_RPC_URL,
  TOKEN_PROGRAM_ID,
  decodeOwnedVault,
  deriveTreasury,
  encodeU64LE,
  isInitializedLegacyMint,
} from "./onboarding";
import {
  buildOwnerPolicyTransaction,
  parseTokenAmount,
  signAndBroadcastThroughDevnet,
  type OwnerManagementWallet,
  type SelectedVaultSnapshot,
} from "./owner-management";

const TOKEN_ACCOUNT_SIZE = 165;

function canonical(value: string): PublicKey {
  const key = new PublicKey(value);
  if (key.toBase58() !== value)
    throw new Error("Invalid Solana account address");
  return key;
}

function decodeTokenAccount(
  account: AccountInfo<Buffer> | null,
  mint: PublicKey,
  authority: PublicKey,
  label: string
): bigint {
  if (
    !account ||
    !account.owner.equals(TOKEN_PROGRAM_ID) ||
    account.data.length !== TOKEN_ACCOUNT_SIZE ||
    !new PublicKey(account.data.subarray(0, 32)).equals(mint) ||
    !new PublicKey(account.data.subarray(32, 64)).equals(authority) ||
    account.data[108] !== 1 // initialized, not frozen/uninitialized
  ) {
    throw new Error(
      `${label} is missing, frozen, or does not match the expected mint and authority`
    );
  }
  const view = new DataView(
    account.data.buffer,
    account.data.byteOffset,
    account.data.byteLength
  );
  return view.getBigUint64(64, true);
}

export type DepositWallet = OwnerManagementWallet;
export type DepositContext = {
  wallet: DepositWallet;
  snapshot: SelectedVaultSnapshot;
  sessionOwner: string;
  connection?: Connection;
};

export type FundingDetails = {
  source: string;
  treasury: string;
  balanceBaseUnits: bigint;
  decimals: number;
};

/** Re-read exact vault, mint, source ATA and destination ATA before prompting Phantom. */
export async function inspectDeposit(
  ctx: DepositContext
): Promise<FundingDetails> {
  if (ctx.snapshot.network !== "devnet")
    throw new Error("Deposits are available on Devnet only");
  const owner = canonical(ctx.snapshot.owner);
  const vault = canonical(ctx.snapshot.vault);
  const mint = canonical(ctx.snapshot.tokenMint);
  const treasury = canonical(ctx.snapshot.treasury);
  if (
    ctx.sessionOwner !== owner.toBase58() ||
    !ctx.wallet.publicKey?.equals(owner)
  ) {
    throw new Error(
      "Connected Phantom wallet must match the authenticated vault owner"
    );
  }
  if (!deriveTreasury(vault, mint).equals(treasury)) {
    throw new Error(
      "The provided treasury is not the selected vault's legacy token ATA"
    );
  }

  const connection =
    ctx.connection ?? new Connection(DEVNET_RPC_URL, "confirmed");
  const source = deriveTreasury(owner, mint); // Standard owner associated token account.
  const [programInfo, vaultInfo, mintInfo, sourceInfo, treasuryInfo] =
    await Promise.all([
      connection.getAccountInfo(DEFAULT_PROGRAM_ID, "confirmed"),
      connection.getAccountInfo(vault, "confirmed"),
      connection.getAccountInfo(mint, "confirmed"),
      connection.getAccountInfo(source, "confirmed"),
      connection.getAccountInfo(treasury, "confirmed"),
    ]);
  if (
    !programInfo?.executable ||
    !vaultInfo?.owner.equals(DEFAULT_PROGRAM_ID)
  ) {
    throw new Error(
      "AgentVault program or selected vault is unavailable on Devnet"
    );
  }
  const decoded = decodeOwnedVault(vault, vaultInfo.data, owner);
  if (
    !decoded ||
    decoded.vaultId !== ctx.snapshot.vaultId ||
    decoded.tokenMint !== ctx.snapshot.tokenMint ||
    decoded.treasury !== ctx.snapshot.treasury ||
    decoded.paused !== ctx.snapshot.paused
  ) {
    throw new Error(
      "On-chain vault metadata changed; refresh your dashboard before depositing"
    );
  }
  if (
    !mintInfo ||
    !isInitializedLegacyMint(mintInfo) ||
    mintInfo.data[44] !== ctx.snapshot.decimals
  ) {
    throw new Error(
      "Selected mint is not a valid legacy Devnet SPL mint or decimals changed"
    );
  }
  decodeTokenAccount(treasuryInfo, mint, vault, "Vault destination treasury");
  if (!sourceInfo) {
    throw new Error(
      "Your wallet has no associated token account for this mint. Create and fund its token account before depositing."
    );
  }
  const balanceBaseUnits = decodeTokenAccount(
    sourceInfo,
    mint,
    owner,
    "Wallet source token account"
  );
  return {
    source: source.toBase58(),
    treasury: treasury.toBase58(),
    balanceBaseUnits,
    decimals: mintInfo.data[44],
  };
}

/** SPL Token Program TransferChecked = 12, amount(u64 LE), decimals(u8). */
export function buildDepositInstruction(args: {
  source: PublicKey;
  mint: PublicKey;
  treasury: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
}): TransactionInstruction {
  const { source, mint, treasury, owner, amount, decimals } = args;
  if (amount <= 0n || amount > (1n << 64n) - 1n)
    throw new Error("Deposit amount outside u64 range");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Unsupported token decimal precision");
  }
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([12, ...encodeU64LE(amount), decimals]),
  });
}

export async function depositToTreasury(
  ctx: DepositContext & { amount: string }
): Promise<{ signature: string; amountBaseUnits: bigint }> {
  const details = await inspectDeposit(ctx);
  const owner = canonical(ctx.snapshot.owner);
  const amountBaseUnits = parseTokenAmount(ctx.amount, details.decimals);
  if (amountBaseUnits > details.balanceBaseUnits) {
    throw new Error("Insufficient wallet token balance for this deposit");
  }
  const connection =
    ctx.connection ?? new Connection(DEVNET_RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const instruction = buildDepositInstruction({
    source: canonical(details.source),
    mint: canonical(ctx.snapshot.tokenMint),
    treasury: canonical(details.treasury),
    owner,
    amount: amountBaseUnits,
    decimals: details.decimals,
  });
  const transaction = buildOwnerPolicyTransaction(
    owner,
    blockhash,
    instruction
  );
  if (!ctx.wallet.publicKey?.equals(owner))
    throw new Error("Wallet changed before signing");
  // Uses the project's existing message-integrity guard and explicit Devnet RPC broadcaster.
  const signature = await signAndBroadcastThroughDevnet(
    connection,
    ctx.wallet,
    transaction
  );
  try {
    const confirmed = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    if (confirmed.value.err) throw new Error("Transfer failed on-chain");
  } catch {
    // A timeout is not proof of failure. Never resubmit automatically.
    const status = await connection
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .then((result) => result.value[0])
      .catch(() => null);
    if (status?.err) {
      throw new Error(
        `Deposit transaction ${signature} failed on-chain; inspect Explorer`
      );
    }
    if (
      status?.confirmationStatus !== "confirmed" &&
      status?.confirmationStatus !== "finalized"
    ) {
      throw new Error(
        `Deposit transaction ${signature} has an uncertain outcome. Check Explorer before attempting another deposit; do not retry blindly.`
      );
    }
  }
  return { signature, amountBaseUnits };
}

/** Exact base-unit amount formatter for display; no floating point involved. */
export function formatDepositAmount(base: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error("Invalid decimals");
  const factor = 10n ** BigInt(decimals);
  const fraction = (base % factor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${base / factor}.${fraction}` : String(base / factor);
}
