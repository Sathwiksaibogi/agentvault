import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { strict as assert } from "assert";

import type { Agentvault } from "../target/types/agentvault";

describe("AgentVault - Vault Initialization", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentvault as Program<Agentvault>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const vaultId = new BN(1);

  const [vaultPda, vaultBump] =
    PublicKey.findProgramAddressSync(
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
  });

  it("initializes a vault with correct state", async () => {
    
    const tx = await program.methods
      .initializeVault(vaultId)
      .accountsPartial({
        owner,
        vault: vaultPda,
        tokenMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Vault initialized:", tx);

    const vault = await program.account.vault.fetch(vaultPda);

    assert.ok(vault.owner.equals(owner));
    assert.ok(vault.tokenMint.equals(tokenMint));
    assert.ok(vault.vaultId.eq(vaultId));
    assert.ok(vault.totalReserved.eq(new BN(0)));
    assert.strictEqual(vault.paused, false);
    assert.strictEqual(vault.bump, vaultBump);
  });

  it("rejects duplicate initialization", async () => {
    await assert.rejects(async () => {
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
  });
});
