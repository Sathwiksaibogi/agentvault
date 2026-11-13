/**
 * Local validation for the Devnet-only Model A payment-intent HTTP contract.
 * This is NOT policy authorization: the API independently authenticates the
 * developer key, checks the live on-chain policy, and stores a received intent.
 */
import type {
  ModelAPaymentIntentAccepted,
  ModelAPaymentIntentInput,
  StoredModelAPaymentIntent,
} from "./types.js";

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PRINCIPAL = /^[A-Za-z0-9._:@-]{1,128}$/;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const U64_MAX = "18446744073709551615";
const I64_MAX = "9223372036854775807";
const INTENT_NOTICE =
  "Request only; not approved, queued for execution, or paid";

function obj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimal(
  value: unknown,
  max: string,
  allowZero: boolean
): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    return false;
  if (!allowZero && value === "0") return false;
  return (
    value.length < max.length || (value.length === max.length && value <= max)
  );
}

function publicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44)
    return false;
  // Match the API's exact decoded 32-byte base58 requirement, without a Solana SDK dependency.
  let n = BigInt(0);
  for (const ch of value) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) return false;
    n = n * BigInt(58) + BigInt(digit);
  }
  const leadingZeroBytes = value.match(/^1*/)?.[0].length ?? 0;
  let nonzeroBytes = 0;
  while (n > BigInt(0)) {
    n >>= BigInt(8);
    nonzeroBytes++;
  }
  return leadingZeroBytes + nonzeroBytes === 32;
}

function intentInput(value: unknown): value is ModelAPaymentIntentInput {
  if (!obj(value)) return false;
  const allowed = new Set([
    "requestId",
    "agentAuthority",
    "taskId",
    "recipient",
    "amountBaseUnits",
    "expiresAtUnix",
    "reason",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    typeof value.requestId !== "string" ||
    !REQUEST_ID.test(value.requestId) ||
    !publicKey(value.agentAuthority) ||
    !publicKey(value.recipient) ||
    !decimal(value.taskId, U64_MAX, true) ||
    !decimal(value.amountBaseUnits, U64_MAX, false) ||
    !decimal(value.expiresAtUnix, I64_MAX, false)
  )
    return false;
  const reason = value.reason;
  return (
    reason === undefined ||
    (typeof reason === "string" &&
      reason.length >= 1 &&
      reason.length <= 160 &&
      reason.trim() === reason &&
      !/[\u0000-\u001F\u007F]/.test(reason))
  );
}

/** Input schema validation only. The server validates expiry against its own clock. */
export function assertModelAPaymentIntentInput(
  input: unknown
): asserts input is ModelAPaymentIntentInput {
  if (!intentInput(input)) {
    throw new TypeError(
      "Invalid Model A payment intent (canonical fields required)"
    );
  }
}

export function isModelAPaymentIntentAccepted(
  value: unknown,
  requestId: string,
  httpStatus: number
): value is ModelAPaymentIntentAccepted {
  if (!obj(value)) return false;
  return (
    (httpStatus === 202 || httpStatus === 200) &&
    value.requestId === requestId &&
    value.status === "received" &&
    typeof value.duplicate === "boolean" &&
    value.duplicate === (httpStatus === 200) &&
    value.network === "devnet" &&
    publicKey(value.vault) &&
    value.notice === INTENT_NOTICE
  );
}

export function isStoredModelAPaymentIntent(
  value: unknown,
  requestId: string
): value is StoredModelAPaymentIntent {
  if (!obj(value) || !intentInput(value.request)) return false;
  return (
    value.version === 1 &&
    value.kind === "model-a-payment-intent" &&
    value.status === "received" &&
    value.network === "devnet" &&
    publicKey(value.vault) &&
    typeof value.principalId === "string" &&
    PRINCIPAL.test(value.principalId) &&
    typeof value.createdAtUnix === "number" &&
    Number.isSafeInteger(value.createdAtUnix) &&
    value.createdAtUnix >= 0 &&
    value.request.requestId === requestId
  );
}
