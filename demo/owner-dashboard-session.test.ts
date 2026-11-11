import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createOwnerDashboardSessionHandler } from "./owner-dashboard-session";

const frontendOrigin = "http://127.0.0.1:5173";
const upstreamOrigin = "http://127.0.0.1:8787";
const owner = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const stranger = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
const ownerPublicKey = new PublicKey(owner.publicKey).toBase58();
const vaultPublicKey = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const secret = "OWNER_TEST_SECRET_MUST_NOT_LEAK_".repeat(3);

async function withGateway(run: (app: {
  base: string;
  upstreamCalls: { url: string; auth: string | null }[];
  setNow: (value: number) => void;
}) => Promise<void>) {
  const upstreamCalls: { url: string; auth: string | null }[] = [];
  let timestamp = 1_800_000_000_000;
  const server = createServer(createOwnerDashboardSessionHandler({
    apiHandler: (_req, res) => { res.writeHead(404).end(); },
    ownerPublicKey, vaultPublicKey, ownerApiToken: secret,
    frontendOrigin, upstreamOrigin,
    now: () => timestamp,
    upstreamFetch: async (input, init) => {
      const request = new Request(input, init);
      upstreamCalls.push({ url: request.url, auth: request.headers.get("authorization") });
      return new Response(JSON.stringify({ network: "devnet", balanceBaseUnits: "123" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    await run({ base: `http://127.0.0.1:${port}`, upstreamCalls, setNow: (value) => { timestamp = value; } });
  } finally {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }
}

async function challenge(base: string) {
  const res = await fetch(base + "/dashboard/auth/challenge");
  assert.equal(res.status, 200);
  return await res.json() as { nonce: string; message: string; ownerPublicKey: string; expiresAt: number };
}

function signedLogin(ch: Awaited<ReturnType<typeof challenge>>, signer = owner, publicKey = ownerPublicKey) {
  return { nonce: ch.nonce, publicKey, signature: Buffer.from(nacl.sign.detached(Buffer.from(ch.message), signer.secretKey)).toString("base64") };
}

async function login(base: string, payload: unknown, origin = frontendOrigin) {
  return fetch(base + "/dashboard/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(payload),
  });
}

function getCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "session cookie issued");
  return value.split(";")[0];
}

test("anonymous dashboard reads are denied and do not call the upstream API", async () => {
  await withGateway(async ({ base, upstreamCalls }) => {
    const response = await fetch(base + "/dashboard/api/treasury");
    assert.equal(response.status, 401);
    assert.equal(upstreamCalls.length, 0);
    assert.deepEqual(await (await fetch(base + "/dashboard/auth/session")).json(), { authenticated: false });
  });
});

test("owner wallet proves possession and receives HttpOnly short-lived cookie", async () => {
  await withGateway(async ({ base, upstreamCalls }) => {
    const ch = await challenge(base);
    assert.equal(ch.ownerPublicKey, ownerPublicKey);
    assert.match(ch.message, /not a payment approval/);
    assert.match(ch.message, new RegExp(vaultPublicKey));
    const result = await login(base, signedLogin(ch));
    assert.equal(result.status, 200);
    const cookie = getCookie(result);
    assert.match(result.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict; Path=\/dashboard; Max-Age=900/);
    assert.equal((await (await fetch(base + "/dashboard/auth/session", { headers: { Cookie: cookie } })).json()).authenticated, true);
    const treasury = await fetch(base + "/dashboard/api/treasury", { headers: { Cookie: cookie } });
    assert.equal(treasury.status, 200);
    assert.equal((await treasury.json()).balanceBaseUnits, "123");
    assert.deepEqual(upstreamCalls, [{ url: upstreamOrigin + "/api/treasury", auth: `Bearer ${secret}` }]);
    assert.ok(!JSON.stringify(await result.clone().json()).includes(secret));
  });
});

test("invalid signature consumes challenge; replayed signatures fail", async () => {
  await withGateway(async ({ base }) => {
    const ch = await challenge(base);
    assert.equal((await login(base, signedLogin(ch, stranger))).status, 401);
    assert.equal((await login(base, signedLogin(ch))).status, 401);
    const ch2 = await challenge(base);
    assert.equal((await login(base, signedLogin(ch2, owner, new PublicKey(stranger.publicKey).toBase58()))).status, 401);
  });
});

test("expired challenges and sessions fail closed", async () => {
  await withGateway(async ({ base, setNow }) => {
    const ch = await challenge(base);
    setNow(ch.expiresAt + 1);
    assert.equal((await login(base, signedLogin(ch))).status, 401);
    const ch2 = await challenge(base);
    const loggedIn = await login(base, signedLogin(ch2));
    assert.equal(loggedIn.status, 200);
    const cookie = getCookie(loggedIn);
    setNow(ch2.expiresAt + 16 * 60_000);
    assert.equal((await fetch(base + "/dashboard/api/agents", { headers: { Cookie: cookie } })).status, 401);
  });
});

test("cross-origin login is denied even with valid signature", async () => {
  await withGateway(async ({ base }) => {
    const ch = await challenge(base);
    assert.equal((await login(base, signedLogin(ch), "https://evil.example")).status, 403);
  });
});

test("owner session is scoped to allowlisted GET reads, never writes, keys, or arbitrary paths", async () => {
  await withGateway(async ({ base, upstreamCalls }) => {
    const ch = await challenge(base);
    const cookie = getCookie(await login(base, signedLogin(ch)));
    const headers = { Cookie: cookie };
    assert.equal((await fetch(base + "/dashboard/api/workflows/abc12345", { headers })).status, 200);
    assert.equal((await fetch(base + "/dashboard/api/keys", { headers })).status, 404);
    assert.equal((await fetch(base + "/dashboard/api/treasury?owner=other", { headers })).status, 404);
    assert.equal((await fetch(base + "/dashboard/api/treasury", { method: "POST", headers })).status, 405);
    assert.equal(upstreamCalls.length, 1);
  });
});

test("logout revokes the session immediately", async () => {
  await withGateway(async ({ base }) => {
    const ch = await challenge(base);
    const cookie = getCookie(await login(base, signedLogin(ch)));
    const result = await fetch(base + "/dashboard/auth/logout", {
      method: "POST", headers: { Origin: frontendOrigin, Cookie: cookie },
    });
    assert.equal(result.status, 200);
    assert.match(result.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await fetch(base + "/dashboard/api/activity", { headers: { Cookie: cookie } })).status, 401);
  });
});

test("session cookies cannot be duplicated to confuse authentication", async () => {
  await withGateway(async ({ base, upstreamCalls }) => {
    const ch = await challenge(base);
    const cookie = getCookie(await login(base, signedLogin(ch)));
    const response = await fetch(base + "/dashboard/api/treasury", {
      headers: { Cookie: `${cookie}; ${cookie}` },
    });
    assert.equal(response.status, 401);
    assert.equal(upstreamCalls.length, 0);
  });
});
