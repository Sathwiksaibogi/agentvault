import { Buffer } from "buffer";
import {
  clusterApiUrl,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import type { WalletTransactionSigner } from "./initializeWebVault";
import { webAgents } from "./webAgents";

// Anchor instruction discriminators.
const REGISTER_AGENT = Uint8Array.from([135, 157, 66, 195, 2, 113, 175, 30]);

const CREATE_TASK = Uint8Array.from([194, 80, 6, 180, 232, 127, 48, 171]);

const VAULT_ACCOUNT = Uint8Array.from([211, 8, 232, 43, 2, 152, 117, 119]);

const AGENT_ACCOUNT = Uint8Array.from([47, 166, 112, 147, 155, 197, 86, 7]);

const TASK_ACCOUNT = Uint8Array.from([79, 34, 229, 55, 88, 90, 55, 84]);

export type AgentRegistrationResult = {
  name: string;
  agentPda: string;
  taskPda: string;
  agentRegistered: boolean;
  taskCreated: boolean;
};

export type WebAgentRegistrationSummary = {
  signatures: string[];
  agents: AgentRegistrationResult[];
  totalReservedBaseUnits: string;
};

function u64LE(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64LE(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

function matches(bytes: Uint8Array, expected: Uint8Array): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

async function send(
  connection: Connection,
  wallet: WalletTransactionSigner,
  instruction: TransactionInstruction
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error("Phantom disconnected");
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const transaction = new Transaction({
    feePayer: wallet.publicKey,
    recentBlockhash: blockhash,
  });

  transaction.add(instruction);

  const signed = await wallet.signTransaction(transaction);

  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
  });

  try {
    const result = await connection.confirmTransaction(
      {
        signature,
        blockhash,
        lastValidBlockHeight,
      },
      "confirmed"
    );

    if (result.value.err) {
      throw new Error(JSON.stringify(result.value.err));
    }
  } catch (cause) {
    throw new Error(
      `Submitted ${signature}, but confirmation failed or timed out. ` +
        "Verify the transaction and PDA before retrying.",
      { cause }
    );
  }

  return signature;
}

function verifyExistingAgent(
  data: Uint8Array,
  vault: PublicKey,
  authority: PublicKey
): void {
  if (data.length < 74 || !matches(data, AGENT_ACCOUNT)) {
    throw new Error("Invalid agent account layout");
  }

  if (
    !new PublicKey(data.subarray(8, 40)).equals(vault) ||
    !new PublicKey(data.subarray(40, 72)).equals(authority) ||
    data[72] !== 1
  ) {
    throw new Error("Existing agent authority, vault or status mismatch");
  }
}

function verifyExistingTask(
  data: Uint8Array,
  vault: PublicKey,
  agentPda: PublicKey,
  recipient: PublicKey,
  budget: bigint,
  taskId: bigint
): void {
  if (data.length < 146 || !matches(data, TASK_ACCOUNT)) {
    throw new Error("Invalid task account layout");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (
    !new PublicKey(data.subarray(8, 40)).equals(vault) ||
    !new PublicKey(data.subarray(40, 72)).equals(agentPda) ||
    view.getBigUint64(72, true) !== taskId ||
    !new PublicKey(data.subarray(80, 112)).equals(recipient) ||
    view.getBigUint64(112, true) !== budget ||
    data[144] !== 1
  ) {
    throw new Error("Existing task fields or status mismatch");
  }
}

export async function registerWebAgents(
  wallet: WalletTransactionSigner
): Promise<WebAgentRegistrationSummary> {
  const owner = wallet.publicKey;

  if (!owner || owner.toBase58() !== webAgents.owner) {
    throw new Error("Connect the Phantom wallet that owns Vault 8001");
  }

  if (typeof wallet.signTransaction !== "function") {
    throw new Error("Phantom signing unavailable");
  }

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

  const program = new PublicKey(webAgents.programId);
  const vault = new PublicKey(webAgents.vault);
  const mint = new PublicKey(webAgents.mint);
  const treasury = new PublicKey(webAgents.treasury);

  const [derivedVault] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("vault"),
      owner.toBytes(),
      u64LE(BigInt(webAgents.vaultId)),
    ],
    program
  );

  if (!derivedVault.equals(vault)) {
    throw new Error("Derived vault PDA mismatch");
  }

  const programInfo = await connection.getAccountInfo(program, "confirmed");

  if (!programInfo?.executable) {
    throw new Error("AgentVault program not deployed on Devnet");
  }

  const vaultInfo = await connection.getAccountInfo(vault, "confirmed");

  if (!vaultInfo?.owner.equals(program) || vaultInfo.data.length < 90) {
    throw new Error("Web vault missing");
  }

  const vaultData = vaultInfo.data;

  const vaultView = new DataView(
    vaultData.buffer,
    vaultData.byteOffset,
    vaultData.byteLength
  );

  if (
    !matches(vaultData, VAULT_ACCOUNT) ||
    !new PublicKey(vaultData.subarray(8, 40)).equals(owner) ||
    !new PublicKey(vaultData.subarray(40, 72)).equals(mint) ||
    vaultView.getBigUint64(72, true) !== BigInt(webAgents.vaultId) ||
    vaultData[88] !== 0
  ) {
    throw new Error("Web vault owner, mint, ID or pause status mismatch");
  }

  const tokenAccount = await getAccount(
    connection,
    treasury,
    "confirmed",
    TOKEN_PROGRAM_ID
  );

  if (!tokenAccount.owner.equals(vault) || !tokenAccount.mint.equals(mint)) {
    throw new Error("Treasury authority or mint mismatch");
  }

  const targetBudget = webAgents.agents.reduce(
    (total, agent) => total + BigInt(agent.budgetBaseUnits),
    BigInt(0)
  );

  if (tokenAccount.amount < targetBudget) {
    throw new Error("Treasury does not have enough funds for both budgets");
  }

  const signatures: string[] = [];
  const agents: AgentRegistrationResult[] = [];

  for (const config of webAgents.agents) {
    const authority = new PublicKey(config.authority);
    const recipient = new PublicKey(config.recipient);
    const taskId = BigInt(config.taskId);
    const budget = BigInt(config.budgetBaseUnits);

    const [agentPda] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("agent"), vault.toBytes(), authority.toBytes()],
      program
    );

    const [taskPda] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("task"), agentPda.toBytes(), u64LE(taskId)],
      program
    );

    let agentRegistered = false;
    let taskCreated = false;

    // Register Agent PDA only if not already present.
    const existingAgent = await connection.getAccountInfo(
      agentPda,
      "confirmed"
    );

    if (existingAgent) {
      if (!existingAgent.owner.equals(program)) {
        throw new Error("Wrong agent program owner");
      }

      verifyExistingAgent(existingAgent.data, vault, authority);
    } else {
      const instruction = new TransactionInstruction({
        programId: program,
        keys: [
          {
            pubkey: owner,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: vault,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: agentPda,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: Buffer.from([...REGISTER_AGENT, ...authority.toBytes()]),
      });

      signatures.push(await send(connection, wallet, instruction));

      agentRegistered = true;

      const created = await connection.getAccountInfo(agentPda, "confirmed");

      if (!created?.owner.equals(program)) {
        throw new Error("Agent registration not observable");
      }

      verifyExistingAgent(created.data, vault, authority);
    }

    // Create task only if it doesn't exist.
    const existingTask = await connection.getAccountInfo(taskPda, "confirmed");

    if (existingTask) {
      if (!existingTask.owner.equals(program)) {
        throw new Error("Wrong task program owner");
      }

      verifyExistingTask(
        existingTask.data,
        vault,
        agentPda,
        recipient,
        budget,
        taskId
      );
    } else {
      const expiresAt = BigInt(
        Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60
      );

      const instruction = new TransactionInstruction({
        programId: program,
        keys: [
          {
            pubkey: owner,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: vault,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: agentPda,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: mint,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: treasury,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: taskPda,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: TOKEN_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: Buffer.from([
          ...CREATE_TASK,
          ...u64LE(taskId),
          ...u64LE(budget),
          ...recipient.toBytes(),
          ...i64LE(expiresAt),
        ]),
      });

      signatures.push(await send(connection, wallet, instruction));

      taskCreated = true;

      const created = await connection.getAccountInfo(taskPda, "confirmed");

      if (!created?.owner.equals(program)) {
        throw new Error("Task creation not observable");
      }

      verifyExistingTask(
        created.data,
        vault,
        agentPda,
        recipient,
        budget,
        taskId
      );
    }

    agents.push({
      name: config.name,
      agentPda: agentPda.toBase58(),
      taskPda: taskPda.toBase58(),
      agentRegistered,
      taskCreated,
    });
  }

  const finalVault = await connection.getAccountInfo(vault, "confirmed");

  if (!finalVault?.owner.equals(program) || finalVault.data.length < 90) {
    throw new Error("Unable to verify final reservation state");
  }

  const finalView = new DataView(
    finalVault.data.buffer,
    finalVault.data.byteOffset,
    finalVault.data.byteLength
  );

  const totalReservedBaseUnits = finalView.getBigUint64(80, true).toString();

  return {
    signatures,
    agents,
    totalReservedBaseUnits,
  };
}
