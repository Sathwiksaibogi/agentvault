import { Buffer } from "buffer";
import {
  clusterApiUrl,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { WalletTransactionSigner } from "./initializeWebVault";

// Demo-specific settings: only the already-verified Phantom-owned Devnet vault.
const PROGRAM_ID = new PublicKey(
  "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d"
);
const TOKEN_MINT = new PublicKey(
  "Dm75S15mto6y3vNeXZ8FENayPCiSev7PqJBmSfZkQW38"
);
const PHANTOM_OWNER = new PublicKey(
  "CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc"
);
const EXPECTED_VAULT = new PublicKey(
  "C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep"
);
const EXPECTED_TREASURY = new PublicKey(
  "8yX2mqJcx5ECA2r4gDNkEvTUvAZp6VZvj1rs8t8X1jyp"
);
const EXPECTED_SOURCE = new PublicKey(
  "2T1Qvi9K4NMRGM7YGYYtLDh52VptWAXyKNdJLUvCu8hN"
);
const VAULT_ID = BigInt(8001);
const DEPOSIT_AMOUNT = BigInt(400_000); // 0.4 test tokens (6 decimals)

// sha256("global:deposit_tokens").slice(0, 8)
const DEPOSIT_TOKENS_DISCRIMINATOR = Uint8Array.from([
  176, 83, 229, 18, 191, 143, 176, 150,
]);
// sha256("account:Vault").slice(0, 8)
const VAULT_DISCRIMINATOR = Uint8Array.from([
  211, 8, 232, 43, 2, 152, 117, 119,
]);

export type WebVaultDepositResult = {
  signature: string;
  vault: string;
  treasury: string;
  source: string;
  depositedBaseUnits: string;
  treasuryBalanceBaseUnits: string;
  sourceBalanceBaseUnits: string;
};

function encodeU64LE(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

/** Deposits exactly 400,000 test-token base units once into Vault 8001. */
export async function depositWebVault(
  wallet: WalletTransactionSigner
): Promise<WebVaultDepositResult> {
  const owner = wallet.publicKey;
  if (!owner || !owner.equals(PHANTOM_OWNER)) {
    throw new Error(
      "Connect the expected Phantom owner wallet before depositing"
    );
  }
  if (typeof wallet.signTransaction !== "function") {
    throw new Error("Phantom transaction signing is unavailable");
  }

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const [vault] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("vault"), owner.toBytes(), encodeU64LE(VAULT_ID)],
    PROGRAM_ID
  );
  const treasury = getAssociatedTokenAddressSync(TOKEN_MINT, vault, true);
  const source = getAssociatedTokenAddressSync(TOKEN_MINT, owner);
  if (!vault.equals(EXPECTED_VAULT) || !treasury.equals(EXPECTED_TREASURY)) {
    throw new Error("Unexpected derived web vault or treasury address");
  }
  if (!source.equals(EXPECTED_SOURCE)) {
    throw new Error("Unexpected Phantom source token account");
  }

  // Verify vault state itself, not just the PDA's program owner.
  const info = await connection.getAccountInfo(vault, "confirmed");
  if (!info?.owner.equals(PROGRAM_ID) || info.data.length < 90) {
    throw new Error("Expected AgentVault Vault account not found");
  }
  const data = info.data;
  if (!VAULT_DISCRIMINATOR.every((byte, index) => data[index] === byte)) {
    throw new Error("Vault discriminator does not match");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (
    !new PublicKey(data.subarray(8, 40)).equals(owner) ||
    !new PublicKey(data.subarray(40, 72)).equals(TOKEN_MINT) ||
    view.getBigUint64(72, true) !== VAULT_ID ||
    data[88] !== 0
  ) {
    throw new Error("Vault owner, mint, ID or active state does not match");
  }

  const mint = await getMint(
    connection,
    TOKEN_MINT,
    "confirmed",
    TOKEN_PROGRAM_ID
  );
  if (mint.decimals !== 6) {
    throw new Error("Unexpected test token decimals");
  }

  const sourceBefore = await getAccount(
    connection,
    source,
    "confirmed",
    TOKEN_PROGRAM_ID
  );
  const treasuryBefore = await getAccount(
    connection,
    treasury,
    "confirmed",
    TOKEN_PROGRAM_ID
  );
  if (
    !sourceBefore.owner.equals(owner) ||
    !sourceBefore.mint.equals(TOKEN_MINT)
  ) {
    throw new Error("Source token authority or mint does not match Phantom");
  }
  if (
    !treasuryBefore.owner.equals(vault) ||
    !treasuryBefore.mint.equals(TOKEN_MINT)
  ) {
    throw new Error("Treasury token authority or mint is incorrect");
  }
  if (treasuryBefore.amount !== BigInt(0)) {
    throw new Error(
      `Treasury already contains ${treasuryBefore.amount} base units. ` +
        "Inspect both accounts before trying another deposit."
    );
  }
  if (sourceBefore.amount < DEPOSIT_AMOUNT) {
    throw new Error("Phantom source account has insufficient test tokens");
  }

  // Rust DepositTokens accounts order:
  // owner, vault, token_mint, owner_token_account, treasury, token_program.
  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: TOKEN_MINT, isSigner: false, isWritable: false },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([
      ...DEPOSIT_TOKENS_DISCRIMINATOR,
      ...encodeU64LE(DEPOSIT_AMOUNT),
    ]),
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
  tx.add(instruction);
  const signed = await wallet.signTransaction(tx);

  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
  });
  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    if (confirmation.value.err) {
      throw new Error(JSON.stringify(confirmation.value.err));
    }
  } catch (cause) {
    throw new Error(
      `Transaction ${signature} was submitted, but confirmation was not verified. ` +
        "Check Explorer and both balances before retrying.",
      { cause }
    );
  }

  const sourceAfter = await getAccount(
    connection,
    source,
    "confirmed",
    TOKEN_PROGRAM_ID
  );
  const treasuryAfter = await getAccount(
    connection,
    treasury,
    "confirmed",
    TOKEN_PROGRAM_ID
  );
  if (
    treasuryAfter.amount !== treasuryBefore.amount + DEPOSIT_AMOUNT ||
    sourceAfter.amount !== sourceBefore.amount - DEPOSIT_AMOUNT
  ) {
    throw new Error(
      `Transaction ${signature} confirmed, but the account balances differ ` +
        "from this deposit's expected changes. Recheck on-chain state."
    );
  }

  return {
    signature,
    vault: vault.toBase58(),
    treasury: treasury.toBase58(),
    source: source.toBase58(),
    depositedBaseUnits: DEPOSIT_AMOUNT.toString(),
    treasuryBalanceBaseUnits: treasuryAfter.amount.toString(),
    sourceBalanceBaseUnits: sourceAfter.amount.toString(),
  };
}
