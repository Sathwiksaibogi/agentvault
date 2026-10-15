import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Agentvault } from "../target/types/agentvault";

const RPC_URL = "http://127.0.0.1:8899";
const LOCAL_DIR = join(process.cwd(), "demo/local");
const STATE_PATH = join(LOCAL_DIR, "state.json");

type DemoState = {
  genesisHash: string;
  programId: string;
  owner: string;
  vaultId: string;
  mint: string;
  vault: string;
  treasury: string;
};

// Creates a new identity once, then reuses it on later runs.
function loadOrCreateKeypair(name: string): Keypair {
  mkdirSync(LOCAL_DIR, { recursive: true });

  const path = join(LOCAL_DIR, `${name}.json`);

  if (existsSync(path)) {
    chmodSync(path, 0o600);

    const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];

    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }

  const keypair = Keypair.generate();

  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), {
    flag: "wx",
    mode: 0o600,
  });

  console.log(`Created ${name} identity`);

  return keypair;
}

async function main() {
  process.env.ANCHOR_PROVIDER_URL = RPC_URL;
  process.env.ANCHOR_WALLET ??= join(homedir(), ".config/solana/id.json");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const owner = provider.wallet.publicKey;

  // Load AgentVault's existing IDL.
  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;

  const program = new anchor.Program<Agentvault>(idl, provider);

  // Read public state created by demo/bootstrap.ts.
  assert.ok(existsSync(STATE_PATH), "Run demo/bootstrap.ts first");

  const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as DemoState;

  assert.strictEqual(
    await connection.getGenesisHash(),
    state.genesisHash,
    "Wrong validator ledger"
  );

  assert.strictEqual(program.programId.toBase58(), state.programId);

  assert.strictEqual(owner.toBase58(), state.owner);

  const vaultPda = new PublicKey(state.vault);
  const tokenMint = new PublicKey(state.mint);
  const treasury = new PublicKey(state.treasury);

  const vaultBefore = await program.account.vault.fetch(vaultPda, "processed");

  const treasuryBefore = await getAccount(
    connection,
    treasury,
    "processed",
    TOKEN_PROGRAM_ID
  );

  assert.ok(vaultBefore.owner.equals(owner));
  assert.ok(vaultBefore.tokenMint.equals(tokenMint));
  assert.strictEqual(vaultBefore.paused, false);
  assert.ok(treasuryBefore.owner.equals(vaultPda));

  console.log("Program:", program.programId.toBase58());
  console.log("Vault:", vaultPda.toBase58());
  console.log("Treasury balance:", treasuryBefore.amount.toString());

  // Each agent gets its own signing identity and recipient.
  const agents = [
    {
      name: "Agent A - Procurement",
      keyName: "agent-a",
      recipientName: "recipient-a",
      budget: 150_000,
    },
    {
      name: "Agent B - Operations",
      keyName: "agent-b",
      recipientName: "recipient-b",
      budget: 100_000,
    },
  ];

  for (const config of agents) {
    // 1. Reuse persistent private signing identities.
    const authority = loadOrCreateKeypair(config.keyName);
    const recipient = loadOrCreateKeypair(config.recipientName);

    // 2. Derive this agent's PDA.
    const [agentPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        vaultPda.toBuffer(),
        authority.publicKey.toBuffer(),
      ],
      program.programId
    );

    // 3. Register the agent only if it is new.
    const existingAgent = await connection.getAccountInfo(
      agentPda,
      "processed"
    );

    if (!existingAgent) {
      const tx = await program.methods
        .registerAgent(authority.publicKey)
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(`${config.name} registered:`, tx);
    } else {
      console.log(`${config.name} already registered`);
    }

    const agentAccount = await program.account.agent.fetch(
      agentPda,
      "processed"
    );

    assert.ok(agentAccount.vault.equals(vaultPda));
    assert.ok(agentAccount.authority.equals(authority.publicKey));
    assert.strictEqual(agentAccount.active, true);

    // 4. Derive Task ID 1 under this agent.
    const taskId = new BN(1);

    const [taskPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentPda.toBuffer(),
        taskId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // 5. Create the task if it doesn't exist.
    const existingTask = await connection.getAccountInfo(taskPda, "processed");

    if (!existingTask) {
      // Use a longer expiry for Demo Day.
      const expiresAt = new BN(
        Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60
      );

      const tx = await program.methods
        .createTask(
          taskId,
          new BN(config.budget),
          recipient.publicKey,
          expiresAt
        )
        .accountsPartial({
          owner,
          vault: vaultPda,
          agent: agentPda,
          tokenMint,
          treasury,
          task: taskPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(`${config.name} task created:`, tx);
    } else {
      console.log(`${config.name} task already exists`);
    }

    // 6. Verify the on-chain spending policy.
    const task = await program.account.task.fetch(taskPda, "processed");

    assert.ok(task.vault.equals(vaultPda));
    assert.ok(task.agent.equals(agentPda));
    assert.ok(task.recipient.equals(recipient.publicKey));
    assert.ok(task.budget.eq(new BN(config.budget)));

    console.log(`\n=== ${config.name} ===`);
    console.log("Authority:", authority.publicKey.toBase58());
    console.log("Agent PDA:", agentPda.toBase58());
    console.log("Task PDA:", taskPda.toBase58());
    console.log("Recipient:", recipient.publicKey.toBase58());
    console.log("Budget:", task.budget.toString());
    console.log("Spent:", task.spent.toString());
    console.log("Next nonce:", task.nextNonce.toString());
    console.log("Task active:", task.active);
  }

  // 7. Verify total shared reservations.
  const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

  const treasuryAfter = await getAccount(
    connection,
    treasury,
    "processed",
    TOKEN_PROGRAM_ID
  );

  const reserved = Number(vaultAfter.totalReserved.toString());
  const balance = Number(treasuryAfter.amount);

  console.log("\n=== MULTI-AGENT SETUP COMPLETE ===");
  console.log("Treasury balance:", balance);
  console.log("Total reserved:", reserved);
  console.log("Unreserved funds:", balance - reserved);
  console.log("Agent identities stored in demo/local/");
}

main().catch((error) => {
  console.error("Agent setup failed:", error);
  process.exitCode = 1;
});
