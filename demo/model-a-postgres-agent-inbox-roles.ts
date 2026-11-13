/**
 * AgentVault 77D3C2: INACTIVE restricted SQL-function adapters.
 * These do NOT authenticate a caller. The application MUST first authenticate
 * the developer or signed agent and verify the selected vault on-chain.
 * Do not use migration-owner credentials in a service; distinct, privilege-
 * checked runtime logins are required before any real API cutover.
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

type QueryExecutor = Pick<Pool, "query">;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PRINCIPAL_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const MAX_PAGE = 25;

function schema(name: string): string {
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

function publicKey(value: string): string {
  const encoded = new PublicKey(value).toBase58();
  if (encoded !== value) throw new Error("Noncanonical public key");
  return encoded;
}

function checkUnix(nowUnix: number): void {
  if (!Number.isSafeInteger(nowUnix) || nowUnix < 0) {
    throw new Error("Invalid trusted time");
  }
}

function validateScope(scope: TrustedPaymentIntakeScope): void {
  checkUnix(scope.nowUnix);
  if (scope.network !== "devnet" || !PRINCIPAL_RE.test(scope.principalId)) {
    throw new Error("Invalid trusted principal");
  }
  publicKey(scope.vault);
}

function decode(raw: unknown): StoredModelAPaymentIntent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid durable inbox record");
  }
  const record = raw as StoredModelAPaymentIntent;
  if (
    Object.keys(record).sort().join(",") !==
      "createdAtUnix,kind,network,principalId,request,status,vault,version" ||
    record.version !== 1 ||
    record.kind !== "model-a-payment-intent" ||
    record.status !== "received" ||
    record.network !== "devnet" ||
    !PRINCIPAL_RE.test(record.principalId) ||
    !Number.isSafeInteger(record.createdAtUnix) ||
    record.createdAtUnix < 0
  ) {
    throw new Error("Invalid durable inbox binding");
  }
  publicKey(record.vault);
  const canonical = validateModelAPaymentIntent(
    record.request,
    record.createdAtUnix
  );
  if (!isDeepStrictEqual(canonical, record.request)) {
    throw new Error("Noncanonical durable request");
  }
  return record;
}

/** Restricted writer: database role av_model_a_intake; no discovery method. */
export class RestrictedModelAInboxIntake {
  private readonly namespace: string;

  constructor(private readonly db: QueryExecutor, privateSchema: string) {
    this.namespace = schema(privateSchema);
  }

  async receive(args: {
    trustedScope: TrustedPaymentIntakeScope;
    input: unknown;
  }): Promise<{ record: StoredModelAPaymentIntent; duplicate: boolean }> {
    const scope = args.trustedScope;
    validateScope(scope);
    const request: ModelAPaymentIntentInput = validateModelAPaymentIntent(
      args.input,
      scope.nowUnix
    );
    const candidate: StoredModelAPaymentIntent = {
      version: 1,
      kind: "model-a-payment-intent",
      status: "received",
      network: "devnet",
      vault: scope.vault,
      principalId: scope.principalId,
      createdAtUnix: scope.nowUnix,
      request,
    };
    let result;
    try {
      result = await this.db.query<{
        saved_record: unknown;
        duplicate: boolean;
      }>(
        `SELECT saved_record, duplicate FROM ${this.namespace}.model_a_inbox_submit($1::jsonb)`,
        [JSON.stringify(candidate)]
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new PaymentIntentConflict();
      }
      throw error;
    }
    if (result.rows.length !== 1) throw new Error("Unexpected submit result");
    const { duplicate, saved_record } = result.rows[0];
    if (typeof duplicate !== "boolean") {
      throw new Error("Unexpected submit result");
    }
    const record = decode(saved_record);
    if (
      record.vault !== scope.vault ||
      record.principalId !== scope.principalId ||
      !isDeepStrictEqual(record.request, request) ||
      record.createdAtUnix > scope.nowUnix
    ) {
      throw new Error("Durable request binding mismatch");
    }
    return { record, duplicate };
  }

  async read(args: {
    trustedScope: TrustedPaymentIntakeScope;
    requestId: string;
  }): Promise<StoredModelAPaymentIntent | null> {
    const scope = args.trustedScope;
    validateScope(scope);
    if (!ID_RE.test(args.requestId)) throw new Error("Invalid request ID");
    const result = await this.db.query<{ record: unknown }>(
      `SELECT ${this.namespace}.model_a_inbox_get($1, $2, $3) AS record`,
      [scope.vault, scope.principalId, args.requestId]
    );
    if (result.rows.length !== 1) throw new Error("Unexpected read result");
    if (result.rows[0].record === null) return null;
    const record = decode(result.rows[0].record);
    if (
      record.vault !== scope.vault ||
      record.principalId !== scope.principalId ||
      record.request.requestId !== args.requestId
    ) {
      throw new Error("Durable read scope mismatch");
    }
    return record;
  }
}

/** Restricted reader: database role av_model_a_reader; no write method. */
export class RestrictedModelAInboxReader {
  private readonly namespace: string;

  constructor(private readonly db: QueryExecutor, privateSchema: string) {
    this.namespace = schema(privateSchema);
  }

  async discover(args: {
    vault: string;
    agentAuthority: string;
    nowUnix: number;
  }): Promise<StoredModelAPaymentIntent[]> {
    const vault = publicKey(args.vault);
    const agentAuthority = publicKey(args.agentAuthority);
    checkUnix(args.nowUnix);
    const result = await this.db.query<{ record: unknown }>(
      `SELECT record FROM ${this.namespace}.model_a_inbox_discover($1, $2, $3::bigint)`,
      [vault, agentAuthority, args.nowUnix]
    );
    if (result.rows.length > MAX_PAGE) {
      throw new Error("Inbox page limit exceeded");
    }
    return result.rows.map((row) => {
      const record = decode(row.record);
      if (
        record.vault !== vault ||
        record.request.agentAuthority !== agentAuthority ||
        BigInt(record.request.expiresAtUnix) <= BigInt(args.nowUnix)
      ) {
        throw new Error("Durable discovery scope mismatch");
      }
      return record;
    });
  }
}
