import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";

/** Network fingerprints must be reviewed if Devnet is reset. */
export const KNOWN_DEVNET_GENESIS_HASHES = [
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC",
] as const;
const U64_MAX = BigInt("18446744073709551615");
const UPGRADEABLE_LOADER = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

export type ModelBDevnetState = {
  genesisHash: string;
  programId: string;
  owner: string;
  vaultId: string;
  mint: string;
  vault: string;
  treasury: string;
};

export type ModelBDevnetPreflightRpc = Pick<
  Connection,
  "getGenesisHash" | "getAccountInfo"
>;

export type ModelBDevnetTreasury = {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
};

export type ModelBDevnetPreflightReport = {
  network: "devnet";
  genesisHash: string;
  programId: string;
  vault: string;
  treasury: string;
  mint: string;
  treasuryBalanceBaseUnits: string;
};

function parseKey(value: unknown, field: string): PublicKey {
  assert.ok(typeof value === "string" && value.length > 0, `Invalid ${field}`);
  return new PublicKey(value);
}

/** Pure checks + PUBLIC, read-only RPC calls. Never reads private keys. */
export async function inspectModelBDevnetPreflight(
  network: string,
  state: ModelBDevnetState,
  rpc: ModelBDevnetPreflightRpc,
  readTreasury: () => Promise<ModelBDevnetTreasury>
): Promise<ModelBDevnetPreflightReport> {
  assert.equal(network, "devnet", "Devnet preflight is Devnet-only");
  assert.equal(
    state.programId,
    AGENTVAULT_PROGRAM_ID.toBase58(),
    "Configured AgentVault program ID mismatch"
  );

  const owner = parseKey(state.owner, "owner");
  const mint = parseKey(state.mint, "mint");
  const vault = parseKey(state.vault, "vault");
  const treasury = parseKey(state.treasury, "treasury");

  assert.match(state.vaultId, /^(0|[1-9][0-9]*)$/, "Invalid vaultId");
  const id = BigInt(state.vaultId);
  assert.ok(id <= U64_MAX, "vaultId exceeds u64");
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(id);

  const [expectedVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), idBytes],
    AGENTVAULT_PROGRAM_ID
  );
  assert.ok(vault.equals(expectedVault), "Configured Vault PDA mismatch");

  const expectedTreasury = getAssociatedTokenAddressSync(
    mint,
    vault,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  assert.ok(
    treasury.equals(expectedTreasury),
    "Configured treasury ATA mismatch"
  );

  const genesis = await rpc.getGenesisHash();
  assert.ok(
    KNOWN_DEVNET_GENESIS_HASHES.some((value) => value === genesis),
    "RPC genesis is not a reviewed Devnet fingerprint; stop and review the network"
  );
  assert.equal(
    genesis,
    state.genesisHash,
    "Devnet RPC genesis differs from saved state"
  );

  const [programInfo, vaultInfo] = await Promise.all([
    rpc.getAccountInfo(AGENTVAULT_PROGRAM_ID, "confirmed"),
    rpc.getAccountInfo(vault, "confirmed"),
  ]);
  assert.ok(programInfo, "AgentVault program is not deployed on Devnet");
  assert.equal(
    programInfo.executable,
    true,
    "Deployed program is not executable"
  );
  assert.ok(
    programInfo.owner.equals(UPGRADEABLE_LOADER),
    "Program is not controlled by the expected upgradeable loader"
  );
  assert.ok(vaultInfo, "Configured Vault does not exist on Devnet");
  assert.ok(
    vaultInfo.owner.equals(AGENTVAULT_PROGRAM_ID),
    "Vault belongs to another program"
  );
  assert.ok(
    vaultInfo.data.length >= 8,
    "Vault has no Anchor account discriminator"
  );

  const token = await readTreasury();
  assert.ok(token.mint.equals(mint), "Treasury mint mismatch");
  assert.ok(
    token.owner.equals(vault),
    "Treasury authority is not the Vault PDA"
  );
  assert.ok(
    token.amount > BigInt(0),
    "Treasury is empty; fund only with dedicated test tokens"
  );

  // Protect against a switch of the RPC network during the inspection.
  assert.equal(
    await rpc.getGenesisHash(),
    genesis,
    "RPC ledger switched during preflight"
  );

  return {
    network: "devnet",
    genesisHash: genesis,
    programId: state.programId,
    vault: vault.toBase58(),
    treasury: treasury.toBase58(),
    mint: mint.toBase58(),
    treasuryBalanceBaseUnits: token.amount.toString(),
  };
}

/** CLI deliberately has NO --execute option, signers or write operations. */
async function main(): Promise<void> {
  assert.equal(
    NETWORK,
    "devnet",
    "Set AGENTVAULT_NETWORK=devnet for read-only preflight"
  );
  const path = join(RUNTIME_DIR, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8")) as ModelBDevnetState;
  const rpc = new Connection(RPC_URL, "confirmed");
  const report = await inspectModelBDevnetPreflight(
    NETWORK,
    state,
    rpc,
    async () => {
      const account = await getAccount(
        rpc,
        new PublicKey(state.treasury),
        "confirmed",
        TOKEN_PROGRAM_ID
      );
      return {
        mint: account.mint,
        owner: account.owner,
        amount: account.amount,
      };
    }
  );

  console.log("\n=== AGENTVAULT MODEL B DEVNET PREFLIGHT ===");
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "\nREAD ONLY: no signing, journal claim, transaction simulation, or broadcast."
  );
  console.log(
    "This is NOT a full readiness or security audit; verify the task and signed approvals separately."
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      "MODEL B DEVNET PREFLIGHT STOPPED:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  });
}
