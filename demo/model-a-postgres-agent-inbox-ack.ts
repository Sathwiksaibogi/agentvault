/**
 * AgentVault 77D3C3: INACTIVE, acknowledgment-only adapter.
 * An acknowledgment is a durable delivery receipt, NOT payment authorization,
 * approval, an execution claim, a spending reservation, or a payment.
 *
 * The caller MUST authenticate the agent's signed (vault, authority) scope,
 * verify its active on-chain registration, and provide a trusted server clock.
 * Use only a dedicated restricted av_model_a_ack service credential.
 */
import { PublicKey } from "@solana/web3.js";
import type { Pool } from "pg";

type QueryExecutor = Pick<Pool, "query">;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function canonicalKey(value: string): string {
  const key = new PublicKey(value).toBase58();
  if (key !== value) throw new Error("Noncanonical public key");
  return key;
}

function safeSchema(name: string): string {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(name) ||
    name === "public" ||
    name === "information_schema" ||
    name.startsWith("pg_")
  ) {
    throw new Error("Invalid private Model A schema");
  }
  return `"${name}"`;
}

export type ModelAInboxAcknowledgment = {
  acknowledgedAtUnix: number;
  duplicate: boolean;
};

export class RestrictedModelAInboxAcknowledger {
  private readonly namespace: string;

  constructor(private readonly db: QueryExecutor, privateSchema: string) {
    this.namespace = safeSchema(privateSchema);
  }

  async acknowledge(args: {
    vault: string;
    agentAuthority: string;
    requestId: string;
    nowUnix: number;
  }): Promise<ModelAInboxAcknowledgment> {
    const vault = canonicalKey(args.vault);
    const agentAuthority = canonicalKey(args.agentAuthority);
    if (!REQUEST_ID_RE.test(args.requestId)) {
      throw new Error("Invalid request ID");
    }
    if (!Number.isSafeInteger(args.nowUnix) || args.nowUnix < 0) {
      throw new Error("Invalid trusted timestamp");
    }
    const result = await this.db.query<{
      acknowledged_at_unix: string | number;
      duplicate: boolean;
    }>(
      `SELECT acknowledged_at_unix, duplicate
       FROM ${this.namespace}.model_a_inbox_acknowledge($1, $2, $3, $4::bigint)`,
      [vault, agentAuthority, args.requestId, args.nowUnix]
    );
    if (result.rows.length !== 1) throw new Error("Unexpected ack result");
    const row = result.rows[0];
    const timestamp = Number(row.acknowledged_at_unix);
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      timestamp > args.nowUnix ||
      typeof row.duplicate !== "boolean"
    ) {
      throw new Error("Invalid ack binding");
    }
    return { acknowledgedAtUnix: timestamp, duplicate: row.duplicate };
  }
}
