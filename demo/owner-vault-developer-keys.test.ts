import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import nacl from "tweetnacl";
import { InMemoryDeveloperApiKeyRepository } from "./api-key-memory-repository";
import { createSelectedVaultSessionHandler } from "./selected-vault-dashboard-session";

const ORIGIN = "http://127.0.0.1:5173";
const GENESIS = "test-devnet-genesis";
const PROGRAM = new PublicKey("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");
const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

type Fixture = {
  owner: string;
  vault: string;
  signer: ReturnType<typeof nacl.sign.keyPair.fromSeed>;
};
function makeFixture(seed: number, id: number) {
  const signer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
  const owner = new PublicKey(signer.publicKey);
  const mint = new PublicKey(
    nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed + 10)).publicKey
  );
  const idBuffer = Buffer.alloc(8);
  idBuffer.writeBigUInt64LE(BigInt(id));
  const [vault, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), idBuffer],
    PROGRAM
  );
  const [treasury] = PublicKey.findProgramAddressSync(
    [vault.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA
  );
  const vaultData = Buffer.alloc(90);
  createHash("sha256")
    .update("account:Vault")
    .digest()
    .copy(vaultData, 0, 0, 8);
  owner.toBuffer().copy(vaultData, 8);
  mint.toBuffer().copy(vaultData, 40);
  vaultData.writeBigUInt64LE(BigInt(id), 72);
  vaultData.writeBigUInt64LE(250_000n, 80);
  vaultData[89] = bump;
  const treasuryData = Buffer.alloc(165);
  mint.toBuffer().copy(treasuryData, 0);
  vault.toBuffer().copy(treasuryData, 32);
  treasuryData.writeBigUInt64LE(1_000_000n, 64);
  treasuryData[108] = 1;
  const account = (data: Buffer, program: PublicKey): AccountInfo<Buffer> => ({
    data,
    owner: program,
    executable: false,
    rentEpoch: 0,
    lamports: 10_000_000,
  });
  const records: [string, AccountInfo<Buffer>][] = [
    [vault.toBase58(), account(vaultData, PROGRAM)],
    [treasury.toBase58(), account(treasuryData, TOKEN_PROGRAM)],
  ];
  return {
    fixture: {
      owner: owner.toBase58(),
      vault: vault.toBase58(),
      signer,
    } satisfies Fixture,
    records,
    treasuryData,
  };
}

type Context = {
  base: string;
  a: Fixture;
  b: Fixture;
  repo: InMemoryDeveloperApiKeyRepository;
  now: () => number;
  setTime: (v: number) => void;
  setGenesis: (v: string) => void;
  invalidateVault: () => void;
};
async function withServer(
  run: (ctx: Context) => Promise<void>,
  config: { network?: "localnet" | "devnet"; hasRepository?: boolean } = {}
) {
  const a = makeFixture(7, 8001);
  const b = makeFixture(8, 8002);
  const records = new Map([...a.records, ...b.records]);
  const repo = new InMemoryDeveloperApiKeyRepository();
  let timestamp = 1_800_000_000_000;
  let genesis = GENESIS;
  const handler = createSelectedVaultSessionHandler({
    network: config.network ?? "devnet",
    expectedGenesisHash: GENESIS,
    frontendOrigin: ORIGIN,
    developerKeyRepository: config.hasRepository === false ? undefined : repo,
    fallbackHandler: (_req, res) => {
      res.writeHead(418).end();
    },
    now: () => timestamp,
    rpc: {
      async getGenesisHash() {
        return genesis;
      },
      async getAccountInfo(address, commitment) {
        assert.equal(commitment, "confirmed");
        return records.get(address.toBase58()) ?? null;
      },
    },
  });
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${
    (server.address() as { port: number }).port
  }`;
  try {
    await run({
      base,
      a: a.fixture,
      b: b.fixture,
      repo,
      now: () => timestamp,
      setTime: (time) => {
        timestamp = time;
      },
      setGenesis: (value) => {
        genesis = value;
      },
      invalidateVault: () => {
        a.treasuryData[32] ^= 1;
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(
  ctx: Context,
  path: string,
  body: unknown,
  cookie?: string,
  origin = ORIGIN
) {
  return fetch(`${ctx.base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
function get(ctx: Context, path: string, cookie?: string) {
  return fetch(`${ctx.base}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}
async function login(ctx: Context, f: Fixture): Promise<string> {
  const challenge = await get(
    ctx,
    `/owner-vault/auth/challenge?owner=${f.owner}&vault=${f.vault}`
  );
  assert.equal(challenge.status, 200);
  const value = (await challenge.json()) as { nonce: string; message: string };
  const signature = Buffer.from(
    nacl.sign.detached(Buffer.from(value.message), f.signer.secretKey)
  ).toString("base64");
  const response = await post(ctx, "/owner-vault/auth/login", {
    nonce: value.nonce,
    publicKey: f.owner,
    vault: f.vault,
    signature,
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}
const PATH = "/owner-vault/api/developer-keys";
const ISSUE = {
  action: "issue",
  principalId: "research-agent",
  scope: "payments:request",
};
async function challenge(
  ctx: Context,
  cookie: string,
  body: Record<string, unknown>
) {
  const response = await post(ctx, `${PATH}/challenge`, body, cookie);
  return {
    status: response.status,
    value: (await response.json()) as {
      nonce: string;
      message: string;
      expiresAt: number;
    },
  };
}
function authorize(value: { nonce: string; message: string }, f: Fixture) {
  return {
    nonce: value.nonce,
    signature: Buffer.from(
      nacl.sign.detached(Buffer.from(value.message), f.signer.secretKey)
    ).toString("base64"),
  };
}
async function issue(
  ctx: Context,
  cookie: string,
  f: Fixture,
  principalId = "research-agent"
) {
  const requested = await challenge(ctx, cookie, {
    ...ISSUE,
    principalId,
    expiresAt: ctx.now() + 3_600_000,
  });
  assert.equal(requested.status, 200);
  return post(ctx, `${PATH}/confirm`, authorize(requested.value, f), cookie);
}

test("only a wallet session plus action signature can issue a payment-request key", async () => {
  await withServer(async (ctx) => {
    assert.equal(
      (
        await post(ctx, `${PATH}/challenge`, {
          ...ISSUE,
          expiresAt: ctx.now() + 3_600_000,
        })
      ).status,
      401
    );
    const cookie = await login(ctx, ctx.a);
    const requested = await challenge(ctx, cookie, {
      ...ISSUE,
      expiresAt: ctx.now() + 3_600_000,
    });
    assert.equal(requested.status, 200);
    assert.match(requested.value.message, /Action: ISSUE/);
    assert.match(requested.value.message, /Scope: payments:request/);
    assert.match(requested.value.message, new RegExp(ctx.a.vault));
    const response = await post(
      ctx,
      `${PATH}/confirm`,
      authorize(requested.value, ctx.a),
      cookie
    );
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      keyId: string;
      token: string;
      vault: string;
      scope: string;
    };
    assert.equal(body.vault, ctx.a.vault);
    assert.equal(body.scope, "payments:request");
    assert.match(body.keyId, /^[0-9a-f]{24}$/);
    assert.ok(body.token.length > 32);
    const stored = await ctx.repo.findById(body.keyId);
    assert.equal(stored?.principalId, "research-agent");
    assert.deepEqual(stored?.vaults, [ctx.a.vault]);
    assert.deepEqual(stored?.scopes, ["payments:request"]);
    assert.notEqual(stored?.tokenHash, body.token);
    assert.equal(
      (
        await post(
          ctx,
          `${PATH}/confirm`,
          authorize(requested.value, ctx.a),
          cookie
        )
      ).status,
      401
    );
  });
});

test("owner lists only metadata in their vault, never plaintext or cross-vault keys", async () => {
  await withServer(async (ctx) => {
    const aCookie = await login(ctx, ctx.a);
    const bCookie = await login(ctx, ctx.b);
    assert.equal((await issue(ctx, aCookie, ctx.a)).status, 201);
    const list = await get(ctx, `${PATH}?principalId=research-agent`, aCookie);
    assert.equal(list.status, 200);
    const body = (await list.json()) as { keys: Record<string, unknown>[] };
    assert.equal(body.keys.length, 1);
    assert.ok(!("token" in body.keys[0]));
    assert.ok(!("tokenHash" in body.keys[0]));
    const other = await get(ctx, `${PATH}?principalId=research-agent`, bCookie);
    assert.equal(other.status, 200);
    assert.deepEqual(await other.json(), { keys: [] });
    assert.equal(
      (
        await get(
          ctx,
          `${PATH}?principalId=research-agent&vault=${ctx.b.vault}`,
          aCookie
        )
      ).status,
      400
    );
  });
});

test("revocation requires a fresh explicit owner signature and is irreversible", async () => {
  await withServer(async (ctx) => {
    const cookie = await login(ctx, ctx.a);
    const result = await issue(ctx, cookie, ctx.a);
    assert.equal(result.status, 201);
    const { keyId } = (await result.json()) as { keyId: string };
    const ch = await challenge(ctx, cookie, { action: "revoke", keyId });
    assert.equal(ch.status, 200);
    assert.match(ch.value.message, /Action: REVOKE/);
    const confirmed = await post(
      ctx,
      `${PATH}/confirm`,
      authorize(ch.value, ctx.a),
      cookie
    );
    assert.equal(confirmed.status, 200);
    assert.equal((await ctx.repo.findById(keyId))?.revokedAt, ctx.now());
    assert.equal(
      (await post(ctx, `${PATH}/confirm`, authorize(ch.value, ctx.a), cookie))
        .status,
      401
    );
    const repeat = await challenge(ctx, cookie, { action: "revoke", keyId });
    assert.equal(
      (
        await post(
          ctx,
          `${PATH}/confirm`,
          authorize(repeat.value, ctx.a),
          cookie
        )
      ).status,
      404
    );
  });
});

test("an owner of vault B cannot revoke a key belonging to vault A", async () => {
  await withServer(async (ctx) => {
    const ca = await login(ctx, ctx.a);
    const cb = await login(ctx, ctx.b);
    const issued = await issue(ctx, ca, ctx.a);
    const { keyId } = (await issued.json()) as { keyId: string };
    const ch = await challenge(ctx, cb, { action: "revoke", keyId });
    assert.equal(
      (await post(ctx, `${PATH}/confirm`, authorize(ch.value, ctx.b), cb))
        .status,
      404
    );
    assert.equal((await ctx.repo.findById(keyId))?.revokedAt, null);
  });
});

test("bad signature consumes the challenge, and a different session cannot use it", async () => {
  await withServer(async (ctx) => {
    const ca = await login(ctx, ctx.a);
    const cb = await login(ctx, ctx.b);
    const ch = await challenge(ctx, ca, {
      ...ISSUE,
      expiresAt: ctx.now() + 3_600_000,
    });
    assert.equal(
      (await post(ctx, `${PATH}/confirm`, authorize(ch.value, ctx.b), ca))
        .status,
      401
    );
    assert.equal(
      (await post(ctx, `${PATH}/confirm`, authorize(ch.value, ctx.a), ca))
        .status,
      401
    );
    const ch2 = await challenge(ctx, ca, {
      ...ISSUE,
      expiresAt: ctx.now() + 3_600_000,
    });
    assert.equal(
      (await post(ctx, `${PATH}/confirm`, authorize(ch2.value, ctx.a), cb))
        .status,
      401
    );
    assert.equal(
      (await post(ctx, `${PATH}/confirm`, authorize(ch2.value, ctx.a), ca))
        .status,
      401
    );
  });
});

test("an expired challenge or expired owner session cannot issue a key", async () => {
  await withServer(async (ctx) => {
    const ca = await login(ctx, ctx.a);
    const ch = await challenge(ctx, ca, {
      ...ISSUE,
      expiresAt: ctx.now() + 3_600_000,
    });
    ctx.setTime(ctx.now() + 91_000);
    assert.equal(
      (await post(ctx, `${PATH}/confirm`, authorize(ch.value, ctx.a), ca))
        .status,
      401
    );
    ctx.setTime(ctx.now() + 16 * 60_000);
    assert.equal(
      (
        await post(
          ctx,
          `${PATH}/challenge`,
          { ...ISSUE, expiresAt: ctx.now() + 3_600_000 },
          ca
        )
      ).status,
      401
    );
  });
});

test("cross-site writes, missing queries, unknown methods and malformed actions fail closed", async () => {
  await withServer(async (ctx) => {
    const ca = await login(ctx, ctx.a);
    assert.equal(
      (
        await post(
          ctx,
          `${PATH}/challenge`,
          { ...ISSUE, expiresAt: ctx.now() + 3_600_000 },
          ca,
          "https://evil.example"
        )
      ).status,
      403
    );
    assert.equal((await get(ctx, `${PATH}/challenge`, ca)).status, 405);
    assert.equal((await get(ctx, PATH, ca)).status, 400);
    assert.equal((await get(ctx, `${PATH}/unrecognized`, ca)).status, 404);
    assert.equal(
      (await post(ctx, `${PATH}/challenge`, { ...ISSUE, expiresAt: null }, ca))
        .status,
      400
    );
    assert.equal(
      (
        await post(
          ctx,
          `${PATH}/challenge`,
          { ...ISSUE, expiresAt: ctx.now() + 3_600_000, vault: ctx.b.vault },
          ca
        )
      ).status,
      400
    );
    assert.equal(
      (
        await post(
          ctx,
          `${PATH}/challenge`,
          { ...ISSUE, scope: "owner:manage", expiresAt: ctx.now() + 3_600_000 },
          ca
        )
      ).status,
      400
    );
    assert.equal(
      (
        await post(
          ctx,
          `${PATH}/challenge`,
          { ...ISSUE, expiresAt: ctx.now() + 2 * 24 * 3_600_000 },
          ca
        )
      ).status,
      400
    );
  });
});

test("Devnet mismatch and invalidated treasury block action creation or confirmation", async () => {
  await withServer(async (ctx) => {
    const ca = await login(ctx, ctx.a);
    const ch = await challenge(ctx, ca, {
      ...ISSUE,
      expiresAt: ctx.now() + 3_600_000,
    });
    ctx.setGenesis("unexpected");
    assert.equal(
      (await post(ctx, `${PATH}/confirm`, authorize(ch.value, ctx.a), ca))
        .status,
      403
    );
    ctx.setGenesis(GENESIS);
    ctx.invalidateVault();
    assert.equal(
      (await challenge(ctx, ca, { ...ISSUE, expiresAt: ctx.now() + 3_600_000 }))
        .status,
      403
    );
  });
});

test("read-only login cannot silently escalate when key management is unavailable", async () => {
  await withServer(
    async (ctx) => {
      const ca = await login(ctx, ctx.a);
      assert.equal(
        (await get(ctx, `${PATH}?principalId=research-agent`, ca)).status,
        503
      );
      assert.equal(
        (
          await post(
            ctx,
            `${PATH}/challenge`,
            { ...ISSUE, expiresAt: ctx.now() + 3_600_000 },
            ca
          )
        ).status,
        503
      );
    },
    { hasRepository: false }
  );
});

test("localnet cannot issue a wallet owner session or credential", async () => {
  await withServer(
    async (ctx) => {
      assert.equal(
        (
          await get(
            ctx,
            `/owner-vault/auth/challenge?owner=${ctx.a.owner}&vault=${ctx.a.vault}`
          )
        ).status,
        403
      );
      assert.equal(
        (
          await post(ctx, `${PATH}/challenge`, {
            ...ISSUE,
            expiresAt: ctx.now() + 3_600_000,
          })
        ).status,
        401
      );
    },
    { network: "localnet" }
  );
});
