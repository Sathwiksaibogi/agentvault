import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeCredentialAction,
  assertCredentialChallenge,
  listCredentials,
  validApplicationId,
} from "../src/developer-credentials.ts";

const owner = "CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc";
const vault = "C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep";
const origin = "http://127.0.0.1:5173";
const now = 1_800_000_000_000;
const nonce = "a".repeat(48);
const keyId = "a".repeat(24);
const scope = "payments:request";
const action = {
  action: "issue",
  principalId: "research-agent",
  scope,
  expiresAt: now + 3_600_000,
};
function challenge(actionValue = action) {
  const expiresAt = now + 90_000;
  const message = [
    "AgentVault Developer Credential Authorization v1",
    "Network: devnet",
    `Genesis: ${"z".repeat(40)}`,
    `Origin: ${origin}`,
    `Owner: ${owner}`,
    `Vault: ${vault}`,
    `Session: ${"f".repeat(64)}`,
    `Action: ${actionValue.action === "issue" ? "ISSUE" : "REVOKE"}`,
    ...(actionValue.action === "issue"
      ? [
          `Application: ${actionValue.principalId}`,
          `Scope: ${actionValue.scope}`,
          `CredentialExpiresAtMs: ${actionValue.expiresAt}`,
        ]
      : [`KeyId: ${actionValue.keyId}`]),
    `Nonce: ${nonce}`,
    `ChallengeExpiresAtMs: ${expiresAt}`,
    "Purpose: authorize this API credential action only; not a payment approval or transaction",
  ].join("\n");
  return { nonce, message, expiresAt };
}
function mockRequest(actionValue = action) {
  const requests = [];
  const fetchImpl = async (path, init) => {
    requests.push({ path, init });
    if (path.endsWith("/challenge"))
      return Response.json(challenge(actionValue));
    if (path.endsWith("/confirm"))
      return Response.json(
        actionValue.action === "issue"
          ? { keyId, token: "avk_test_secret_which_is_not_real", vault, scope }
          : { revoked: true }
      );
    return Response.json({ keys: [] });
  };
  return { requests, fetchImpl };
}
function makeContext(fetchImpl, opts = {}) {
  const calls = [];
  const wallet = {
    publicKey: { toBase58: () => opts.walletOwner ?? owner },
    async connect() {
      calls.push("connect");
    },
    async signMessage(bytes, encoding) {
      calls.push({ message: new TextDecoder().decode(bytes), encoding });
      return { signature: new Uint8Array(64).fill(5) };
    },
  };
  return {
    context: { owner, vault, origin, wallet, fetchImpl, now: () => now },
    calls,
  };
}

test("validates constrained application IDs", () => {
  assert.equal(validApplicationId("research-agent"), true);
  for (const invalid of ["ab", " leading", "test.dot", "", "a".repeat(65)]) {
    assert.equal(validApplicationId(invalid), false);
  }
});

test("accepts exact server action-specific message", () => {
  assert.doesNotThrow(() =>
    assertCredentialChallenge(
      challenge(),
      { owner, vault, origin },
      action,
      now
    )
  );
});

test("rejects changed owner, vault, scope, app, nonce, purpose, and expiry without signing", () => {
  const original = challenge();
  const cases = [
    {
      ...original,
      message: original.message.replace(
        `Owner: ${owner}`,
        "Owner: someoneelse"
      ),
    },
    {
      ...original,
      message: original.message.replace(`Vault: ${vault}`, "Vault: fake"),
    },
    {
      ...original,
      message: original.message.replace(
        "Scope: payments:request",
        "Scope: activity:read"
      ),
    },
    {
      ...original,
      message: original.message.replace(
        "Application: research-agent",
        "Application: bad-agent"
      ),
    },
    { ...original, nonce: "b".repeat(48) },
    {
      ...original,
      message: original.message.replace(
        "not a payment approval",
        "payment approval"
      ),
    },
    { ...original, expiresAt: now - 1 },
    { ...original, message: original.message + "\nExtra: unauthorized" },
  ];
  for (const value of cases) {
    assert.throws(() =>
      assertCredentialChallenge(value, { owner, vault, origin }, action, now)
    );
  }
});

test("issues with two authenticated POSTs and signs exact challenge message", async () => {
  const { requests, fetchImpl } = mockRequest();
  const { context, calls } = makeContext(fetchImpl);
  const result = await authorizeCredentialAction(context, action);
  assert.deepEqual(result, {
    keyId,
    token: "avk_test_secret_which_is_not_real",
    vault,
    scope,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].path.endsWith("/challenge"), true);
  assert.equal(requests[1].path.endsWith("/confirm"), true);
  assert.equal(requests[0].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(requests[0].init.body), action);
  const confirmed = JSON.parse(requests[1].init.body);
  assert.deepEqual(Object.keys(confirmed).sort(), ["nonce", "signature"]);
  assert.equal(confirmed.nonce, nonce);
  assert.equal(Buffer.from(confirmed.signature, "base64").length, 64);
  assert.deepEqual(calls, [
    "connect",
    { message: challenge().message, encoding: "utf8" },
  ]);
});

test("revocation signs the key ID and does not reveal a token", async () => {
  const revoke = { action: "revoke", keyId };
  const { requests, fetchImpl } = mockRequest(revoke);
  const { context } = makeContext(fetchImpl);
  const result = await authorizeCredentialAction(context, revoke);
  assert.deepEqual(result, { revoked: true });
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0].init.body), revoke);
});

test("wallet mismatch rejects before HTTP or signature", async () => {
  const { requests, fetchImpl } = mockRequest();
  const { context, calls } = makeContext(fetchImpl, {
    walletOwner: "wrong-owner",
  });
  await assert.rejects(
    () => authorizeCredentialAction(context, action),
    /does not match/
  );
  assert.equal(requests.length, 0);
  assert.deepEqual(calls, ["connect"]);
});

test("mismatched challenge refuses to sign or confirm", async () => {
  const { context, calls } = makeContext(async () =>
    Response.json({ ...challenge(), message: "Forged" })
  );
  await assert.rejects(
    () => authorizeCredentialAction(context, action),
    /does not match/
  );
  assert.deepEqual(calls, ["connect"]);
});

test("invalid input fails before Phantom connect", async () => {
  const { fetchImpl } = mockRequest();
  const { context, calls } = makeContext(fetchImpl);
  await assert.rejects(
    () =>
      authorizeCredentialAction(context, { ...action, principalId: "bad id" }),
    /Invalid/
  );
  await assert.rejects(
    () =>
      authorizeCredentialAction(context, { action: "revoke", keyId: "ABC" }),
    /Invalid/
  );
  await assert.rejects(
    () =>
      authorizeCredentialAction(context, {
        ...action,
        expiresAt: now + 2 * 86_400_000,
      }),
    /Invalid/
  );
  assert.deepEqual(calls, []);
});

test("metadata list requires app ID and does not return secrets", async () => {
  const calls = [];
  const fetchImpl = async (path, init) => {
    calls.push({ path, init });
    return Response.json({
      keys: [{ keyId, principalId: "research-agent", scopes: [scope] }],
    });
  };
  const result = await listCredentials("research-agent", fetchImpl);
  assert.equal(result.length, 1);
  assert.match(calls[0].path, /principalId=research-agent/);
  assert.equal(calls[0].init.credentials, "same-origin");
  await assert.rejects(() => listCredentials("bad id", fetchImpl), /Invalid/);
  await assert.rejects(
    () =>
      listCredentials("research-agent", async () =>
        Response.json({
          keys: [{ principalId: "research-agent", token: "oops" }],
        })
      ),
    /Unsafe/
  );
});

test("server HTTP rejection does not accidentally surface a token", async () => {
  const { context } = makeContext(
    async () =>
      new Response(JSON.stringify({ token: "DO_NOT_SHOW" }), { status: 403 })
  );
  await assert.rejects(
    () => authorizeCredentialAction(context, action),
    (err) => {
      assert.match(err.message, /HTTP 403/);
      assert.doesNotMatch(err.message, /DO_NOT_SHOW/);
      return true;
    }
  );
});
