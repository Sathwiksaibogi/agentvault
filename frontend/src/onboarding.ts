/**
 * Devnet-only, wallet-signed AgentVault onboarding.
 * All reads here are from Solana RPC. This module does NOT create a dashboard
 * session or grant access to the legacy single-vault backend.
 */
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountInfo,
} from "@solana/web3.js";

export const DEFAULT_PROGRAM_ID = new PublicKey(
  "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d"
);
export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

const INIT_VAULT_DISCRIMINATOR = Uint8Array.from([
  48, 191, 163, 44, 71, 129, 63, 164,
]);
const INIT_TREASURY_DISCRIMINATOR = Uint8Array.from([
  124, 186, 211, 195, 85, 165, 129, 166,
]);
const VAULT_ACCOUNT_DISCRIMINATOR = Uint8Array.from([
  211, 8, 232, 43, 2, 152, 117, 119,
]);
const MAX_U64 = (1n << 64n) - 1n;
const MIN_VAULT_ACCOUNT_LEN = 90;

export type OwnedVault = {
  address: string;
  vaultId: string;
  owner: string;
  tokenMint: string;
  treasury: string;
  totalReservedBaseUnits: string;
  paused: boolean;
};

export type SignAndSendWallet = {
  publicKey?: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  signAndSendTransaction(transaction: Transaction): Promise<{ signature: string }>;
};

export function encodeU64LE(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_U64) {
    throw new RangeError("vault_id must be a valid unsigned 64-bit integer");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function deriveVault(
  owner: PublicKey,
  vaultId: bigint,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("vault"), owner.toBytes(), encodeU64LE(vaultId)],
    programId
  );
}

/** Matches the Token Program ATA seeds in initialize_treasury's IDL. */
export function deriveTreasury(vault: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [vault.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

export function buildVaultCreationInstructions(args: {
  owner: PublicKey;
  mint: PublicKey;
  vaultId: bigint;
  programId?: PublicKey;
}): {
  vault: PublicKey;
  treasury: PublicKey;
  instructions: [TransactionInstruction, TransactionInstruction];
} {
  const { owner, mint, vaultId } = args;
  const programId = args.programId ?? DEFAULT_PROGRAM_ID;
  const [vault] = deriveVault(owner, vaultId, programId);
  const treasury = deriveTreasury(vault, mint);

  const initializeVault = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([...INIT_VAULT_DISCRIMINATOR, ...encodeU64LE(vaultId)]),
  });

  const initializeTreasury = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(INIT_TREASURY_DISCRIMINATOR),
  });

  return { vault, treasury, instructions: [initializeVault, initializeTreasury] };
}

export function decodeOwnedVault(
  address: PublicKey,
  data: Uint8Array,
  expectedOwner: PublicKey,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): OwnedVault | null {
  if (data.length < MIN_VAULT_ACCOUNT_LEN) return null;
  if (!VAULT_ACCOUNT_DISCRIMINATOR.every((byte, i) => data[i] === byte)) {
    return null;
  }

  // Anchor account: discriminator(8), owner(32), mint(32), vault_id(u64),
  // total_reserved(u64), paused(bool), bump(u8).
  const recordedOwner = new PublicKey(data.slice(8, 40));
  if (!recordedOwner.equals(expectedOwner)) return null;
  const mint = new PublicKey(data.slice(40, 72));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const vaultId = view.getBigUint64(72, true);
  const reserved = view.getBigUint64(80, true);
  const [derived, bump] = deriveVault(expectedOwner, vaultId, programId);
  if (!derived.equals(address) || data[89] !== bump || data[88] > 1) return null;

  return {
    address: address.toBase58(),
    vaultId: vaultId.toString(),
    owner: expectedOwner.toBase58(),
    tokenMint: mint.toBase58(),
    treasury: deriveTreasury(address, mint).toBase58(),
    totalReservedBaseUnits: reserved.toString(),
    paused: data[88] === 1,
  };
}

export async function discoverOwnedVaults(
  connection: Connection,
  owner: PublicKey,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): Promise<OwnedVault[]> {
  // The owner field is immediately after the 8-byte Anchor discriminator.
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 8, bytes: owner.toBase58() } }],
    dataSlice: { offset: 0, length: MIN_VAULT_ACCOUNT_LEN },
    commitment: "confirmed",
  });
  return accounts
    .map(({ pubkey, account }) => decodeOwnedVault(pubkey, account.data, owner, programId))
    .filter((vault): vault is OwnedVault => vault !== null)
    .sort((a, b) => {
      const first = BigInt(a.vaultId);
      const second = BigInt(b.vaultId);
      return first < second ? 1 : first > second ? -1 : 0;
    });
}

/** Identifies a legacy SPL Token mint, the only mint type this program accepts. */
export function isInitializedLegacyMint(info: AccountInfo<Buffer> | null): boolean {
  return (
    info !== null &&
    info.owner.equals(TOKEN_PROGRAM_ID) &&
    info.data.length === 82 &&
    info.data[45] === 1
  );
}

function newVaultId(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, true) || 1n;
}

export async function createOwnerVault(args: {
  connection: Connection;
  wallet: SignAndSendWallet;
  owner: PublicKey;
  mint: PublicKey;
  programId?: PublicKey;
}): Promise<{ signature: string; vaultId: string; vault: string; treasury: string }> {
  const { connection, wallet, owner, mint } = args;
  const programId = args.programId ?? DEFAULT_PROGRAM_ID;
  if (!wallet.publicKey?.equals(owner)) {
    throw new Error("Connected wallet changed; reconnect before creating a vault");
  }

  const [programInfo, mintInfo] = await Promise.all([
    connection.getAccountInfo(programId, "confirmed"),
    connection.getAccountInfo(mint, "confirmed"),
  ]);
  if (!programInfo?.executable) {
    throw new Error("AgentVault program is not deployed on the selected Devnet RPC");
  }
  if (!isInitializedLegacyMint(mintInfo)) {
    throw new Error("Token mint must be an initialized legacy SPL Token mint on Devnet");
  }

  // Random u64 vault ID avoids a global off-chain counter and does not collide
  // with a different owner's namespace. Check existence before prompting wallet.
  let creation: ReturnType<typeof buildVaultCreationInstructions> | null = null;
  let vaultId = 0n;
  for (let attempt = 0; attempt < 4; attempt++) {
    vaultId = newVaultId();
    const candidate = buildVaultCreationInstructions({ owner, mint, vaultId, programId });
    if (!(await connection.getAccountInfo(candidate.vault, "confirmed"))) {
      creation = candidate;
      break;
    }
  }
  if (!creation) throw new Error("Could not find an unused vault ID; retry");

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
  transaction.add(...creation.instructions);

  // Phantom signs and broadcasts. No seed phrase or private key enters the app.
  const { signature } = await wallet.signAndSendTransaction(transaction);
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (result.value.err) {
    throw new Error(`Vault creation transaction failed: ${JSON.stringify(result.value.err)}`);
  }

  const info = await connection.getAccountInfo(creation.vault, "confirmed");
  const decoded = info && decodeOwnedVault(creation.vault, info.data, owner, programId);
  if (!decoded || decoded.tokenMint !== mint.toBase58()) {
    throw new Error("Transaction confirmed but vault could not be verified; refresh discovery");
  }
  const treasuryInfo = await connection.getAccountInfo(creation.treasury, "confirmed");
  if (
    !treasuryInfo ||
    !treasuryInfo.owner.equals(TOKEN_PROGRAM_ID) ||
    treasuryInfo.data.length !== 165 ||
    !new PublicKey(treasuryInfo.data.subarray(0, 32)).equals(mint) ||
    !new PublicKey(treasuryInfo.data.subarray(32, 64)).equals(creation.vault)
  ) {
    throw new Error("Vault confirmed but treasury mint/authority could not be verified; refresh discovery");
  }

  return {
    signature,
    vaultId: vaultId.toString(),
    vault: creation.vault.toBase58(),
    treasury: creation.treasury.toBase58(),
  };
}
