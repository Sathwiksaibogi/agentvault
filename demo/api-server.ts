import * as anchor from "@anchor-lang/core";

import { strict as assert } from "node:assert";
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Connection, PublicKey } from "@solana/web3.js";

import { getAccount, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import type { Agentvault } from "../target/types/agentvault";
import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";

type DemoState = {
  genesisHash: string;
  programId: string;
  vault: string;
  owner: string;
  mint: string;
  treasury: string;
  vaultId: string;
};

const PORT = 8787;
const HOST = "127.0.0.1";

const state = JSON.parse(
  readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
) as DemoState;

const idl = JSON.parse(
  readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
) as Agentvault;

const connection = new Connection(RPC_URL, "confirmed");

const program = new anchor.Program<Agentvault>(idl, {
  connection,
});

assert.equal(program.programId.toBase58(), state.programId);

function sendJson(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  response.end(JSON.stringify(data));
}

async function getTreasuryData() {
  const vaultPda = new PublicKey(state.vault);
  const treasuryPda = new PublicKey(state.treasury);
  const mintPda = new PublicKey(state.mint);

  const [genesisHash, vault, treasury, mint] = await Promise.all([
    connection.getGenesisHash(),
    program.account.vault.fetch(vaultPda, "confirmed"),
    getAccount(connection, treasuryPda, "confirmed", TOKEN_PROGRAM_ID),
    getMint(connection, mintPda, "confirmed", TOKEN_PROGRAM_ID),
  ]);

  assert.equal(genesisHash, state.genesisHash);
  assert.equal(vault.owner.toBase58(), state.owner);
  assert.equal(vault.tokenMint.toBase58(), state.mint);
  assert.equal(vault.vaultId.toString(), state.vaultId);

  assert.ok(treasury.owner.equals(vaultPda));
  assert.ok(treasury.mint.equals(mintPda));

  const balance = treasury.amount;
  const reserved = BigInt(vault.totalReserved.toString());

  assert.ok(reserved <= balance, "Treasury reservation invariant violated");

  return {
    network: NETWORK,
    vault: state.vault,
    owner: state.owner,
    tokenMint: state.mint,
    treasury: state.treasury,
    vaultId: state.vaultId,
    decimals: mint.decimals,
    paused: vault.paused,
    balanceBaseUnits: balance.toString(),
    reservedBaseUnits: reserved.toString(),
    availableBaseUnits: (balance - reserved).toString(),
  };
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET") {
    sendJson(response, 405, {
      error: "Method not allowed",
    });
    return;
  }

  const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`)
    .pathname;

  if (pathname === "/health") {
    sendJson(response, 200, {
      service: "agentvault-api",
      network: NETWORK,
      mode: "read-only",
      status: "running",
    });
    return;
  }

  if (pathname === "/api/treasury") {
    try {
      const result = await getTreasuryData();
      sendJson(response, 200, result);
    } catch (error) {
      console.error(
        "Treasury read failed:",
        error instanceof Error ? error.message : error
      );

      sendJson(response, 503, {
        error: "Treasury data temporarily unavailable",
      });
    }

    return;
  }

  sendJson(response, 404, {
    error: "Endpoint not found",
  });
});

server.listen(PORT, HOST, () => {
  console.log("\n=== AGENTVAULT BACKEND API ===");
  console.log("Network:", NETWORK);
  console.log("Mode: READ ONLY");
  console.log(`Health: http://${HOST}:${PORT}/health`);
  console.log(`Treasury: http://${HOST}:${PORT}/api/treasury`);
  console.log("No signing or Gemini endpoints exposed.");
});
