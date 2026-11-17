import test from "node:test";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type AccountInfo,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import type { Agentvault } from "../target/types/agentvault";
import {
  DEVNET_PROGRAM_ID,
  DEVNET_GENESIS_HASH,
  runDevnetPreflight,
} from "./devnet-acceptance-preflight";

const NOW = 1794750000;

function makeMockPreflightHarness(options: {
  clockTime?: number;
  taskExpiresAt?: number;
  vaultPaused?: boolean;
  agentActive?: boolean;
  taskActive?: boolean;
  treasuryBalance?: bigint;
  simErr?: unknown;
}) {
  const clockTime = options.clockTime ?? NOW;
  const taskExpiresAt = options.taskExpiresAt ?? NOW + 86400; // default 1 day in future
  const vaultPaused = options.vaultPaused ?? false;
  const agentActive = options.agentActive ?? true;
  const taskActive = options.taskActive ?? true;
  const treasuryBalance = options.treasuryBalance ?? 1_000_000n;
  const simErr = options.simErr ?? null;

  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const agentAuthority = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), Buffer.alloc(8)],
    DEVNET_PROGRAM_ID
  );
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultPda.toBuffer(), agentAuthority.toBuffer()],
    DEVNET_PROGRAM_ID
  );
  const [taskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), agentPda.toBuffer(), Buffer.alloc(8)],
    DEVNET_PROGRAM_ID
  );

  const treasuryAta = getAssociatedTokenAddressSync(
    mint,
    vaultPda,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const idlPath = join(process.cwd(), "target/idl/agentvault.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as Agentvault;

  const mockConnection = {
    async getGenesisHash() {
      return DEVNET_GENESIS_HASH;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(DEVNET_PROGRAM_ID)) {
        return {
          data: Buffer.alloc(0),
          executable: true,
          lamports: 1_000_000,
          owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
        } as AccountInfo<Buffer>;
      }
      if (address.equals(SYSVAR_CLOCK_PUBKEY)) {
        const buf = Buffer.alloc(40);
        buf.writeBigInt64LE(BigInt(clockTime), 32);
        return {
          data: buf,
          executable: false,
          lamports: 1,
          owner: SYSVAR_CLOCK_PUBKEY,
        } as AccountInfo<Buffer>;
      }
      if (address.equals(treasuryAta)) {
        // Mock SPL token account layout (165 bytes)
        const buf = Buffer.alloc(165);
        buf.set(mint.toBuffer(), 0);
        buf.set(vaultPda.toBuffer(), 32);
        buf.writeBigUInt64LE(treasuryBalance, 64);
        buf[108] = 1; // initialized
        return {
          data: buf,
          executable: false,
          lamports: 2_000_000,
          owner: TOKEN_PROGRAM_ID,
        } as AccountInfo<Buffer>;
      }
      return null;
    },
    async getAccountInfoAndContext(address: PublicKey) {
      const value = await (this as any).getAccountInfo(address);
      return { context: { slot: 1 }, value };
    },
    async getLatestBlockhash() {
      return {
        blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
        lastValidBlockHeight: 1000,
      };
    },
    async simulateTransaction() {
      return {
        context: { slot: 1 },
        value: {
          err: simErr,
          logs: simErr ? ["Program log: Instruction failed"] : ["Program log: Success"],
          unitsConsumed: 2000,
        },
      };
    },
  };

  // We spy/mock the anchor Program account fetchers by wrapping Connection or monkeypatching
  const program = new anchor.Program<Agentvault>(idl, { connection: mockConnection as any });
  (program.account.vault as any).fetch = async (addr: PublicKey) => {
    return {
      vaultId: new BN(0),
      owner,
      tokenMint: mint,
      totalReserved: new BN(150_000),
      paused: vaultPaused,
    };
  };
  (program.account.agent as any).fetch = async (addr: PublicKey) => {
    return {
      vault: vaultPda,
      authority: agentAuthority,
      active: agentActive,
    };
  };
  (program.account.task as any).fetch = async (addr: PublicKey) => {
    return {
      vault: vaultPda,
      agent: agentPda,
      taskId: new BN(1),
      recipient,
      budget: new BN(200_000),
      spent: new BN(50_000),
      nextNonce: new BN(1),
      expiresAt: new BN(taskExpiresAt),
      active: taskActive,
    };
  };

  return {
    mockConnection,
    program,
    owner,
    mint,
    agentAuthority,
    recipient,
    vaultPda,
    agentPda,
    taskPda,
    clockTime,
    taskExpiresAt,
  };
}

test("devnet preflight: expired task reports ACCEPTANCE READINESS: BLOCKED — TaskExpired while diagnostic passes", async () => {
  // Chain time: NOW, task expiresAt: NOW - 100 (expired)
  const harness = makeMockPreflightHarness({
    clockTime: NOW,
    taskExpiresAt: NOW - 100,
    simErr: { InstructionError: [1, { Custom: 6012 }] },
  });

  const result = await runDevnetPreflight({
    connection: harness.mockConnection as any,
    program: harness.program as any,
    state: {
      vault: harness.vaultPda.toBase58(),
      owner: harness.owner.toBase58(),
      agentAuthority: harness.agentAuthority.toBase58(),
      agentPda: harness.agentPda.toBase58(),
      taskPda: harness.taskPda.toBase58(),
      recipient: harness.recipient.toBase58(),
      mint: harness.mint.toBase58(),
    },
  });

  assert.equal(result.diagnosticOk, true, "Diagnostic read should succeed");
  assert.equal(result.task.expired, true, "Task must be marked expired");
  assert.equal(result.acceptanceReadiness, "BLOCKED");
  assert.equal(result.blockedReason, "BLOCKED — TaskExpired");
  assert.equal(result.simulation.errorCode, 6012);
  assert.equal(result.simulation.errorName, "TaskExpired");
});

test("devnet preflight: active unexpired task passes acceptance readiness", async () => {
  // Chain time: NOW, task expiresAt: NOW + 86400 (unexpired)
  const harness = makeMockPreflightHarness({
    clockTime: NOW,
    taskExpiresAt: NOW + 86400,
    simErr: null,
  });

  const result = await runDevnetPreflight({
    connection: harness.mockConnection as any,
    program: harness.program as any,
    state: {
      vault: harness.vaultPda.toBase58(),
      owner: harness.owner.toBase58(),
      agentAuthority: harness.agentAuthority.toBase58(),
      agentPda: harness.agentPda.toBase58(),
      taskPda: harness.taskPda.toBase58(),
      recipient: harness.recipient.toBase58(),
      mint: harness.mint.toBase58(),
    },
  });

  assert.equal(result.diagnosticOk, true);
  assert.equal(result.task.expired, false);
  assert.equal(result.acceptanceReadiness, "READY");
  assert.equal(result.blockedReason, undefined);
  assert.equal(result.simulation.success, true);
});

test("devnet preflight: paused vault blocks acceptance readiness", async () => {
  const harness = makeMockPreflightHarness({
    clockTime: NOW,
    taskExpiresAt: NOW + 86400,
    vaultPaused: true,
  });

  const result = await runDevnetPreflight({
    connection: harness.mockConnection as any,
    program: harness.program as any,
    state: {
      vault: harness.vaultPda.toBase58(),
      owner: harness.owner.toBase58(),
      agentAuthority: harness.agentAuthority.toBase58(),
      agentPda: harness.agentPda.toBase58(),
      taskPda: harness.taskPda.toBase58(),
      recipient: harness.recipient.toBase58(),
      mint: harness.mint.toBase58(),
    },
  });

  assert.equal(result.diagnosticOk, true);
  assert.equal(result.vault.paused, true);
  assert.equal(result.acceptanceReadiness, "BLOCKED");
  assert.equal(result.blockedReason, "BLOCKED — VaultPaused");
});

test("devnet preflight: inactive agent blocks acceptance readiness", async () => {
  const harness = makeMockPreflightHarness({
    clockTime: NOW,
    taskExpiresAt: NOW + 86400,
    agentActive: false,
  });

  const result = await runDevnetPreflight({
    connection: harness.mockConnection as any,
    program: harness.program as any,
    state: {
      vault: harness.vaultPda.toBase58(),
      owner: harness.owner.toBase58(),
      agentAuthority: harness.agentAuthority.toBase58(),
      agentPda: harness.agentPda.toBase58(),
      taskPda: harness.taskPda.toBase58(),
      recipient: harness.recipient.toBase58(),
      mint: harness.mint.toBase58(),
    },
  });

  assert.equal(result.diagnosticOk, true);
  assert.equal(result.agent.active, false);
  assert.equal(result.acceptanceReadiness, "BLOCKED");
  assert.equal(result.blockedReason, "BLOCKED — AgentInactive");
});

test("devnet preflight: inactive task blocks acceptance readiness", async () => {
  const harness = makeMockPreflightHarness({
    clockTime: NOW,
    taskExpiresAt: NOW + 86400,
    taskActive: false,
  });

  const result = await runDevnetPreflight({
    connection: harness.mockConnection as any,
    program: harness.program as any,
    state: {
      vault: harness.vaultPda.toBase58(),
      owner: harness.owner.toBase58(),
      agentAuthority: harness.agentAuthority.toBase58(),
      agentPda: harness.agentPda.toBase58(),
      taskPda: harness.taskPda.toBase58(),
      recipient: harness.recipient.toBase58(),
      mint: harness.mint.toBase58(),
    },
  });

  assert.equal(result.diagnosticOk, true);
  assert.equal(result.task.active, false);
  assert.equal(result.acceptanceReadiness, "BLOCKED");
  assert.equal(result.blockedReason, "BLOCKED — TaskInactive");
});
