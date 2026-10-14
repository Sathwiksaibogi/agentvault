import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

import type { Agentvault } from "../target/types/agentvault";

// This bootstrap is intentionally restricted to localnet.
const RPC_URL = "http://127.0.0.1:8899";
const VAULT_ID = new BN(7001);
const TREASURY_TARGET = 400_000;
const PROGRAM_ID = "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d";

const STATE_DIR = join(process.cwd(), "demo/local");
const STATE_PATH = join(STATE_DIR, "state.json");

type DemoState = {
  genesisHash: string;
  programId: string;
  owner: string;
  vaultId: string;
  mint: string;
  vault: string;
  treasury: string;
};

async function main() {
  // 1. Configure the standalone Anchor provider.
  process.env.ANCHOR_PROVIDER_URL = RPC_URL;
  process.env.ANCHOR_WALLET ??= join(homedir(), ".config/solana/id.json");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // 2. Load the locally generated Anchor IDL.
  const idlPath = join(process.cwd(), "target/idl/agentvault.json");

  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as Agentvault;

  const program = new anchor.Program<Agentvault>(idl, provider);

  assert.strictEqual(
    program.programId.toBase58(),
    PROGRAM_ID,
    "Unexpected AgentVault program ID"
  );

  // 3. Verify that the program is deployed.
  const programInfo = await connection.getAccountInfo(
    program.programId,
    "processed"
  );

  assert.ok(
    programInfo?.executable,
    "AgentVault is not deployed on this validator"
  );

  const genesisHash = await connection.getGenesisHash();

  console.log("RPC:", RPC_URL);
  console.log("Program:", program.programId.toBase58());
  console.log("Owner:", owner.toBase58());

  // 4. Load or initialize persistent demo state.
  mkdirSync(STATE_DIR, { recursive: true });

  const savedState: DemoState | null = existsSync(STATE_PATH)
    ? (JSON.parse(readFileSync(STATE_PATH, "utf8")) as DemoState)
    : null;

  if (savedState) {
    assert.strictEqual(
      savedState.genesisHash,
      genesisHash,
      "Validator ledger changed. Review saved demo state."
    );

    assert.strictEqual(savedState.owner, owner.toBase58());

    assert.strictEqual(savedState.programId, PROGRAM_ID);

    assert.strictEqual(savedState.vaultId, VAULT_ID.toString());
  }

  // 5. Create a mint only on the first run.
  const mint = savedState
    ? new PublicKey(savedState.mint)
    : await createMint(
        connection,
        payer,
        owner,
        null,
        6,
        undefined,
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      );

  const mintInfo = await connection.getAccountInfo(mint, "processed");

  assert.ok(mintInfo, "Saved mint does not exist. Was the validator reset?");

  // 6. Derive the deterministic Vault PDA.
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      VAULT_ID.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  // 7. Derive the Vault's canonical treasury ATA.
  const treasuryAta = getAssociatedTokenAddressSync(
    mint,
    vaultPda,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Save the mint immediately so reruns reuse it.
  const state: DemoState = {
    genesisHash,
    programId: PROGRAM_ID,
    owner: owner.toBase58(),
    vaultId: VAULT_ID.toString(),
    mint: mint.toBase58(),
    vault: vaultPda.toBase58(),
    treasury: treasuryAta.toBase58(),
  };

  if (savedState) {
    assert.strictEqual(savedState.vault, state.vault);
    assert.strictEqual(savedState.treasury, state.treasury);
  }

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });

  // 8. Initialize the Vault only if it doesn't exist.
  const existingVault = await connection.getAccountInfo(vaultPda, "processed");

  if (!existingVault) {
    const tx = await program.methods
      .initializeVault(VAULT_ID)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint: mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Vault initialized:", tx);
  } else {
    console.log("Vault already exists — reusing.");
  }

  // 9. Verify the on-chain Vault configuration.
  const vault = await program.account.vault.fetch(vaultPda, "processed");

  assert.ok(vault.owner.equals(owner));
  assert.ok(vault.tokenMint.equals(mint));
  assert.ok(vault.vaultId.eq(VAULT_ID));

  // 10. Initialize the treasury only if absent.
  const existingTreasury = await connection.getAccountInfo(
    treasuryAta,
    "processed"
  );

  if (!existingTreasury) {
    const tx = await program.methods
      .initializeTreasury()
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint: mint,
        treasury: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Treasury initialized:", tx);
  } else {
    console.log("Treasury already exists — reusing.");
  }

  // 11. Create/reuse the owner's source token ATA.
  const ownerToken = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner,
    false,
    "confirmed",
    undefined,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // 12. Calculate how much funding is still needed.
  const treasuryBefore = await getAccount(
    connection,
    treasuryAta,
    "processed",
    TOKEN_PROGRAM_ID
  );

  assert.ok(treasuryBefore.owner.equals(vaultPda));
  assert.ok(treasuryBefore.mint.equals(mint));

  const missingAmount = Math.max(
    0,
    TREASURY_TARGET - Number(treasuryBefore.amount)
  );

  if (missingAmount > 0) {
    // Reuse any existing owner token balance first.
    const source = await getAccount(
      connection,
      ownerToken.address,
      "processed",
      TOKEN_PROGRAM_ID
    );

    const amountToMint = Math.max(0, missingAmount - Number(source.amount));

    if (amountToMint > 0) {
      await mintTo(
        connection,
        payer,
        mint,
        ownerToken.address,
        owner,
        amountToMint,
        [],
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      );

      console.log("Tokens minted:", amountToMint);
    }

    // 13. Fund the treasury through AgentVault.
    const tx = await program.methods
      .depositTokens(new BN(missingAmount))
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint: mint,
        ownerTokenAccount: ownerToken.address,
        treasury: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Treasury deposit:", tx);
  } else {
    console.log("Treasury already sufficiently funded.");
  }

  // 14. Verify the final on-chain balances.
  const finalTreasury = await getAccount(
    connection,
    treasuryAta,
    "processed",
    TOKEN_PROGRAM_ID
  );

  const finalVault = await program.account.vault.fetch(vaultPda, "processed");

  assert.ok(Number(finalTreasury.amount) >= TREASURY_TARGET);

  assert.ok(finalVault.totalReserved.eq(new BN(0)));
  assert.strictEqual(finalVault.paused, false);

  console.log("\n=== AGENTVAULT BOOTSTRAP COMPLETE ===");
  console.log("Mint:", mint.toBase58());
  console.log("Vault:", vaultPda.toBase58());
  console.log("Treasury:", treasuryAta.toBase58());
  console.log("Treasury balance:", finalTreasury.amount.toString());
  console.log("Reserved:", finalVault.totalReserved.toString());
  console.log("State file:", STATE_PATH);
}

main().catch((error) => {
  console.error("Bootstrap failed:", error);
  process.exitCode = 1;
});
