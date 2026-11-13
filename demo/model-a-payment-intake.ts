/**
 * AgentVault Model A payment-intent intake: DEVNET, LOCAL DEVELOPMENT ONLY.
 *
 * This inbox is intentionally separate from the signed-workflow claim journal.
 * An accepted request is NOT an owner approval, execution authorization,
 * transaction, or payment. A future, separately guarded dispatcher must
 * authenticate the principal, re-read the selected vault/agent/task on-chain,
 * and create an execution journal claim before any payment is attempted.
 *
 * Filesystem persistence is appropriate only for a single-host prototype;
 * production must use a transactionally unique PostgreSQL store.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MAX_U64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const MAX_I64 = (BigInt(1) << BigInt(63)) - BigInt(1);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PRINCIPAL_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;

export type TrustedPaymentIntakeScope = {
  /** Derived from verified backend credentials, NOT from the HTTP request body. */
  principalId: string;
  /** Taken from a verified, selected, on-chain-owned vault. */
  vault: string;
  network: "devnet";
  /** Unix time from the server clock; caller must supply a trustworthy clock. */
  nowUnix: number;
};

export type ModelAPaymentIntentInput = {
  requestId: string;
  agentAuthority: string;
  taskId: string;
  recipient: string;
  amountBaseUnits: string;
  expiresAtUnix: string;
  reason?: string;
};

export type StoredModelAPaymentIntent = {
  version: 1;
  kind: "model-a-payment-intent";
  status: "received";
  network: "devnet";
  vault: string;
  principalId: string;
  createdAtUnix: number;
  request: ModelAPaymentIntentInput;
};

export class PaymentIntentConflict extends Error {
  constructor() {
    super("Request ID already exists with different parameters");
    this.name = "PaymentIntentConflict";
  }
}

function requireObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid payment request");
  }
  return input as Record<string, unknown>;
}

function requireU64(value: unknown, name: string, allowZero: boolean): string {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new Error(`Invalid ${name}`);
  }
  const n = BigInt(value);
  if (n > MAX_U64 || (!allowZero && n === BigInt(0))) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function requirePubkey(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) {
    throw new Error(`Invalid ${name}`);
  }
  // Decode base58 to assert exactly 32 bytes; a permissive regex is insufficient.
  let n = BigInt(0);
  for (const char of value) {
    const index = BASE58.indexOf(char);
    if (index < 0) throw new Error(`Invalid ${name}`);
    n = n * BigInt(58) + BigInt(index);
  }
  const leadingZeros = value.match(/^1*/)?.[0].length ?? 0;
  let byteCount = 0;
  while (n > BigInt(0)) {
    n >>= BigInt(8);
    byteCount++;
  }
  if (leadingZeros + byteCount !== 32) throw new Error(`Invalid ${name}`);
  return value;
}

export function validateModelAPaymentIntent(
  input: unknown,
  nowUnix: number
): ModelAPaymentIntentInput {
  const obj = requireObject(input);
  const allowed = new Set([
    "requestId",
    "agentAuthority",
    "taskId",
    "recipient",
    "amountBaseUnits",
    "expiresAtUnix",
    "reason",
  ]);
  if (Object.keys(obj).some((key) => !allowed.has(key))) {
    throw new Error("Unexpected payment request field");
  }
  if (typeof obj.requestId !== "string" || !REQUEST_ID_RE.test(obj.requestId)) {
    throw new Error("Invalid request ID");
  }
  if (!Number.isSafeInteger(nowUnix) || nowUnix < 0) {
    throw new Error("Invalid server time");
  }
  const agentAuthority = requirePubkey(obj.agentAuthority, "agent authority");
  const recipient = requirePubkey(obj.recipient, "recipient");
  const taskId = requireU64(obj.taskId, "task ID", true);
  const amountBaseUnits = requireU64(obj.amountBaseUnits, "amount", false);
  if (
    typeof obj.expiresAtUnix !== "string" ||
    obj.expiresAtUnix.length > 19 ||
    !/^[1-9][0-9]*$/.test(obj.expiresAtUnix)
  ) {
    throw new Error("Invalid request expiry");
  }
  const expiresAt = BigInt(obj.expiresAtUnix);
  if (
    expiresAt > MAX_I64 ||
    expiresAt <= BigInt(nowUnix) ||
    expiresAt > BigInt(nowUnix + MAX_LIFETIME_SECONDS)
  ) {
    throw new Error("Request expiry outside supported window");
  }
  let reason: string | undefined;
  if (obj.reason !== undefined) {
    if (
      typeof obj.reason !== "string" ||
      obj.reason.length < 1 ||
      obj.reason.length > 160 ||
      obj.reason.trim() !== obj.reason ||
      /[\u0000-\u001F\u007F]/.test(obj.reason)
    ) {
      throw new Error("Invalid payment reason");
    }
    reason = obj.reason;
  }
  return {
    requestId: obj.requestId,
    agentAuthority,
    taskId,
    recipient,
    amountBaseUnits,
    expiresAtUnix: obj.expiresAtUnix,
    ...(reason === undefined ? {} : { reason }),
  };
}

function validateTrustedScope(scope: TrustedPaymentIntakeScope): void {
  if (scope.network !== "devnet" || !PRINCIPAL_RE.test(scope.principalId)) {
    throw new Error("Authenticated Devnet principal is required");
  }
  requirePubkey(scope.vault, "scoped vault");
  if (!Number.isSafeInteger(scope.nowUnix) || scope.nowUnix < 0) {
    throw new Error("Invalid server time");
  }
}

function journalPath(
  runtimeDir: string,
  scope: TrustedPaymentIntakeScope,
  requestId: string
): {
  dir: string;
  path: string;
} {
  // Never use user-supplied IDs as filesystem path components.
  const digest = createHash("sha256")
    .update(JSON.stringify([scope.network, scope.vault, requestId]))
    .digest("hex");
  const dir = join(runtimeDir, "payment-intent-inbox");
  return { dir, path: join(dir, `${digest}.json`) };
}

function matchesExisting(
  stored: StoredModelAPaymentIntent,
  scope: TrustedPaymentIntakeScope,
  request: ModelAPaymentIntentInput
): boolean {
  return (
    stored.version === 1 &&
    stored.kind === "model-a-payment-intent" &&
    stored.status === "received" &&
    Number.isSafeInteger(stored.createdAtUnix) &&
    stored.network === scope.network &&
    stored.vault === scope.vault &&
    stored.principalId === scope.principalId &&
    stored.request?.requestId === request.requestId &&
    JSON.stringify(stored.request) === JSON.stringify(request)
  );
}

/**
 * Persist a request WITHOUT scheduling or executing it. Replays with exactly
 * the same trusted principal + payload return the original record; changed
 * requests with the same ID fail closed. Never call this from unauthenticated
 * or unauthorized HTTP handlers.
 */
export function receiveModelAPaymentIntent(args: {
  runtimeDir: string;
  trustedScope: TrustedPaymentIntakeScope;
  input: unknown;
}): { record: StoredModelAPaymentIntent; duplicate: boolean } {
  const { runtimeDir, trustedScope } = args;
  validateTrustedScope(trustedScope);
  const request = validateModelAPaymentIntent(args.input, trustedScope.nowUnix);
  const { dir, path } = journalPath(
    runtimeDir,
    trustedScope,
    request.requestId
  );
  const record: StoredModelAPaymentIntent = {
    version: 1,
    kind: "model-a-payment-intent",
    status: "received",
    network: "devnet",
    vault: trustedScope.vault,
    principalId: trustedScope.principalId,
    createdAtUnix: trustedScope.nowUnix,
    request,
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: StoredModelAPaymentIntent;
    try {
      existing = JSON.parse(
        readFileSync(path, "utf8")
      ) as StoredModelAPaymentIntent;
    } catch {
      throw new Error(
        "Stored request unreadable; manual reconciliation required"
      );
    }
    if (!matchesExisting(existing, trustedScope, request)) {
      throw new PaymentIntentConflict();
    }
    return { record: existing, duplicate: true };
  }
  try {
    writeFileSync(fd, JSON.stringify(record) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return { record, duplicate: false };
}
