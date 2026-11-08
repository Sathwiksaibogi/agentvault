import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { strict as assert } from "assert";

import type { Agentvault } from "../target/types/agentvault";

describe("AgentVault - Vault Pause Security", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Separate vault from the existing sequential integration suite.
  const vaultId = new BN("610001");

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  let tokenMint: PublicKey;

  before(async () => {
    tokenMint = await createMint(
      provider.connection,
      payer,
      owner,
      null,
      6,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    await program.methods
      .initializeVault(vaultId)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("allows the owner to pause and unpause the vault", async () => {
    await program.methods
      .setVaultPaused(true)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc();

    let vault = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(vault.paused, true);

    await program.methods
      .setVaultPaused(false)
      .accountsPartial({ owner, vault: vaultPda })
      .rpc();

    vault = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(vault.paused, false);
  });

  it("rejects pause attempts by a non-owner", async () => {
    const attacker = Keypair.generate();

    const airdrop = await provider.connection.requestAirdrop(
      attacker.publicKey,
      LAMPORTS_PER_SOL
    );

    await provider.connection.confirmTransaction(
      airdrop,
      "confirmed"
    );

    await assert.rejects(async () => {
      await program.methods
        .setVaultPaused(true)
        .accountsPartial({
          owner: attacker.publicKey,
          vault: vaultPda,
        })
        .signers([attacker])
        .rpc();
    });

    const vault = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(vault.paused, false);
  });

  it("allows repeated pause and unpause operations", async () => {
    for (const paused of [true, true, false, false]) {
      await program.methods
        .setVaultPaused(paused)
        .accountsPartial({ owner, vault: vaultPda })
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assert.strictEqual(vault.paused, paused);
    }
  });
});