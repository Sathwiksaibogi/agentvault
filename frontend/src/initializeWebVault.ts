import { Buffer } from "buffer";
import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/**
 * Demo-only Phantom-owned vault initialization.
 * Never loads local CLI wallets, keypair JSON files, or backend credentials.
 */
const PROGRAM_ID = new PublicKey(
  "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d"
);
const DEVNET_TEST_MINT = new PublicKey(
  "Dm75S15mto6y3vNeXZ8FENayPCiSev7PqJBmSfZkQW38"
);
const WEB_VAULT_ID = 8001n;

// Anchor's standard SHA-256-derived instruction discriminators:
// sha256("global:initialize_vault").slice(0, 8)
const INITIALIZE_VAULT = Uint8Array.from([48, 191, 163, 44, 71, 129, 63, 164]);
// sha256("global:initialize_treasury").slice(0, 8)
const INITIALIZE_TREASURY = Uint8Array.from([
  124, 186, 211, 195, 85, 165, 129, 166,
]);
// sha256("account:Vault").slice(0, 8)
const VAULT_ACCOUNT = Uint8Array.from([211, 8, 232, 43, 2, 152, 117, 119]);

export type WalletTransactionSigner = {
  publicKey: PublicKey | null;
  signTransaction(transaction: Transaction): Promise<Transaction>;
};

export type WebVaultSetup = {
  owner: string;
  vault: string;
  treasury: string;
  mint: string;
  vaultId: string;
  createdVault: boolean;
  createdTreasury: boolean;
  signatures: string[];
};

function encodeU64LE(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function assertExistingVaultMatches(
  data: Uint8Array,
  owner: PublicKey,
  mint: PublicKey,
  vaultId: bigint
): void {
  // Vault: 8-byte discriminator, owner Pubkey, mint Pubkey,
  // vault_id u64, total_reserved u64, paused bool, bump u8.
  if (data.length < 90) {
    throw new Error("Existing vault account is too short");
  }
  if (!VAULT_ACCOUNT.every((b, index) => data[index] === b)) {
    throw new Error("Existing PDA is not a Vault account");
  }
  const actualOwner = new PublicKey(data.subarray(8, 40));
  const actualMint = new PublicKey(data.subarray(40, 72));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const actualVaultId = view.getBigUint64(72, true);
  if (
    !actualOwner.equals(owner) ||
    !actualMint.equals(mint) ||
    actualVaultId !== vaultId
  ) {
    throw new Error("Existing vault does not match selected owner, mint or ID");
  }
}

async function sendSignedInstruction(
  connection: Connection,
  wallet: WalletTransactionSigner,
  instruction: TransactionInstruction
): Promise<string> {
  const owner = wallet.publicKey;
  if (!owner) throw new Error("Connect Phantom before signing");

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
  tx.add(instruction);

  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
  });
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (confirmation.value.err) {
    throw new Error(
      `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
    );
  }
  return signature;
}

/**
 * Only constructs and submits initialize_vault + initialize_treasury.
 * It does not mint tokens, deposit funds, register agents or execute payments.
 */
export async function initializeWebVault(
  wallet: WalletTransactionSigner
): Promise<WebVaultSetup> {
  const owner = wallet.publicKey;
  if (!owner) throw new Error("Connect Phantom first");
  if (typeof wallet.signTransaction !== "function") {
    throw new Error("Phantom signTransaction is unavailable");
  }

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const programInfo = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
  if (!programInfo?.executable) {
    throw new Error("AgentVault program was not found on Devnet");
  }
  // Our current AgentVault uses the original SPL Token Program, not Token-2022.
  await getMint(connection, DEVNET_TEST_MINT, "confirmed", TOKEN_PROGRAM_ID);

  const [vault] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("vault"),
      owner.toBytes(),
      encodeU64LE(WEB_VAULT_ID),
    ],
    PROGRAM_ID
  );
  const treasury = getAssociatedTokenAddressSync(
    DEVNET_TEST_MINT,
    vault,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const signatures: string[] = [];
  let createdVault = false;
  let createdTreasury = false;

  const existingVault = await connection.getAccountInfo(vault, "confirmed");
  if (existingVault) {
    if (!existingVault.owner.equals(PROGRAM_ID)) {
      throw new Error("Existing vault PDA has an unexpected program owner");
    }
    assertExistingVaultMatches(
      existingVault.data,
      owner,
      DEVNET_TEST_MINT,
      WEB_VAULT_ID
    );
  } else {
    const balance = await connection.getBalance(owner, "confirmed");
    if (balance < 0.02 * LAMPORTS_PER_SOL) {
      throw new Error(
        "Phantom needs Devnet SOL for account rent and transaction fees"
      );
    }
    const data = new Uint8Array(16);
    data.set(INITIALIZE_VAULT, 0);
    data.set(encodeU64LE(WEB_VAULT_ID), 8);
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: DEVNET_TEST_MINT, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(data),
    });
    signatures.push(
      await sendSignedInstruction(connection, wallet, instruction)
    );
    createdVault = true;
  }

  const existingTreasury = await connection.getAccountInfo(
    treasury,
    "confirmed"
  );
  if (existingTreasury) {
    const account = await getAccount(
      connection,
      treasury,
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    if (
      !account.owner.equals(vault) ||
      !account.mint.equals(DEVNET_TEST_MINT)
    ) {
      throw new Error("Existing treasury has an unexpected owner or mint");
    }
  } else {
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: DEVNET_TEST_MINT, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        {
          pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(INITIALIZE_TREASURY),
    });
    signatures.push(
      await sendSignedInstruction(connection, wallet, instruction)
    );
    createdTreasury = true;
  }

  // Verify both accounts after signing, rather than trusting transaction submission alone.
  const accountInfo = await connection.getAccountInfo(vault, "confirmed");
  if (!accountInfo || !accountInfo.owner.equals(PROGRAM_ID)) {
    throw new Error("Vault creation was not confirmed on-chain");
  }
  assertExistingVaultMatches(
    accountInfo.data,
    owner,
    DEVNET_TEST_MINT,
    WEB_VAULT_ID
  );
  const treasuryInfo = await getAccount(
    connection,
    treasury,
    "confirmed",
    TOKEN_PROGRAM_ID
  );
  if (
    !treasuryInfo.owner.equals(vault) ||
    !treasuryInfo.mint.equals(DEVNET_TEST_MINT)
  ) {
    throw new Error("Treasury verification failed");
  }

  return {
    owner: owner.toBase58(),
    vault: vault.toBase58(),
    treasury: treasury.toBase58(),
    mint: DEVNET_TEST_MINT.toBase58(),
    vaultId: WEB_VAULT_ID.toString(),
    createdVault,
    createdTreasury,
    signatures,
  };
}
