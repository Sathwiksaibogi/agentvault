/**
 * Local Devnet owner-session credential management.
 * A signed dashboard login alone never authorizes issue/revoke. The server
 * prepares an action-bound challenge, which this client validates before
 * asking the owner wallet to sign the exact returned bytes.
 */
export const CREDENTIAL_PATH = "/owner-vault/api/developer-keys";
export type CredentialScope = "activity:read" | "payments:request";
export type CredentialAction =
  | {
      action: "issue";
      principalId: string;
      scope: CredentialScope;
      expiresAt: number;
    }
  | { action: "revoke"; keyId: string };
export type CredentialMetadata = {
  keyId: string;
  principalId: string;
  vaults: string[];
  scopes: CredentialScope[];
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
};
export type IssuedCredential = {
  keyId: string;
  token: string;
  vault: string;
  scope: CredentialScope;
};
export type CredentialWallet = {
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<unknown>;
  signMessage(
    message: Uint8Array,
    encoding?: "utf8"
  ): Promise<{ signature: Uint8Array }>;
};
export type OwnerCredentialContext = {
  owner: string;
  vault: string;
  origin: string;
  wallet: CredentialWallet;
  fetchImpl?: typeof fetch;
  now?: () => number;
};
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const KEY_ID = /^[a-f0-9]{24}$/;
const NONCE = /^[a-f0-9]{48}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DAY = 24 * 60 * 60 * 1000;

export function validApplicationId(value: string): boolean {
  return ID.test(value);
}

async function jsonRequest<T>(
  request: typeof fetch,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await request(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Credential request failed (HTTP ${response.status})`);
  }
  // Do not log responses: successful issuance contains the one-time secret.
  return (await response.json()) as T;
}

export async function listCredentials(
  principalId: string,
  request: typeof fetch = fetch
): Promise<CredentialMetadata[]> {
  if (!validApplicationId(principalId))
    throw new Error("Invalid application ID");
  const result = await jsonRequest<{ keys: CredentialMetadata[] }>(
    request,
    `${CREDENTIAL_PATH}?${new URLSearchParams({ principalId })}`
  );
  if (!result || !Array.isArray(result.keys))
    throw new Error("Invalid credential listing");
  // Metadata only: fail closed if a server regression accidentally exposes secrets.
  if (
    result.keys.some(
      (key) => !key || "token" in key || key.principalId !== principalId
    )
  ) {
    throw new Error("Unsafe credential listing response");
  }
  return result.keys;
}

export function assertCredentialChallenge(
  challenge: { nonce: string; message: string; expiresAt: number },
  context: Pick<OwnerCredentialContext, "owner" | "vault" | "origin">,
  action: CredentialAction,
  now: number
): void {
  if (
    !challenge ||
    typeof challenge.message !== "string" ||
    !NONCE.test(challenge.nonce) ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    challenge.expiresAt <= now ||
    challenge.expiresAt > now + 90_000 ||
    context.origin !== "http://127.0.0.1:5173"
  ) {
    throw new Error("Invalid or expired credential challenge");
  }
  const lines = challenge.message.split("\n");
  const expected = [
    "AgentVault Developer Credential Authorization v1",
    "Network: devnet",
    // Genesis and session are server-generated but must have valid shapes.
    lines[2],
    `Origin: ${context.origin}`,
    `Owner: ${context.owner}`,
    `Vault: ${context.vault}`,
    lines[6],
    `Action: ${action.action === "issue" ? "ISSUE" : "REVOKE"}`,
    ...(action.action === "issue"
      ? [
          `Application: ${action.principalId}`,
          `Scope: ${action.scope}`,
          `CredentialExpiresAtMs: ${action.expiresAt}`,
        ]
      : [`KeyId: ${action.keyId}`]),
    `Nonce: ${challenge.nonce}`,
    `ChallengeExpiresAtMs: ${challenge.expiresAt}`,
    "Purpose: authorize this API credential action only; not a payment approval or transaction",
  ];
  if (
    !/^Genesis: [A-Za-z0-9]{10,100}$/.test(lines[2] ?? "") ||
    !SHA256.test((lines[6] ?? "").replace(/^Session: /, "")) ||
    !lines[6]?.startsWith("Session: ") ||
    lines.length !== expected.length ||
    !expected.every((line, index) => lines[index] === line)
  ) {
    throw new Error(
      "Credential challenge does not match the authorized action"
    );
  }
}

/** The caller must deliberately confirm the action in its UI before invoking. */
export async function authorizeCredentialAction(
  context: OwnerCredentialContext,
  action: CredentialAction
): Promise<IssuedCredential | { revoked: true }> {
  const now = context.now ?? Date.now;
  const request = context.fetchImpl ?? fetch;
  if (
    !context.owner ||
    !context.vault ||
    context.origin !== "http://127.0.0.1:5173"
  ) {
    throw new Error("Local Devnet owner session required");
  }
  if (action.action === "issue") {
    if (
      !validApplicationId(action.principalId) ||
      (action.scope !== "activity:read" &&
        action.scope !== "payments:request") ||
      !Number.isSafeInteger(action.expiresAt) ||
      action.expiresAt <= now() + 60_000 ||
      action.expiresAt > now() + DAY
    )
      throw new Error("Invalid credential grant");
  } else if (!KEY_ID.test(action.keyId)) {
    throw new Error("Invalid credential key ID");
  }
  await context.wallet.connect();
  if (context.wallet.publicKey?.toBase58() !== context.owner) {
    throw new Error("Phantom wallet does not match the signed-in vault owner");
  }
  const challenge = await jsonRequest<{
    nonce: string;
    message: string;
    expiresAt: number;
  }>(request, `${CREDENTIAL_PATH}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  assertCredentialChallenge(challenge, context, action, now());
  if (typeof context.wallet.signMessage !== "function") {
    throw new Error("Wallet cannot sign an authorization message");
  }
  const signed = await context.wallet.signMessage(
    new TextEncoder().encode(challenge.message),
    "utf8"
  );
  if (
    !(signed?.signature instanceof Uint8Array) ||
    signed.signature.length !== 64
  ) {
    throw new Error("Wallet returned an invalid signature");
  }
  const signature = btoa(String.fromCharCode(...signed.signature));
  const result = await jsonRequest<IssuedCredential | { revoked: true }>(
    request,
    `${CREDENTIAL_PATH}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: challenge.nonce, signature }),
    }
  );
  if (action.action === "issue") {
    const issued = result as IssuedCredential;
    if (
      !issued ||
      typeof issued.token !== "string" ||
      !issued.token ||
      !KEY_ID.test(issued.keyId) ||
      issued.vault !== context.vault ||
      issued.scope !== action.scope
    ) {
      throw new Error("Unexpected credential issuance response");
    }
    return issued;
  }
  if ((result as { revoked?: boolean })?.revoked !== true) {
    throw new Error("Unexpected credential revocation response");
  }
  return { revoked: true };
}
