
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  getApiKeyStatus,
  type DeveloperApiKeyRecord,
} from "./api-key-model";

const KEY_PREFIX = "avk";
const KEY_ID_BYTES = 12;
const KEY_SECRET_BYTES = 32;

const KEY_PATTERN = /^avk_([a-f0-9]{24})_([a-f0-9]{64})$/;

export function generateDeveloperApiKey(): string {
  const keyId = randomBytes(KEY_ID_BYTES).toString("hex");
  const secret = randomBytes(KEY_SECRET_BYTES).toString("hex");

  return `${KEY_PREFIX}_${keyId}_${secret}`;
}

export function extractDeveloperApiKeyId(
  token: string
): string | null {
  return KEY_PATTERN.exec(token)?.[1] ?? null;
}

export function hashDeveloperApiKey(
  token: string
): string {
  return createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}

export function verifyDeveloperApiKey(
  token: string,
  record: DeveloperApiKeyRecord,
  now: number
): boolean {
  if (getApiKeyStatus(record, now) !== "active") {
    return false;
  }

  const keyId = extractDeveloperApiKeyId(token);

  if (!keyId || keyId !== record.keyId) {
    return false;
  }

  if (!/^[a-f0-9]{64}$/.test(record.tokenHash)) {
    return false;
  }

  const providedHash = Buffer.from(
    hashDeveloperApiKey(token),
    "hex"
  );

  const expectedHash = Buffer.from(
    record.tokenHash,
    "hex"
  );

  return timingSafeEqual(providedHash, expectedHash);
}
