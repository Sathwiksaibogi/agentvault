/**
 * 7.6D.10: INACTIVE standalone witness process (never imported by payment CLI).
 *
 * One authenticated read-only PostgreSQL connection, one private witness key,
 * one independently configured HTTPS Solana RPC. No finalizer/coordinator DB
 * URL, owner key, payment signer or network-send capability.
 *
 * Output requires a private IPC channel; never log keys, RPC credentials or
 * attestations to stdout/stderr. This is a prototype, not a production daemon.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import { openModelBReaderDatabase } from "./model-b-postgres-runtime-databases";
import type { ModelBFinalityRpc } from "./model-b-postgres-chain-inspection";
import {
  inspectAndAttestModelBFinality,
  type WitnessId,
} from "./model-b-finality-independent-witness";

const FORBIDDEN_ENV = [
  "AGENTVAULT_TEST_DATABASE_URL",
  "AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL",
  "AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL",
  "AGENTVAULT_MODEL_B_TEST_READER_URL",
  "AGENTVAULT_MODEL_B_TEST_COORDINATOR_URL",
  "AGENTVAULT_MODEL_B_TEST_FINALIZER_URL",
  "AGENTVAULT_MODEL_B_WITNESS_OTHER_KEY_HEX",
];

export type PrivateWitnessConfiguration = Readonly<{
  witnessId: WitnessId;
  key: Buffer;
  genesisHash: string;
  programId: string;
  vault: string;
  rpcUrl: string;
}>;

/** Parse before opening any DB/RPC. The process must have one witness key. */
export function parsePrivateWitnessConfiguration(
  env: NodeJS.ProcessEnv
): PrivateWitnessConfiguration {
  if (FORBIDDEN_ENV.some((name) => env[name])) {
    throw new Error(
      "WITNESS_DENIED: privileged or sibling credentials present"
    );
  }
  if (
    !env.AGENTVAULT_MODEL_B_READER_DATABASE_URL ||
    !env.AGENTVAULT_MODEL_B_PRIVATE_SCHEMA ||
    !["observer_a", "observer_b"].includes(
      env.AGENTVAULT_MODEL_B_WITNESS_ID ?? ""
    )
  ) {
    throw new Error(
      "WITNESS_DENIED: isolated reader or witness identity missing"
    );
  }
  const keyHex = env.AGENTVAULT_MODEL_B_WITNESS_KEY_HEX;
  if (!keyHex || !/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error("WITNESS_DENIED: invalid private witness key");
  }
  const key = Buffer.from(keyHex, "hex");
  if (new Set(key).size < 8) {
    key.fill(0);
    throw new Error("WITNESS_DENIED: unsafe witness key material");
  }
  const rpcUrl = env.AGENTVAULT_MODEL_B_WITNESS_RPC_URL;
  let url: URL;
  try {
    url = new URL(rpcUrl ?? "");
  } catch {
    key.fill(0);
    throw new Error("WITNESS_DENIED: invalid independently configured RPC URL");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    key.fill(0);
    throw new Error(
      "WITNESS_DENIED: expected authenticated HTTPS RPC endpoint"
    );
  }
  const genesisHash = env.AGENTVAULT_MODEL_B_WITNESS_GENESIS_HASH;
  const programId = env.AGENTVAULT_MODEL_B_WITNESS_PROGRAM_ID;
  const vault = env.AGENTVAULT_MODEL_B_WITNESS_VAULT;
  const canonical = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try {
      return new PublicKey(value).toBase58() === value;
    } catch {
      return false;
    }
  };
  if (
    !canonical(genesisHash) ||
    !canonical(programId) ||
    programId !== AGENTVAULT_PROGRAM_ID.toBase58() ||
    !canonical(vault)
  ) {
    key.fill(0);
    throw new Error("WITNESS_DENIED: invalid pinned deployment identity");
  }
  return Object.freeze({
    witnessId: env.AGENTVAULT_MODEL_B_WITNESS_ID as WitnessId,
    key,
    genesisHash,
    programId,
    vault,
    rpcUrl: url.toString(),
  });
}

/**
 * Adapt the native web3.js Connection to the strict read-only finality RPC.
 * Missing confirmationStatus is unresolved, NEVER finalized. Preserve absent
 * error metadata so the inspector can reject incomplete RPC responses.
 */
export function adaptWeb3ConnectionForModelBFinality(
  connection: Connection
): ModelBFinalityRpc {
  return Object.freeze({
    getGenesisHash: () => connection.getGenesisHash(),
    async getSignatureStatuses(
      signatures: string[],
      config: { searchTransactionHistory: true }
    ) {
      const response = await connection.getSignatureStatuses(
        signatures,
        config
      );
      return {
        value: response.value.map((status) =>
          status
            ? {
                confirmationStatus: status.confirmationStatus ?? null,
                slot: status.slot,
                err: status.err,
              }
            : null
        ),
      };
    },
    async getTransaction(
      signature: string,
      config: { commitment: "finalized"; maxSupportedTransactionVersion: 0 }
    ) {
      const receipt = await connection.getTransaction(signature, config);
      if (!receipt) return null;
      return {
        slot: receipt.slot,
        transaction: { signatures: receipt.transaction.signatures },
        meta: receipt.meta ? { err: receipt.meta.err } : null,
      };
    },
  });
}

/**
 * Only requestId can be submitted by the IPC parent. Full identity is obtained
 * independently from PostgreSQL and pinned environment; status is derived from
 * this witness's own Solana RPC rather than from an external observation.
 */
export async function runPrivateModelBWitness(
  requestId: string,
  env: NodeJS.ProcessEnv = process.env
) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    throw new Error("WITNESS_DENIED: invalid request ID");
  }
  const config = parsePrivateWitnessConfiguration(env);
  let db: Awaited<ReturnType<typeof openModelBReaderDatabase>> | undefined;
  try {
    db = await openModelBReaderDatabase(env);
    const record = await db.service.getForReconciliation(requestId);
    if (!record) {
      throw new Error("WITNESS_DENIED: unknown stored payment");
    }
    const rpc = new Connection(config.rpcUrl, {
      commitment: "finalized",
      disableRetryOnRateLimit: true,
    });
    return await inspectAndAttestModelBFinality(
      config.witnessId,
      config.key,
      record,
      {
        genesisHash: config.genesisHash,
        programId: config.programId,
        vault: config.vault,
        rpc: adaptWeb3ConnectionForModelBFinality(rpc),
      }
    );
  } finally {
    config.key.fill(0);
    await db?.close();
  }
}

if (require.main === module) {
  (async () => {
    if (
      typeof process.send !== "function" ||
      !process.connected ||
      process.argv.length !== 3
    ) {
      throw new Error("WITNESS_DENIED: dedicated IPC required");
    }
    const result = await runPrivateModelBWitness(process.argv[2]);
    process.send({ type: "MODEL_B_FINALITY_WITNESS_RESULT", result }, () => {
      process.disconnect?.();
    });
  })().catch(() => {
    // No secrets, raw RPC response, or PostgreSQL diagnostics in process output.
    process.stderr.write("MODEL_B_WITNESS_DENIED\n");
    process.exitCode = 1;
    process.disconnect?.();
  });
}
