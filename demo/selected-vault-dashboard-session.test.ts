import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createSelectedVaultSessionHandler, type SelectedVaultRpc } from "./selected-vault-dashboard-session";

const FRONTEND = "http://127.0.0.1:5173";
const GENESIS = "test-devnet-genesis";
const PROGRAM = new PublicKey("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

type Fixture = {
  signer: ReturnType<typeof nacl.sign.keyPair.fromSeed>;
  owner: string;
  vault: string;
  mint: string;
  treasury: string;
  vaultInfo: AccountInfo<Buffer>;
  treasuryInfo: AccountInfo<Buffer>;
  mintInfo: AccountInfo<Buffer>;
};
function makeFixture(seedByte: number, id: number, balance: number): Fixture {
  const signer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
  const ownerKey = new PublicKey(signer.publicKey);
  const mint = new PublicKey(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte + 10)).publicKey);
  const u64 = Buffer.alloc(8);
  u64.writeBigUInt64LE(BigInt(id));
  const [vault, bump] = PublicKey.findProgramAddressSync([
    Buffer.from("vault"), ownerKey.toBuffer(), u64,
  ], PROGRAM);
  const [treasury] = PublicKey.findProgramAddressSync([
    vault.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer(),
  ], ATA);
  const vaultData = Buffer.alloc(90);
  createHash("sha256").update("account:Vault").digest().copy(vaultData, 0, 0, 8);
  ownerKey.toBuffer().copy(vaultData, 8);
  mint.toBuffer().copy(vaultData, 40);
  vaultData.writeBigUInt64LE(BigInt(id), 72);
  vaultData.writeBigUInt64LE(BigInt(250_000), 80);
  vaultData[89] = bump;
  const tokenData = Buffer.alloc(165);
  mint.toBuffer().copy(tokenData, 0);
  vault.toBuffer().copy(tokenData, 32);
  tokenData.writeBigUInt64LE(BigInt(balance), 64);
  tokenData[108] = 1;
  const mintData = Buffer.alloc(82);
  mintData[44] = 6;
  mintData[45] = 1;
  function account(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
    return { owner, data, lamports: 1_000_000, executable: false, rentEpoch: 0 };
  }
  return {
    signer,
    owner: ownerKey.toBase58(),
    vault: vault.toBase58(),
    mint: mint.toBase58(),
    treasury: treasury.toBase58(),
    vaultInfo: account(vaultData, PROGRAM),
    treasuryInfo: account(tokenData, TOKEN_PROGRAM),
    mintInfo: account(mintData, TOKEN_PROGRAM),
  };
}

type Context = {
  base: string;
  a: Fixture;
  b: Fixture;
  setNow: (time: number) => void;
  setGenesis: (hash: string) => void;
  fallbackCalls: () => number;
};
async function withServer(run: (ctx: Context) => Promise<void>, network: "devnet" | "localnet" = "devnet") {
  const a = makeFixture(7, 8001, 1_000_000);
  const b = makeFixture(8, 8002, 5_000_000);
  const lookup = new Map<string, AccountInfo<Buffer>>([
    [a.vault, a.vaultInfo], [a.treasury, a.treasuryInfo], [a.mint, a.mintInfo],
    [b.vault, b.vaultInfo], [b.treasury, b.treasuryInfo], [b.mint, b.mintInfo],
  ]);
  let timestamp = 1_800_000_000_000;
  let genesis = GENESIS;
  let fallbackCount = 0;
  const rpc: SelectedVaultRpc = {
    async getGenesisHash() { return genesis; },
    async getAccountInfo(address, commitment) {
      assert.equal(commitment, "confirmed");
      return lookup.get(address.toBase58()) ?? null;
    },
  };
  const handler = createSelectedVaultSessionHandler({
    rpc, network, expectedGenesisHash: GENESIS, frontendOrigin: FRONTEND,
    readScopedAgents: async (verified) => ({
      network: "devnet", owner: verified.owner, vault: verified.vault,
      agents: [],
    }),
    now: () => timestamp,
    fallbackHandler: (_req, res) => {
      fallbackCount++;
      res.writeHead(418).end();
    },
  });
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await run({
      base, a, b,
      setNow: (time: number) => { timestamp = time; },
      setGenesis: (hash: string) => { genesis = hash; },
      fallbackCalls: () => fallbackCount,
    });
  } finally {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }
}

async function getChallenge(ctx: Context, f: Fixture) {
  const response = await fetch(`${ctx.base}/owner-vault/auth/challenge?owner=${f.owner}&vault=${f.vault}`);
  return { status: response.status, value: await response.json() as {
    nonce: string; message: string; ownerPublicKey: string; vaultPublicKey: string;
  } };
}
function signed(ch: Awaited<ReturnType<typeof getChallenge>>["value"], f: Fixture) {
  return {
    nonce: ch.nonce, publicKey: f.owner, vault: f.vault,
    signature: Buffer.from(nacl.sign.detached(Buffer.from(ch.message), f.signer.secretKey)).toString("base64"),
  };
}
async function login(ctx: Context, body: unknown, origin = FRONTEND) {
  return fetch(`${ctx.base}/owner-vault/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function extractCookie(response: Response): string {
  const raw = response.headers.get("set-cookie");
  assert.ok(raw);
  assert.match(raw, /HttpOnly; SameSite=Strict; Path=\/owner-vault; Max-Age=900/);
  return raw.split(";")[0];
}
async function loginOwner(ctx: Context, f: Fixture) {
  const challenge = await getChallenge(ctx, f);
  assert.equal(challenge.status, 200);
  const response = await login(ctx, signed(challenge.value, f));
  assert.equal(response.status, 200);
  return extractCookie(response);
}

const read = (ctx: Context, path: string, cookie?: string, method = "GET") =>
  fetch(`${ctx.base}${path}`, { method, headers: cookie ? { Cookie: cookie } : {} });

test("signed owner A sees only on-chain verified treasury A", async () => {
  await withServer(async (ctx) => {
    assert.equal((await read(ctx, "/owner-vault/api/treasury")).status, 401);
    const ch = await getChallenge(ctx, ctx.a);
    assert.match(ch.value.message, /not a payment approval/);
    assert.match(ch.value.message, new RegExp(ctx.a.vault));
    assert.match(ch.value.message, /Genesis: test-devnet-genesis/);
    const loginResult = await login(ctx, signed(ch.value, ctx.a));
    assert.equal(loginResult.status, 200);
    const cookie = extractCookie(loginResult);
    const status = await read(ctx, "/owner-vault/auth/session", cookie);
    assert.deepEqual(await status.json(), {
      authenticated: true, owner: ctx.a.owner, vault: ctx.a.vault,
    });
    const data = await read(ctx, "/owner-vault/api/treasury", cookie);
    assert.equal(data.status, 200);
    assert.deepEqual(await data.json(), {
      network: "devnet", vault: ctx.a.vault, owner: ctx.a.owner,
      tokenMint: ctx.a.mint, treasury: ctx.a.treasury, vaultId: "8001",
      decimals: 6, paused: false, balanceBaseUnits: "1000000",
      reservedBaseUnits: "250000", availableBaseUnits: "750000",
    });
    assert.equal(ctx.fallbackCalls(), 0);
  });
});

test("vault A session cannot select vault B, and B signs in to its own data", async () => {
  await withServer(async (ctx) => {
    const cookieA = await loginOwner(ctx, ctx.a);
    assert.equal((await read(ctx, `/owner-vault/api/treasury?vault=${ctx.b.vault}`, cookieA)).status, 404);
    const agentsA = await read(ctx, "/owner-vault/api/agents", cookieA);
    assert.equal(agentsA.status, 200);
    assert.deepEqual(await agentsA.json(), {
      network: "devnet", owner: ctx.a.owner, vault: ctx.a.vault, agents: [],
    });
    assert.equal((await read(ctx, "/owner-vault/api/agents", cookieA, "POST")).status, 405);
    assert.equal((await read(ctx, `/owner-vault/api/agents?vault=${ctx.b.vault}`, cookieA)).status, 404);
    const result = await read(ctx, "/owner-vault/api/treasury", cookieA);
    assert.equal((await result.json()).owner, ctx.a.owner);
    const cookieB = await loginOwner(ctx, ctx.b);
    const dataB = await read(ctx, "/owner-vault/api/treasury", cookieB);
    assert.equal((await dataB.json()).owner, ctx.b.owner);
    const agentsB = await read(ctx, "/owner-vault/api/agents", cookieB);
    assert.deepEqual(await agentsB.json(), {
      network: "devnet", owner: ctx.b.owner, vault: ctx.b.vault, agents: [],
    });
    assert.equal(ctx.fallbackCalls(), 0);
  });
});

test("a wallet cannot request a challenge for another owner's vault", async () => {
  await withServer(async (ctx) => {
    const res = await read(ctx,
      `/owner-vault/auth/challenge?owner=${ctx.a.owner}&vault=${ctx.b.vault}`);
    assert.equal(res.status, 403);
    assert.equal((await getChallenge(ctx, ctx.a)).status, 200);
  });
});

test("wrong signature is consumed; replay, wrong key and vault substitution fail", async () => {
  await withServer(async (ctx) => {
    const ch = await getChallenge(ctx, ctx.a);
    const invalid = signed(ch.value, ctx.a);
    invalid.signature = signed(ch.value, ctx.b).signature;
    assert.equal((await login(ctx, invalid)).status, 401);
    assert.equal((await login(ctx, signed(ch.value, ctx.a))).status, 401);
    const other = await getChallenge(ctx, ctx.a);
    const changed = signed(other.value, ctx.a);
    changed.vault = ctx.b.vault;
    assert.equal((await login(ctx, changed)).status, 401);
  });
});

test("fails closed on genesis mismatch or invalidated treasury after login", async () => {
  await withServer(async (ctx) => {
    const cookie = await loginOwner(ctx, ctx.a);
    ctx.setGenesis("another-chain");
    assert.equal((await read(ctx, "/owner-vault/api/treasury", cookie)).status, 503);
    assert.equal((await read(ctx, "/owner-vault/api/agents", cookie)).status, 503);
    assert.equal((await getChallenge(ctx, ctx.b)).status, 403);
    ctx.setGenesis(GENESIS);
    ctx.a.treasuryInfo.data[32] ^= 1;
    assert.equal((await read(ctx, "/owner-vault/api/treasury", cookie)).status, 503);
    assert.equal((await read(ctx, "/owner-vault/api/agents", cookie)).status, 503);
  });
});

test("rejects cross-origin logins, unknown routes and write requests", async () => {
  await withServer(async (ctx) => {
    const ch = await getChallenge(ctx, ctx.a);
    assert.equal((await login(ctx, signed(ch.value, ctx.a), "https://evil.example")).status, 403);
    const cookie = await loginOwner(ctx, ctx.a);
    assert.equal((await read(ctx, "/owner-vault/api/treasury", cookie, "POST")).status, 405);
    assert.equal((await read(ctx, "/owner-vault/api/workflows", cookie)).status, 404);
    assert.equal((await read(ctx, "/owner-vault/auth/challenge?wrong=1", cookie)).status, 400);
    assert.equal(ctx.fallbackCalls(), 0);
  });
});

test("cookie expiry, logout and duplicate cookie checks", async () => {
  await withServer(async (ctx) => {
    const cookie = await loginOwner(ctx, ctx.a);
    assert.equal((await read(ctx, "/owner-vault/api/treasury", `${cookie}; ${cookie}`)).status, 401);
    const logout = await fetch(`${ctx.base}/owner-vault/auth/logout`, {
      method: "POST", headers: { Origin: FRONTEND, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((await read(ctx, "/owner-vault/api/treasury", cookie)).status, 401);
    const second = await loginOwner(ctx, ctx.a);
    ctx.setNow(1_800_000_000_000 + 16 * 60_000);
    assert.equal((await read(ctx, "/owner-vault/api/treasury", second)).status, 401);
  });
});

test("localnet never permits selected-vault sessions", async () => {
  await withServer(async (ctx) => {
    assert.equal((await getChallenge(ctx, ctx.a)).status, 403);
  }, "localnet");
});
