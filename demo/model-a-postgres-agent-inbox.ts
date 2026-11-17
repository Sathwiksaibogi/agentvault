/**
 * AgentVault 77D3C1: INACTIVE PostgreSQL inbox store, NOT wired into the API.
 * This code NEVER authorizes, claims, approves or submits a payment.
 * Its caller must supply scopes verified by the existing authentication and
 * on-chain policy boundaries. Do not expose a raw Pool to agents or browsers.
 *
 * Production cutover needs restricted database roles, explicit storage
 * lifecycle, process-restart tests, and an atomic intake+queue transaction.
 */
import { isDeepStrictEqual } from "node:util";
import { PublicKey } from "@solana/web3.js";
import type { Pool } from "pg";
import {
  PaymentIntentConflict,
  validateModelAPaymentIntent,
  type ModelAPaymentIntentInput,
  type StoredModelAPaymentIntent,
  type TrustedPaymentIntakeScope,
} from "./model-a-payment-intake";

const PRINCIPAL_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PAGE_LIMIT = 25;

type Row = {
  network: string;
  vault: string;
  request_id: string;
  agent_authority: string;
  principal_id: string;
  created_at_unix: string;
  expires_at_unix: string;
  status: string;
  record: unknown;
};

function canonicalKey(input: string): string {
  const value = new PublicKey(input).toBase58();
  if (value !== input) throw new Error("Noncanonical public key");
  return value;
}

function scopeCheck(scope: TrustedPaymentIntakeScope): void {
  if (
    scope.network !== "devnet" ||
    !PRINCIPAL_RE.test(scope.principalId) ||
    !Number.isSafeInteger(scope.nowUnix) ||
    scope.nowUnix < 0
  ) {
    throw new Error("Invalid trusted intake scope");
  }
  canonicalKey(scope.vault);
}

function unixCheck(nowUnix: number): void {
  if (!Number.isSafeInteger(nowUnix) || nowUnix < 0) {
    throw new Error("Invalid server time");
  }
}

function schemaIdentifier(name: string): string {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(name) ||
    name === "public" ||
    name === "information_schema" ||
    name.startsWith("pg_")
  ) {
    throw new Error("Invalid private inbox schema");
  }
  return `"${name}"`;
}

/** Revalidate SQL and JSON bindings; never trust a retrieved JSONB object. */
function decodeRow(row: Row): StoredModelAPaymentIntent {
  const raw = row.record;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Corrupt PostgreSQL inbox record");
  }
  const record = raw as StoredModelAPaymentIntent;
  if (
    Object.keys(record).sort().join(",") !==
      "createdAtUnix,kind,network,principalId,request,status,vault,version" ||
    record.version !== 1 ||
    record.kind !== "model-a-payment-intent" ||
    record.status !== "received" ||
    record.network !== "devnet" ||
    typeof record.principalId !== "string" ||
    !PRINCIPAL_RE.test(record.principalId) ||
    !Number.isSafeInteger(record.createdAtUnix) ||
    record.createdAtUnix < 0 ||
    canonicalKey(record.vault) !== row.vault ||
    row.network !== record.network ||
    row.principal_id !== record.principalId ||
    row.created_at_unix !== String(record.createdAtUnix) ||
    row.status !== record.status
  ) {
    throw new Error("Corrupt PostgreSQL inbox binding");
  }
  const request = validateModelAPaymentIntent(
    record.request,
    record.createdAtUnix
  );
  if (
    !isDeepStrictEqual(request, record.request) ||
    row.request_id !== request.requestId ||
    row.agent_authority !== request.agentAuthority ||
    row.expires_at_unix !== request.expiresAtUnix
  ) {
    throw new Error("Corrupt PostgreSQL request binding");
  }
  return record;
}

const COLUMNS =
  "network, vault, request_id, agent_authority, principal_id, created_at_unix, expires_at_unix, status, record";

/** Read-only discovery and idempotent intake; no acknowledgment or dispatch yet. */
export class PostgresModelAAgentInbox {
  private readonly table: string;

  constructor(private readonly pool: Pool, schema: string) {
    this.table = `${schemaIdentifier(schema)}.model_a_agent_inbox`;
  }

  async receive(args: {
    trustedScope: TrustedPaymentIntakeScope;
    input: unknown;
  }): Promise<{ record: StoredModelAPaymentIntent; duplicate: boolean }> {
    const { trustedScope: scope } = args;
    scopeCheck(scope);
    const request = validateModelAPaymentIntent(args.input, scope.nowUnix);
    const record: StoredModelAPaymentIntent = {
      version: 1,
      kind: "model-a-payment-intent",
      status: "received",
      network: "devnet",
      vault: scope.vault,
      principalId: scope.principalId,
      createdAtUnix: scope.nowUnix,
      request,
    };
    const values = [
      scope.network,
      scope.vault,
      request.requestId,
      request.agentAuthority,
      scope.principalId,
      scope.nowUnix,
      request.expiresAtUnix,
      record.status,
      JSON.stringify(record),
    ];
    const insert = await this.pool.query<Row>(
      `INSERT INTO ${this.table} (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (network, vault, request_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      values
    );
    if (insert.rows.length === 1) {
      return { record: decodeRow(insert.rows[0]), duplicate: false };
    }
    // Separate SELECT after a unique conflict sees the committed winner at
    // PostgreSQL's default READ COMMITTED isolation. An absent row fails closed.
    const existing = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM ${this.table}
       WHERE network = $1 AND vault = $2 AND request_id = $3`,
      [scope.network, scope.vault, request.requestId]
    );
    if (existing.rows.length !== 1) {
      throw new Error("Payment intent idempotency requires reconciliation");
    }
    const saved = decodeRow(existing.rows[0]);
    if (
      saved.principalId !== scope.principalId ||
      !isDeepStrictEqual(saved.request, request)
    ) {
      throw new PaymentIntentConflict();
    }
    return { record: saved, duplicate: true };
  }

  async read(args: {
    trustedScope: TrustedPaymentIntakeScope;
    requestId: string;
  }): Promise<StoredModelAPaymentIntent | null> {
    const { trustedScope: scope, requestId } = args;
    scopeCheck(scope);
    if (!REQUEST_ID_RE.test(requestId)) throw new Error("Invalid request ID");
    const res = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM ${this.table}
       WHERE network = $1 AND vault = $2
         AND request_id = $3 AND principal_id = $4`,
      [scope.network, scope.vault, requestId, scope.principalId]
    );
    if (res.rows.length === 0) return null;
    if (res.rows.length !== 1) throw new Error("Duplicate request identity");
    return decodeRow(res.rows[0]);
  }

  async discover(args: {
    vault: string;
    agentAuthority: string;
    nowUnix: number;
  }): Promise<StoredModelAPaymentIntent[]> {
    const vault = canonicalKey(args.vault);
    const agentAuthority = canonicalKey(args.agentAuthority);
    unixCheck(args.nowUnix);
    const res = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM ${this.table}
       WHERE network = 'devnet' AND vault = $1
         AND agent_authority = $2 AND status = 'received'
         AND expires_at_unix > $3
       ORDER BY created_at_unix, request_id
       LIMIT ${PAGE_LIMIT + 1}`,
      [vault, agentAuthority, args.nowUnix]
    );
    // Preserve the prototype's fail-closed bound until pagination is designed.
    if (res.rows.length > PAGE_LIMIT) {
      throw new Error("Inbox page limit exceeded");
    }
    return res.rows.map(decodeRow);
  }
}
