/**
 * Read-only, on-chain verification for a *selected* AgentVault owner/vault pair.
 *
 * This is the prerequisite for wallet-bound multi-vault dashboard sessions.
 * Never treat a browser-supplied vault address or a frontend discovery result as
 * sufficient authorization. The caller must separately validate the wallet
 * signature, session origin, expiry, chain genesis and requested route scope.
 *
 * Uses the existing legacy SPL Token program and AgentVault Vault account
 * layout; no signing or payment submission occurs here.
 */
import { createHash } from "node:crypto";
import { PublicKey, type AccountInfo } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const VAULT_DISCRIMINATOR = createHash("sha256")
  .update("account:Vault")
  .digest()
  .subarray(0, 8);

export interface ConfirmedAccountReader {
  getAccountInfo(address: PublicKey, commitment: "confirmed"):
    Promise<AccountInfo<Buffer> | null>;
}

export interface VerifiedOwnerVault {
  owner: string;
  vault: string;
  vaultId: string;
  mint: string;
  treasury: string;
  paused: boolean;
  totalReservedBaseUnits: string;
  treasuryBalanceBaseUnits: string;
}

function canonicalKey(value: string): PublicKey {
  const key = new PublicKey(value);
  if (key.toBase58() !== value) throw new Error("Invalid public key");
  return key;
}

function u64LittleEndian(value: bigint): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(value, 0);
  return result;
}

function fail(): never {
  throw new Error("Selected vault is not a verified owner-controlled AgentVault treasury");
}

/**
 * Checks BOTH the Anchor vault and its canonical SPL-token treasury at a
 * confirmed RPC commitment. Only an exact account match succeeds.
 *
 * RPC's network/genesis must be pinned by the caller before using this as a
 * login/session authorization predicate.
 */
export async function verifyOwnerVaultOnChain(args: {
  rpc: ConfirmedAccountReader;
  ownerAddress: string;
  vaultAddress: string;
}): Promise<VerifiedOwnerVault> {
  const { rpc } = args;
  const owner = canonicalKey(args.ownerAddress);
  const vault = canonicalKey(args.vaultAddress);
  const programId = PROGRAM_ID;
  const vaultInfo = await rpc.getAccountInfo(vault, "confirmed");

  if (
    !vaultInfo ||
    vaultInfo.executable ||
    !vaultInfo.owner.equals(programId) ||
    vaultInfo.data.length !== 90 ||
    !vaultInfo.data.subarray(0, 8).equals(VAULT_DISCRIMINATOR) ||
    !new PublicKey(vaultInfo.data.subarray(8, 40)).equals(owner) ||
    vaultInfo.data[88] > 1
  ) fail();

  const mint = new PublicKey(vaultInfo.data.subarray(40, 72));
  const vaultId = vaultInfo.data.readBigUInt64LE(72);
  const reserved = vaultInfo.data.readBigUInt64LE(80);
  const [canonicalVault, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), u64LittleEndian(vaultId)],
    programId
  );
  if (!canonicalVault.equals(vault) || vaultInfo.data[89] !== bump) fail();

  const [treasury] = PublicKey.findProgramAddressSync(
    [vault.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const treasuryInfo = await rpc.getAccountInfo(treasury, "confirmed");
  if (
    !treasuryInfo ||
    treasuryInfo.executable ||
    !treasuryInfo.owner.equals(TOKEN_PROGRAM_ID) ||
    treasuryInfo.data.length !== 165 ||
    !new PublicKey(treasuryInfo.data.subarray(0, 32)).equals(mint) ||
    !new PublicKey(treasuryInfo.data.subarray(32, 64)).equals(vault) ||
    (treasuryInfo.data[108] !== 1 && treasuryInfo.data[108] !== 2)
  ) fail();

  const treasuryBalance = treasuryInfo.data.readBigUInt64LE(64);
  if (reserved > treasuryBalance) fail();

  return {
    owner: owner.toBase58(),
    vault: vault.toBase58(),
    vaultId: vaultId.toString(),
    mint: mint.toBase58(),
    treasury: treasury.toBase58(),
    paused: vaultInfo.data[88] === 1,
    totalReservedBaseUnits: reserved.toString(),
    treasuryBalanceBaseUnits: treasuryBalance.toString(),
  };
}
