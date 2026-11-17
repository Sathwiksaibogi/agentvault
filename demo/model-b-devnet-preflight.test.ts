import assert from "node:assert/strict";
import test from "node:test";

import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  inspectModelBDevnetPreflight,
  KNOWN_DEVNET_GENESIS_HASHES,
  type ModelBDevnetState,
  type ModelBDevnetPreflightRpc,
} from "./model-b-devnet-preflight";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

function makeFixture() {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(BigInt(7));
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), idBytes],
    AGENTVAULT_PROGRAM_ID
  );
  const treasury = getAssociatedTokenAddressSync(
    mint,
    vault,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const state: ModelBDevnetState = {
    genesisHash: KNOWN_DEVNET_GENESIS_HASHES[0],
    programId: AGENTVAULT_PROGRAM_ID.toBase58(),
    owner: owner.toBase58(),
    vaultId: "7",
    mint: mint.toBase58(),
    vault: vault.toBase58(),
    treasury: treasury.toBase58(),
  };
  const calls = { genesis: 0, account: 0, treasury: 0 };
  let genesis: string = state.genesisHash;
  let laterGenesis: string | undefined;
  let program: object | null = {
    owner: LOADER,
    executable: true,
    data: Buffer.from([1]),
  };
  let vaultInfo: object | null = {
    owner: AGENTVAULT_PROGRAM_ID,
    executable: false,
    data: Buffer.alloc(100),
  };
  const token = { mint, owner: vault, amount: BigInt(100_000) };
  const rpc = {
    async getGenesisHash() {
      calls.genesis++;
      return laterGenesis && calls.genesis > 1 ? laterGenesis : genesis;
    },
    async getAccountInfo(key: PublicKey) {
      calls.account++;
      if (key.equals(AGENTVAULT_PROGRAM_ID)) return program;
      if (key.equals(vault)) return vaultInfo;
      return null;
    },
  } as unknown as ModelBDevnetPreflightRpc;
  async function readTreasury() {
    calls.treasury++;
    return { ...token };
  }
  function inspect(network = "devnet") {
    return inspectModelBDevnetPreflight(network, state, rpc, readTreasury);
  }
  return {
    state,
    calls,
    rpc,
    token,
    inspect,
    setGenesis(value: string) {
      genesis = value;
    },
    switchGenesis(value: string) {
      laterGenesis = value;
    },
    setProgram(value: object | null) {
      program = value;
    },
    setVault(value: object | null) {
      vaultInfo = value;
    },
  };
}

test("passes public, read-only Devnet state and program checks", async () => {
  const f = makeFixture();
  const result = await f.inspect();
  assert.equal(result.network, "devnet");
  assert.equal(result.vault, f.state.vault);
  assert.equal(result.treasuryBalanceBaseUnits, "100000");
  assert.deepEqual(f.calls, { genesis: 2, account: 2, treasury: 1 });
});

test("blocks localnet before all RPC and token reads", async () => {
  const f = makeFixture();
  await assert.rejects(f.inspect("localnet"), /Devnet-only/);
  assert.deepEqual(f.calls, { genesis: 0, account: 0, treasury: 0 });
});

test("rejects unknown or spoofed cluster genesis", async () => {
  const f = makeFixture();
  f.setGenesis(Keypair.generate().publicKey.toBase58());
  await assert.rejects(f.inspect(), /reviewed Devnet fingerprint/);
  assert.equal(f.calls.account, 0);
});

test("rejects a Devnet fingerprint different from saved state", async () => {
  const f = makeFixture();
  f.setGenesis(KNOWN_DEVNET_GENESIS_HASHES[1]);
  await assert.rejects(f.inspect(), /saved state/);
  assert.equal(f.calls.account, 0);
});

test("rejects RPC ledger switch during the public read", async () => {
  const f = makeFixture();
  f.switchGenesis(KNOWN_DEVNET_GENESIS_HASHES[1]);
  await assert.rejects(f.inspect(), /ledger switched/);
});

test("rejects mismatched program id before RPC", async () => {
  const f = makeFixture();
  f.state.programId = Keypair.generate().publicKey.toBase58();
  await assert.rejects(f.inspect(), /program ID mismatch/);
  assert.equal(f.calls.genesis, 0);
});

test("rejects wrong Vault PDA before RPC", async () => {
  const f = makeFixture();
  f.state.vault = Keypair.generate().publicKey.toBase58();
  await assert.rejects(f.inspect(), /Vault PDA mismatch/);
  assert.equal(f.calls.genesis, 0);
});

test("rejects mismatched treasury ATA before RPC", async () => {
  const f = makeFixture();
  f.state.treasury = Keypair.generate().publicKey.toBase58();
  await assert.rejects(f.inspect(), /treasury ATA mismatch/);
  assert.equal(f.calls.genesis, 0);
});

test("rejects invalid vaultId without RPC", async () => {
  const f = makeFixture();
  f.state.vaultId = "18446744073709551616";
  await assert.rejects(f.inspect(), /exceeds u64/);
  assert.equal(f.calls.genesis, 0);
});

test("rejects undeployed program", async () => {
  const f = makeFixture();
  f.setProgram(null);
  await assert.rejects(f.inspect(), /not deployed/);
  assert.equal(f.calls.treasury, 0);
});

test("rejects program account that is not executable", async () => {
  const f = makeFixture();
  f.setProgram({ owner: LOADER, executable: false, data: Buffer.alloc(50) });
  await assert.rejects(f.inspect(), /not executable/);
});

test("rejects a program installed under another loader", async () => {
  const f = makeFixture();
  f.setProgram({
    owner: Keypair.generate().publicKey,
    executable: true,
    data: Buffer.alloc(50),
  });
  await assert.rejects(f.inspect(), /upgradeable loader/);
});

test("rejects missing Vault account", async () => {
  const f = makeFixture();
  f.setVault(null);
  await assert.rejects(f.inspect(), /does not exist/);
});

test("rejects Vault owned by another program", async () => {
  const f = makeFixture();
  f.setVault({
    owner: Keypair.generate().publicKey,
    executable: false,
    data: Buffer.alloc(80),
  });
  await assert.rejects(f.inspect(), /another program/);
});

test("rejects treasury controlled by an unexpected owner", async () => {
  const f = makeFixture();
  f.token.owner = Keypair.generate().publicKey;
  await assert.rejects(f.inspect(), /Treasury authority/);
});

test("rejects wrong treasury mint", async () => {
  const f = makeFixture();
  f.token.mint = Keypair.generate().publicKey;
  await assert.rejects(f.inspect(), /Treasury mint mismatch/);
});

test("rejects treasury without test tokens", async () => {
  const f = makeFixture();
  f.token.amount = BigInt(0);
  await assert.rejects(f.inspect(), /Treasury is empty/);
});
