import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { receiveModelAPaymentIntent } from "./model-a-payment-intake";
import {
  createModelAAgentInboxHttpHandler,
  discoverAgentInbox,
} from "./model-a-agent-inbox";

const nowMs = 1_800_000_000_000;
const nowUnix = Math.floor(nowMs / 1000);
const rootDirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of rootDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agent-inbox-test-"));
  rootDirs.push(dir);
  const vaultA = Keypair.generate().publicKey.toBase58();
  const vaultB = Keypair.generate().publicKey.toBase58();
  const agentA = Keypair.generate();
  const agentB = Keypair.generate();
  const recipient = Keypair.generate().publicKey.toBase58();
  function add(args: {
    id: string;
    vault?: string;
    agent?: Keypair;
    expiresIn?: number;
  }) {
    const scope = {
      network: "devnet" as const,
      principalId: "research-agent",
      vault: args.vault ?? vaultA,
      nowUnix,
    };
    const request = {
      requestId: args.id,
      agentAuthority: (args.agent ?? agentA).publicKey.toBase58(),
      taskId: "2",
      recipient,
      amountBaseUnits: "1",
      expiresAtUnix: String(nowUnix + (args.expiresIn ?? 300)),
    };
    return receiveModelAPaymentIntent({
      runtimeDir: dir,
      trustedScope: scope,
      input: request,
    });
  }
  return { dir, vaultA, vaultB, agentA, agentB, recipient, add };
}

async function start(
  runtimeDir: string,
  options?: {
    network?: "devnet" | "localnet";
    verifyAgent?: (args: {
      vault: string;
      agentAuthority: string;
    }) => Promise<void>;
  }
) {
  const handler = createModelAAgentInboxHttpHandler({
    fallbackHandler: (_req, res) => {
      res.writeHead(404);
      res.end();
    },
    network: options?.network ?? "devnet",
    runtimeDir,
    expectedGenesisHash: "TEST_DEVNET_GENESIS_HASH",
    getGenesisHash: async () => "TEST_DEVNET_GENESIS_HASH",
    verifyAgent: options?.verifyAgent ?? (async () => {}),
    now: () => nowMs,
  });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Invalid test server");
  const base = `http://127.0.0.1:${address.port}/api/model-a/agent-inbox`;
  const post = async (
    path: "challenge" | "poll",
    body: unknown,
    headers: Record<string, string> = {}
  ) => {
    const res = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
    });
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
  async function challenge(vault: string, agent: Keypair) {
    const answer = await post("challenge", {
      vault,
      agentAuthority: agent.publicKey.toBase58(),
    });
    assert.equal(answer.status, 200);
    assert.equal(typeof answer.json.message, "string");
    return answer.json as { nonce: string; message: string };
  }
  async function poll(ch: { nonce: string; message: string }, signer: Keypair) {
    const signature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(ch.message), signer.secretKey)
    );
    return post("poll", { nonce: ch.nonce, signature });
  }
  return { post, challenge, poll };
}

test("an authenticated agent discovers only its own vault's unexpired requests", async () => {
  const f = setup();
  f.add({ id: "request_A001" });
  f.add({ id: "request_B001", agent: f.agentB });
  f.add({ id: "request_C001", vault: f.vaultB });
  f.add({ id: "request_D001", expiresIn: 1 });
  const items = discoverAgentInbox({
    runtimeDir: f.dir,
    vault: f.vaultA,
    agentAuthority: f.agentA.publicKey.toBase58(),
    nowUnix: nowUnix + 2,
  });
  assert.deepEqual(
    items.map((item) => item.request.requestId),
    ["request_A001"]
  );
  const http = await start(f.dir);
  const ch = await http.challenge(f.vaultA, f.agentA);
  const result = await http.poll(ch, f.agentA);
  assert.equal(result.status, 200);
  assert.deepEqual(
    (result.json.items as { request: { requestId: string } }[]).map(
      (r) => r.request.requestId
    ),
    ["request_A001", "request_D001"]
  );
  assert.match(result.json.notice as string, /not queued/);
});

test("same signed agent authority is restricted to the signed vault", async () => {
  const f = setup();
  f.add({ id: "request_A001" });
  f.add({ id: "request_B001", vault: f.vaultB });
  const http = await start(f.dir);
  const result = await http.poll(
    await http.challenge(f.vaultB, f.agentA),
    f.agentA
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    (result.json.items as { request: { requestId: string } }[]).map(
      (r) => r.request.requestId
    ),
    ["request_B001"]
  );
});

test("wrong private key fails, and even a failed challenge cannot be replayed", async () => {
  const f = setup();
  const http = await start(f.dir);
  const ch = await http.challenge(f.vaultA, f.agentA);
  assert.equal((await http.poll(ch, f.agentB)).status, 401);
  assert.equal((await http.poll(ch, f.agentA)).status, 401);
});

test("successful challenge cannot be replayed", async () => {
  const f = setup();
  const http = await start(f.dir);
  const ch = await http.challenge(f.vaultA, f.agentA);
  assert.equal((await http.poll(ch, f.agentA)).status, 200);
  assert.equal((await http.poll(ch, f.agentA)).status, 401);
});

test("on-chain check rejects unregistered or inactive agent", async () => {
  const f = setup();
  const http = await start(f.dir, {
    verifyAgent: async () => {
      throw new Error("inactive");
    },
  });
  const ch = await http.challenge(f.vaultA, f.agentA);
  assert.equal((await http.poll(ch, f.agentA)).status, 403);
});

test("localnet cannot issue inbox challenges", async () => {
  const f = setup();
  const http = await start(f.dir, { network: "localnet" });
  assert.equal(
    (
      await http.post("challenge", {
        vault: f.vaultA,
        agentAuthority: f.agentA.publicKey.toBase58(),
      })
    ).status,
    503
  );
});

test("browser-origin, extraneous fields and unknown routes are refused", async () => {
  const f = setup();
  const http = await start(f.dir);
  const input = {
    vault: f.vaultA,
    agentAuthority: f.agentA.publicKey.toBase58(),
  };
  assert.equal(
    (await http.post("challenge", input, { Origin: "http://evil.example" }))
      .status,
    400
  );
  assert.equal(
    (await http.post("challenge", { ...input, unexpected: "x" })).status,
    400
  );
  assert.equal(
    (await http.post("poll", { nonce: "x", signature: "x" })).status,
    400
  );
});

test("a corrupted inbox fails closed rather than silently dropping a request", () => {
  const f = setup();
  f.add({ id: "request_A001" });
  const path = join(
    f.dir,
    "payment-intent-inbox",
    readdirSync(join(f.dir, "payment-intent-inbox"))[0]
  );
  writeFileSync(path, "not json\n");
  assert.throws(() =>
    discoverAgentInbox({
      runtimeDir: f.dir,
      vault: f.vaultA,
      agentAuthority: f.agentA.publicKey.toBase58(),
      nowUnix,
    })
  );
});

test("no inbox directory returns an empty list", () => {
  const f = setup();
  assert.deepEqual(
    discoverAgentInbox({
      runtimeDir: f.dir,
      vault: f.vaultA,
      agentAuthority: f.agentA.publicKey.toBase58(),
      nowUnix,
    }),
    []
  );
});
