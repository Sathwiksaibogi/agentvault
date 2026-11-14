import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { BorshAccountsCoder } from "@anchor-lang/core";
import BN from "bn.js";
import nacl from "tweetnacl";
import {
  createSelectedVaultSessionHandler,
  type SelectedVaultRpc,
} from "./selected-vault-dashboard-session";
import {
  encodePaymentApprovalV2,
  type PaymentApprovalV2,
} from "./payment-approval-v2";
import {
  encodeWorkflowV2,
  type WorkflowApprovalV2,
} from "./signed-workflow-v2";

const testIdl = JSON.parse(
  readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
);
const testAccountsCoder = new BorshAccountsCoder(testIdl);

const FRONTEND = "http://127.0.0.1:5173";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PROGRAM = new PublicKey("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");
const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
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
  const mint = new PublicKey(
    nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte + 10)).publicKey
  );
  const u64 = Buffer.alloc(8);
  u64.writeBigUInt64LE(BigInt(id));
  const [vault, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), ownerKey.toBuffer(), u64],
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
    return {
      owner,
      data,
      lamports: 1_000_000,
      executable: false,
      rentEpoch: 0,
    };
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
  agentPdaA: string;
  taskPdaA: string;
  taskA: any;
  approvalsStore: any[];
  setAgentsForVault: (vault: string, agents: any[]) => void;
  setAccount: (address: string, info: AccountInfo<Buffer> | null) => void;
  setNow: (time: number) => void;
  setGenesis: (hash: string) => void;
  fallbackCalls: () => number;
};
async function withServer(
  run: (ctx: Context) => Promise<void>,
  network: "devnet" | "localnet" = "devnet"
) {
  const a = makeFixture(7, 8001, 1_000_000);
  const b = makeFixture(8, 8002, 5_000_000);

  const [agentPdaA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("agent"),
      new PublicKey(a.vault).toBuffer(),
      new PublicKey(a.owner).toBuffer(),
    ],
    PROGRAM
  );
  const taskIdBytes = Buffer.alloc(8);
  taskIdBytes.writeBigUInt64LE(BigInt(1));
  const [taskPdaA] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPdaA.toBuffer(), taskIdBytes],
    PROGRAM
  );

  const taskA = {
    taskPda: taskPdaA.toBase58(),
    taskId: "1",
    recipient: a.owner,
    budgetBaseUnits: "100000",
    spentBaseUnits: "0",
    remainingBaseUnits: "100000",
    nextNonce: "3",
    expiresAtUnix: "1900000000",
    active: true,
  };

  const customAgentsMap = new Map<string, any[]>();

  const lookup = new Map<string, AccountInfo<Buffer>>([
    [a.vault, a.vaultInfo],
    [a.treasury, a.treasuryInfo],
    [a.mint, a.mintInfo],
    [b.vault, b.vaultInfo],
    [b.treasury, b.treasuryInfo],
    [b.mint, b.mintInfo],
  ]);
  let timestamp = 1_800_000_000_000;
  let genesis = GENESIS;
  let fallbackCount = 0;
  const rpc: SelectedVaultRpc = {
    async getGenesisHash() {
      return genesis;
    },
    async getAccountInfo(address, commitment) {
      assert.equal(commitment, "confirmed");
      return lookup.get(address.toBase58()) ?? null;
    },
  };
  const approvalsStore: any[] = [];
  const handler = createSelectedVaultSessionHandler({
    rpc,
    network,
    expectedGenesisHash: GENESIS,
    frontendOrigin: FRONTEND,
    readScopedAgents: async (verified) => ({
      network: "devnet",
      owner: verified.owner,
      vault: verified.vault,
      agents: customAgentsMap.get(verified.vault) ?? [],
    }),
    readScopedActivity: async (verified) => ({
      network: "devnet",
      vault: verified.vault,
      activity: [],
    }),
    readScopedApprovals: async (verified) => ({
      network: "devnet",
      vault: verified.vault,
      approvals: approvalsStore.filter((a) => a.vault === verified.vault),
    }),
    readScopedPendingApprovals: async (verified) => {
      return approvalsStore
        .filter(
          (a) =>
            a.vault === verified.vault && a.status === "pending_owner_approval"
        )
        .map((a) => ({
          requestId: a.requestId,
          vault: a.vault,
          agentAuthority: a.agentAuthority,
          taskId: a.taskId,
          recipient: a.recipient,
          amountBaseUnits: a.amountBaseUnits,
          expiresAtUnix: a.expiresAtUnix,
          nonce: a.nonce,
          status: "pending_owner_approval",
          description: a.description,
          createdAtUnix: a.createdAtUnix ?? Math.floor(timestamp / 1000),
        }));
    },
    saveScopedPendingApproval: async (verified, pendingRequest) => {
      approvalsStore.push(pendingRequest);
    },
    saveScopedApproval: async (verified, approvalData) => {
      // Remove pending if exists
      const existingIdx = approvalsStore.findIndex(
        (a) =>
          a.vault === verified.vault &&
          a.requestId === approvalData.paymentApproval.requestId &&
          a.status === "pending_owner_approval"
      );
      if (existingIdx >= 0) {
        approvalsStore.splice(existingIdx, 1);
      }
      approvalsStore.push({
        vault: verified.vault,
        requestId: approvalData.paymentApproval.requestId,
        authorizationModel: "model-b",
        status: "approved_pending_execution",
        agentAuthority: approvalData.paymentApproval.agentAuthority,
        recipient: approvalData.paymentApproval.recipient,
        amountBaseUnits: approvalData.paymentApproval.amountBaseUnits,
        nonce: approvalData.paymentApproval.nonce,
        expiresAtUnix: approvalData.paymentApproval.expiresAtUnix,
      });
      return { requestId: approvalData.paymentApproval.requestId };
    },
    now: () => timestamp,
    fallbackHandler: (_req, res) => {
      fallbackCount++;
      res.writeHead(418).end();
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
      a,
      b,
      agentPdaA: agentPdaA.toBase58(),
      taskPdaA: taskPdaA.toBase58(),
      taskA,
      approvalsStore,
      setAgentsForVault: (vault: string, agents: any[]) => {
        customAgentsMap.set(vault, agents);
      },
      setAccount: (address: string, info: AccountInfo<Buffer> | null) => {
        if (info === null) lookup.delete(address);
        else lookup.set(address, info);
      },
      setNow: (time: number) => {
        timestamp = time;
      },
      setGenesis: (hash: string) => {
        genesis = hash;
      },
      fallbackCalls: () => fallbackCount,
    });
  } finally {
    await new Promise<void>((resolve) =>
      (server as Server).close(() => resolve())
    );
  }
}

async function getChallenge(ctx: Context, f: Fixture) {
  const response = await fetch(
    `${ctx.base}/owner-vault/auth/challenge?owner=${f.owner}&vault=${f.vault}`
  );
  return {
    status: response.status,
    value: (await response.json()) as {
      nonce: string;
      message: string;
      ownerPublicKey: string;
      vaultPublicKey: string;
    },
  };
}
function signed(
  ch: Awaited<ReturnType<typeof getChallenge>>["value"],
  f: Fixture
) {
  return {
    nonce: ch.nonce,
    publicKey: f.owner,
    vault: f.vault,
    signature: Buffer.from(
      nacl.sign.detached(Buffer.from(ch.message), f.signer.secretKey)
    ).toString("base64"),
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
  assert.match(
    raw,
    /HttpOnly; SameSite=Strict; Path=\/owner-vault; Max-Age=900/
  );
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
  fetch(`${ctx.base}${path}`, {
    method,
    headers: cookie ? { Cookie: cookie } : {},
  });

test("signed owner A sees only on-chain verified treasury A", async () => {
  await withServer(async (ctx) => {
    assert.equal((await read(ctx, "/owner-vault/api/treasury")).status, 401);
    const ch = await getChallenge(ctx, ctx.a);
    assert.match(ch.value.message, /not a payment approval/);
    assert.match(ch.value.message, new RegExp(ctx.a.vault));
    assert.match(ch.value.message, new RegExp(`Genesis: ${GENESIS}`));
    const loginResult = await login(ctx, signed(ch.value, ctx.a));
    assert.equal(loginResult.status, 200);
    const cookie = extractCookie(loginResult);
    const status = await read(ctx, "/owner-vault/auth/session", cookie);
    assert.deepEqual(await status.json(), {
      authenticated: true,
      owner: ctx.a.owner,
      vault: ctx.a.vault,
    });
    const data = await read(ctx, "/owner-vault/api/treasury", cookie);
    assert.equal(data.status, 200);
    assert.deepEqual(await data.json(), {
      network: "devnet",
      vault: ctx.a.vault,
      owner: ctx.a.owner,
      tokenMint: ctx.a.mint,
      treasury: ctx.a.treasury,
      vaultId: "8001",
      decimals: 6,
      paused: false,
      balanceBaseUnits: "1000000",
      reservedBaseUnits: "250000",
      availableBaseUnits: "750000",
    });
    assert.equal(ctx.fallbackCalls(), 0);
  });
});

test("vault A session cannot select vault B, and B signs in to its own data", async () => {
  await withServer(async (ctx) => {
    const cookieA = await loginOwner(ctx, ctx.a);
    assert.equal(
      (
        await read(
          ctx,
          `/owner-vault/api/treasury?vault=${ctx.b.vault}`,
          cookieA
        )
      ).status,
      404
    );
    const agentsA = await read(ctx, "/owner-vault/api/agents", cookieA);
    assert.equal(agentsA.status, 200);
    assert.deepEqual(await agentsA.json(), {
      network: "devnet",
      owner: ctx.a.owner,
      vault: ctx.a.vault,
      agents: [],
    });
    assert.equal(
      (await read(ctx, "/owner-vault/api/agents", cookieA, "POST")).status,
      405
    );
    assert.equal(
      (await read(ctx, `/owner-vault/api/agents?vault=${ctx.b.vault}`, cookieA))
        .status,
      404
    );
    const result = await read(ctx, "/owner-vault/api/treasury", cookieA);
    assert.equal((await result.json()).owner, ctx.a.owner);
    const cookieB = await loginOwner(ctx, ctx.b);
    const dataB = await read(ctx, "/owner-vault/api/treasury", cookieB);
    assert.equal((await dataB.json()).owner, ctx.b.owner);
    const agentsB = await read(ctx, "/owner-vault/api/agents", cookieB);
    assert.deepEqual(await agentsB.json(), {
      network: "devnet",
      owner: ctx.b.owner,
      vault: ctx.b.vault,
      agents: [],
    });
    assert.equal(ctx.fallbackCalls(), 0);
  });
});

test("a wallet cannot request a challenge for another owner's vault", async () => {
  await withServer(async (ctx) => {
    const res = await read(
      ctx,
      `/owner-vault/auth/challenge?owner=${ctx.a.owner}&vault=${ctx.b.vault}`
    );
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
    assert.equal(
      (await read(ctx, "/owner-vault/api/treasury", cookie)).status,
      503
    );
    assert.equal(
      (await read(ctx, "/owner-vault/api/agents", cookie)).status,
      503
    );
    assert.equal((await getChallenge(ctx, ctx.b)).status, 403);
    ctx.setGenesis(GENESIS);
    ctx.a.treasuryInfo.data[32] ^= 1;
    assert.equal(
      (await read(ctx, "/owner-vault/api/treasury", cookie)).status,
      503
    );
    assert.equal(
      (await read(ctx, "/owner-vault/api/agents", cookie)).status,
      503
    );
  });
});

test("rejects cross-origin logins, unknown routes and write requests", async () => {
  await withServer(async (ctx) => {
    const ch = await getChallenge(ctx, ctx.a);
    assert.equal(
      (await login(ctx, signed(ch.value, ctx.a), "https://evil.example"))
        .status,
      403
    );
    const cookie = await loginOwner(ctx, ctx.a);
    assert.equal(
      (await read(ctx, "/owner-vault/api/treasury", cookie, "POST")).status,
      405
    );
    assert.equal(
      (await read(ctx, "/owner-vault/api/workflows", cookie)).status,
      404
    );
    assert.equal(
      (await read(ctx, "/owner-vault/auth/challenge?wrong=1", cookie)).status,
      400
    );
    assert.equal(ctx.fallbackCalls(), 0);
  });
});

test("cookie expiry, logout and duplicate cookie checks", async () => {
  await withServer(async (ctx) => {
    const cookie = await loginOwner(ctx, ctx.a);
    assert.equal(
      (await read(ctx, "/owner-vault/api/treasury", `${cookie}; ${cookie}`))
        .status,
      401
    );
    const logout = await fetch(`${ctx.base}/owner-vault/auth/logout`, {
      method: "POST",
      headers: { Origin: FRONTEND, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(
      (await read(ctx, "/owner-vault/api/treasury", cookie)).status,
      401
    );
    const second = await loginOwner(ctx, ctx.a);
    ctx.setNow(1_800_000_000_000 + 16 * 60_000);
    assert.equal(
      (await read(ctx, "/owner-vault/api/treasury", second)).status,
      401
    );
  });
});

test("localnet never permits selected-vault sessions", async () => {
  await withServer(async (ctx) => {
    assert.equal((await getChallenge(ctx, ctx.a)).status, 403);
  }, "localnet");
});

test("signed owner can read vault-scoped activity", async () => {
  await withServer(async (ctx) => {
    const cookie = await loginOwner(ctx, ctx.a);
    const res = await read(ctx, "/owner-vault/api/activity", cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      network: string;
      vault: string;
      activity: unknown[];
    };
    assert.equal(body.network, "devnet");
    assert.equal(body.vault, ctx.a.vault);
    assert.deepEqual(body.activity, []);
  });
});

test("signed owner can read and submit Model B payment approvals (PaymentApprovalV2) bound to real pending request with verified on-chain nonce", async () => {
  await withServer(async (ctx) => {
    const cookie = await loginOwner(ctx, ctx.a);

    ctx.setAgentsForVault(ctx.a.vault, [
      {
        agentPda: ctx.agentPdaA,
        authority: ctx.a.owner,
        tasks: [ctx.taskA],
      },
    ]);

    // Initial state: Queue has a real pending Model B request awaiting owner approval
    ctx.approvalsStore.push({
      vault: ctx.a.vault,
      requestId: "model_b_req_test_01",
      taskId: "1",
      authorizationModel: "model-b",
      status: "pending_owner_approval",
      agentAuthority: ctx.a.owner,
      recipient: ctx.a.owner,
      amountBaseUnits: "5000",
      nonce: "3",
      expiresAtUnix: "1850000000",
    });

    const res0 = await read(ctx, "/owner-vault/api/approvals", cookie);
    assert.equal(res0.status, 200);
    const body0 = (await res0.json()) as {
      approvals: Array<{ requestId: string; status: string }>;
    };
    assert.equal(body0.approvals.length, 1);
    assert.equal(body0.approvals[0].requestId, "model_b_req_test_01");
    assert.equal(body0.approvals[0].status, "pending_owner_approval");

    // 1. Attempt submitting with hardcoded zero nonce ("0") -> MUST FAIL CLOSED
    const zeroNonceApproval: PaymentApprovalV2 = {
      version: 2,
      genesisHash: GENESIS,
      programId: PROGRAM.toBase58(),
      vault: ctx.a.vault,
      owner: ctx.a.owner,
      mint: ctx.a.mint,
      agent: ctx.agentPdaA,
      agentAuthority: ctx.a.owner,
      task: ctx.taskPdaA,
      recipient: ctx.a.owner,
      amountBaseUnits: "5000",
      nonce: "0", // Hardcoded zero
      expiresAtUnix: "1850000000",
      requestId: "model_b_req_test_01",
    };
    const zeroEncoded = encodePaymentApprovalV2(zeroNonceApproval);
    const zeroSigBytes = nacl.sign.detached(
      zeroEncoded,
      ctx.a.signer.secretKey
    );
    const zeroRes = await fetch(`${ctx.base}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval: zeroNonceApproval,
        signatureBase64: Buffer.from(zeroSigBytes).toString("base64"),
      }),
    });
    assert.equal(zeroRes.status, 400);
    const zeroJson = (await zeroRes.json()) as { error: string };
    assert.ok(
      zeroJson.error.includes("Nonce mismatch"),
      "Hardcoded zero nonce must be rejected"
    );

    // 2. Submit with verified current on-chain task nonce ("3") -> SUCCEEDS
    const validApproval: PaymentApprovalV2 = {
      ...zeroNonceApproval,
      nonce: "3", // Derived from verified current on-chain task state
    };
    const validEncoded = encodePaymentApprovalV2(validApproval);
    const validSigBytes = nacl.sign.detached(
      validEncoded,
      ctx.a.signer.secretKey
    );
    const validSigBase64 = Buffer.from(validSigBytes).toString("base64");

    const submitRes = await fetch(`${ctx.base}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval: validApproval,
        signatureBase64: validSigBase64,
      }),
    });
    assert.equal(submitRes.status, 200);
    const submitJson = (await submitRes.json()) as {
      ok: boolean;
      status: string;
      notice: string;
    };
    assert.equal(submitJson.ok, true);
    assert.equal(submitJson.status, "approved_pending_execution");
    assert.ok(submitJson.notice.includes("Live execution coordinator remains disabled"));

    // Re-read approvals: queue now reflects approved_pending_execution
    const res1 = await read(ctx, "/owner-vault/api/approvals", cookie);
    assert.equal(res1.status, 200);
    const body1 = (await res1.json()) as {
      approvals: Array<{ requestId: string; status: string }>;
    };
    assert.equal(body1.approvals.length, 1);
    assert.equal(body1.approvals[0].requestId, "model_b_req_test_01");
    assert.equal(body1.approvals[0].status, "approved_pending_execution");
  });
});

test("submitting approval for non-existent pending request fails closed (binding requirement)", async () => {
  await withServer(async (ctx) => {
    const cookie = await loginOwner(ctx, ctx.a);

    // Construct valid approval for an unqueued / unbound request ID
    const unboundApproval: PaymentApprovalV2 = {
      version: 2,
      genesisHash: GENESIS,
      programId: PROGRAM.toBase58(),
      vault: ctx.a.vault,
      owner: ctx.a.owner,
      mint: ctx.a.mint,
      agent: ctx.agentPdaA,
      agentAuthority: ctx.a.owner,
      task: ctx.taskPdaA,
      recipient: ctx.a.owner,
      amountBaseUnits: "5000",
      nonce: "3",
      expiresAtUnix: "1850000000",
      requestId: "model_b_unbound_99",
    };
    const encoded = encodePaymentApprovalV2(unboundApproval);
    const sigBytes = nacl.sign.detached(encoded, ctx.a.signer.secretKey);

    const submitRes = await fetch(`${ctx.base}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval: unboundApproval,
        signatureBase64: Buffer.from(sigBytes).toString("base64"),
      }),
    });
    assert.equal(submitRes.status, 404);
    const json = (await submitRes.json()) as { error: string };
    assert.ok(json.error.includes("No pending Model B request found"));
  });
});

test("submitting approval with mismatched recipient, agent, or task fails closed", async () => {
  await withServer(async (ctx) => {
    const cookie = await loginOwner(ctx, ctx.a);

    ctx.approvalsStore.push({
      vault: ctx.a.vault,
      requestId: "model_b_mismatch_01",
      authorizationModel: "model-b",
      status: "pending_owner_approval",
      agentAuthority: ctx.a.owner,
      recipient: ctx.a.owner,
      amountBaseUnits: "5000",
      nonce: "3",
      expiresAtUnix: "1850000000",
    });

    const rogueRecipient = Keypair.generate();
    const mismatchedApproval: PaymentApprovalV2 = {
      version: 2,
      genesisHash: GENESIS,
      programId: PROGRAM.toBase58(),
      vault: ctx.a.vault,
      owner: ctx.a.owner,
      mint: ctx.a.mint,
      agent: ctx.agentPdaA,
      agentAuthority: ctx.a.owner,
      task: ctx.taskPdaA,
      recipient: rogueRecipient.publicKey.toBase58(), // Mismatched recipient
      amountBaseUnits: "5000",
      nonce: "3",
      expiresAtUnix: "1850000000",
      requestId: "model_b_mismatch_01",
    };
    const encoded = encodePaymentApprovalV2(mismatchedApproval);
    const sigBytes = nacl.sign.detached(encoded, ctx.a.signer.secretKey);

    const submitRes = await fetch(`${ctx.base}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval: mismatchedApproval,
        signatureBase64: Buffer.from(sigBytes).toString("base64"),
      }),
    });
    assert.equal(submitRes.status, 400);
    const json = (await submitRes.json()) as { error: string };
    assert.ok(json.error.includes("parameters do not match pending Model B request"));
  });
});

test("submitting PaymentApprovalV2 with mismatched owner or forged signature is rejected", async () => {
  await withServer(async (ctx) => {
    const cookie = await loginOwner(ctx, ctx.a);

    ctx.approvalsStore.push({
      vault: ctx.a.vault,
      requestId: "model_b_req_forged_01",
      authorizationModel: "model-b",
      status: "pending_owner_approval",
      agentAuthority: ctx.a.owner,
      recipient: ctx.a.owner,
      amountBaseUnits: "5000",
      nonce: "3",
      expiresAtUnix: "1850000000",
    });

    const paymentApproval: PaymentApprovalV2 = {
      version: 2,
      genesisHash: GENESIS,
      programId: PROGRAM.toBase58(),
      vault: ctx.a.vault,
      owner: ctx.a.owner,
      mint: ctx.a.mint,
      agent: ctx.agentPdaA,
      agentAuthority: ctx.a.owner,
      task: ctx.taskPdaA,
      recipient: ctx.a.owner,
      amountBaseUnits: "5000",
      nonce: "3",
      expiresAtUnix: "1850000000",
      requestId: "model_b_req_forged_01",
    };

    // Sign with WRONG owner (ctx.b)
    const encoded = encodePaymentApprovalV2(paymentApproval);
    const forgedSig = Buffer.from(
      nacl.sign.detached(encoded, ctx.b.signer.secretKey)
    ).toString("base64");

    const submitRes = await fetch(`${ctx.base}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval,
        signatureBase64: forgedSig,
      }),
    });
    assert.equal(submitRes.status, 400);

    // Mismatched vault in approval
    const wrongVaultApproval = { ...paymentApproval, vault: ctx.b.vault };
    const wrongVaultRes = await fetch(`${ctx.base}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval: wrongVaultApproval,
        signatureBase64: forgedSig,
      }),
    });
    assert.equal(wrongVaultRes.status, 403);
  });
});

test("Model B pending requests: must originate from authenticated workflow, reject default task ID, and enforce immutability", async () => {
  await withServer(async (ctx) => {
    const cookie = await loginOwner(ctx, ctx.a);

    // 1. Missing or invalid taskId fails closed (default task IDs prohibited)
    const noTaskIdRes = await fetch(
      `${ctx.base}/owner-vault/api/pending-requests`,
      {
        method: "POST",
        headers: {
          Origin: FRONTEND,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "model_b_req_no_task_01",
          recipient: ctx.a.owner,
          amountBaseUnits: "1000",
          expiresAtUnix: "1850000000",
          agentAuthority: ctx.a.owner,
        }),
      }
    );
    assert.equal(noTaskIdRes.status, 400);
    const noTaskJson = (await noTaskIdRes.json()) as { error: string };
    assert.ok(
      noTaskJson.error.includes("default task IDs are strictly prohibited")
    );

    // 2. Submit with valid signed workflow
    const workflow: WorkflowApprovalV2 = {
      version: 2,
      authorizationModel: "model-b",
      network: "devnet",
      requestId: "model_b_req_valid_wf_01",
      genesisHash: GENESIS,
      programId: PROGRAM.toBase58(),
      vault: ctx.a.vault,
      owner: ctx.a.owner,
      mint: ctx.a.mint,
      assignedAgent: "agent-a",
      agentAuthority: ctx.a.owner,
      kind: "procurement",
      taskId: 1,
      recipient: ctx.a.owner,
      amountBaseUnits: 5000,
      expiresAtUnix: 1850000000,
      description: "Authenticated procurement workflow",
    };
    const wfEncoded = encodeWorkflowV2(workflow);
    const wfSig = Buffer.from(
      nacl.sign.detached(wfEncoded, ctx.a.signer.secretKey)
    ).toString("base64");

    const validPendingRes = await fetch(
      `${ctx.base}/owner-vault/api/pending-requests`,
      {
        method: "POST",
        headers: {
          Origin: FRONTEND,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "model_b_req_valid_wf_01",
          taskId: "1",
          nonce: "3",
          signedWorkflow: {
            workflow,
            signature: wfSig,
          },
        }),
      }
    );
    assert.equal(validPendingRes.status, 201);
    const validPendingJson = (await validPendingRes.json()) as {
      ok: boolean;
      requestId: string;
      status: string;
    };
    assert.equal(validPendingJson.ok, true);
    assert.equal(validPendingJson.status, "pending_owner_approval");

    // 3. Idempotent submission: submitting exact same request returns 200 with idempotent: true
    const dupRes = await fetch(`${ctx.base}/owner-vault/api/pending-requests`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "model_b_req_valid_wf_01",
        taskId: "1",
        nonce: "3",
        signedWorkflow: {
          workflow,
          signature: wfSig,
        },
      }),
    });
    assert.equal(dupRes.status, 200);
    const dupJson = (await dupRes.json()) as {
      ok: boolean;
      idempotent: boolean;
    };
    assert.equal(dupJson.ok, true);
    assert.equal(dupJson.idempotent, true);

    // 4. Immutability: submitting different terms for same requestId fails with 409 Conflict
    const conflictWf: WorkflowApprovalV2 = {
      ...workflow,
      amountBaseUnits: 9999, // Mismatched amount
    };
    const conflictSig = Buffer.from(
      nacl.sign.detached(encodeWorkflowV2(conflictWf), ctx.a.signer.secretKey)
    ).toString("base64");

    const conflictRes = await fetch(
      `${ctx.base}/owner-vault/api/pending-requests`,
      {
        method: "POST",
        headers: {
          Origin: FRONTEND,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "model_b_req_valid_wf_01",
          taskId: "1",
          nonce: "3",
          signedWorkflow: {
            workflow: conflictWf,
            signature: conflictSig,
          },
        }),
      }
    );
    assert.equal(conflictRes.status, 409);
    const conflictJson = (await conflictRes.json()) as { error: string };
    assert.ok(conflictJson.error.includes("already exists with different immutable terms"));
  });
});

test("Model B account verification: Anchor IDL decoding and account validation on-chain", async () => {
  await withServer(async (ctx) => {
    const cookie = await loginOwner(ctx, ctx.a);

    // Encode a realistic ApprovedTask account using BorshAccountsCoder
    const approvedTaskData = await testAccountsCoder.encode("ApprovedTask", {
      vault: new PublicKey(ctx.a.vault),
      agent: new PublicKey(ctx.agentPdaA),
      task_id: new BN(1),
      recipient: new PublicKey(ctx.a.owner),
      budget: new BN(100000),
      spent: new BN(0),
      expires_at: new BN(1900000000),
      next_nonce: new BN(3),
      genesis_hash: new PublicKey(GENESIS),
      active: true,
      bump: 254,
    });

    // Populate RPC lookup with real on-chain ApprovedTask account data owned by PROGRAM
    ctx.setAccount(ctx.taskPdaA, {
      owner: PROGRAM,
      data: approvedTaskData,
      lamports: 1_000_000,
      executable: false,
      rentEpoch: 0,
    });

    ctx.approvalsStore.push({
      vault: ctx.a.vault,
      requestId: "model_b_idl_task_01",
      taskId: "1",
      authorizationModel: "model-b",
      status: "pending_owner_approval",
      agentAuthority: ctx.a.owner,
      recipient: ctx.a.owner,
      amountBaseUnits: "5000",
      nonce: "3",
      expiresAtUnix: "1850000000",
    });

    const approval: PaymentApprovalV2 = {
      version: 2,
      genesisHash: GENESIS,
      programId: PROGRAM.toBase58(),
      vault: ctx.a.vault,
      owner: ctx.a.owner,
      mint: ctx.a.mint,
      agent: ctx.agentPdaA,
      agentAuthority: ctx.a.owner,
      task: ctx.taskPdaA,
      recipient: ctx.a.owner,
      amountBaseUnits: "5000",
      nonce: "3",
      expiresAtUnix: "1850000000",
      requestId: "model_b_idl_task_01",
    };
    const encoded = encodePaymentApprovalV2(approval);
    const sig = Buffer.from(
      nacl.sign.detached(encoded, ctx.a.signer.secretKey)
    ).toString("base64");

    // 1. Real Anchor IDL decoded ApprovedTask succeeds
    const successRes = await fetch(`${ctx.base}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval: approval,
        signatureBase64: sig,
      }),
    });
    assert.equal(successRes.status, 200);

    // 2. Negative test: task account owned by rogue program fails closed
    ctx.approvalsStore.push({
      vault: ctx.a.vault,
      requestId: "model_b_idl_rogue_owner_01",
      taskId: "1",
      authorizationModel: "model-b",
      status: "pending_owner_approval",
      agentAuthority: ctx.a.owner,
      recipient: ctx.a.owner,
      amountBaseUnits: "5000",
      nonce: "3",
      expiresAtUnix: "1850000000",
    });
    const rogueOwnerApproval = {
      ...approval,
      requestId: "model_b_idl_rogue_owner_01",
    };
    const rogueEncoded = encodePaymentApprovalV2(rogueOwnerApproval);
    const rogueSig = Buffer.from(
      nacl.sign.detached(rogueEncoded, ctx.a.signer.secretKey)
    ).toString("base64");

    ctx.setAccount(ctx.taskPdaA, {
      owner: Keypair.generate().publicKey, // Wrong program owner!
      data: approvedTaskData,
      lamports: 1_000_000,
      executable: false,
      rentEpoch: 0,
    });
    const rogueRes = await fetch(`${ctx.base}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval: rogueOwnerApproval,
        signatureBase64: rogueSig,
      }),
    });
    assert.equal(rogueRes.status, 400);

    // 3. Negative test: task account with corrupt discriminator fails closed
    const corruptData = Buffer.from(approvedTaskData);
    corruptData[0] ^= 0xff; // Corrupt discriminator byte
    ctx.setAccount(ctx.taskPdaA, {
      owner: PROGRAM,
      data: corruptData,
      lamports: 1_000_000,
      executable: false,
      rentEpoch: 0,
    });
    const corruptRes = await fetch(`${ctx.base}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval: rogueOwnerApproval,
        signatureBase64: rogueSig,
      }),
    });
    assert.equal(corruptRes.status, 400);

    // 4. Negative test: inactive task (active: false) fails closed
    const inactiveTaskData = await testAccountsCoder.encode("ApprovedTask", {
      vault: new PublicKey(ctx.a.vault),
      agent: new PublicKey(ctx.agentPdaA),
      task_id: new BN(1),
      recipient: new PublicKey(ctx.a.owner),
      budget: new BN(100000),
      spent: new BN(0),
      expires_at: new BN(1900000000),
      next_nonce: new BN(3),
      genesis_hash: new PublicKey(GENESIS),
      active: false, // Inactive / revoked task
      bump: 254,
    });
    ctx.setAccount(ctx.taskPdaA, {
      owner: PROGRAM,
      data: inactiveTaskData,
      lamports: 1_000_000,
      executable: false,
      rentEpoch: 0,
    });
    const inactiveRes = await fetch(`${ctx.base}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval: rogueOwnerApproval,
        signatureBase64: rogueSig,
      }),
    });
    assert.equal(inactiveRes.status, 400);
  });
});
