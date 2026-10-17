import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { RPC_URL } from "./runtime-config";

const PROGRAM_ID = new PublicKey(
  "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d"
);

const CLI_OWNER = new PublicKey("J2GL63eJnVsmJipKkFiaLvwrdSiGnfj5ESpa1HcJXS2G");

const PHANTOM_OWNER = new PublicKey(
  "CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc"
);

const TOKEN_MINT = new PublicKey(
  "Dm75S15mto6y3vNeXZ8FENayPCiSev7PqJBmSfZkQW38"
);

const WEB_VAULT = new PublicKey("C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep");

const WEB_TREASURY = new PublicKey(
  "8yX2mqJcx5ECA2r4gDNkEvTUvAZp6VZvj1rs8t8X1jyp"
);

// 400,000 base units = 0.4 custom test tokens.
const TARGET_BALANCE = BigInt(400_000);

async function main() {
  assert.equal(
    process.env.AGENTVAULT_NETWORK,
    "devnet",
    "This script is restricted to Devnet"
  );

  const connection = new Connection(RPC_URL, "confirmed");

  const walletPath =
    process.env.ANCHOR_WALLET ??
    join(homedir(), ".config", "solana", "id.json");

  const secret = JSON.parse(readFileSync(walletPath, "utf8")) as number[];

  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  // Never print or export the private key.
  assert.ok(
    payer.publicKey.equals(CLI_OWNER),
    "CLI signer does not match expected mint authority"
  );

  const vaultInfo = await connection.getAccountInfo(WEB_VAULT);

  assert.ok(
    vaultInfo?.owner.equals(PROGRAM_ID),
    "Expected web vault not found on this network"
  );

  const mint = await getMint(connection, TOKEN_MINT);

  assert.equal(mint.decimals, 6);
  assert.ok(
    mint.mintAuthority?.equals(CLI_OWNER),
    "Unexpected token mint authority"
  );

  const treasury = await getAccount(connection, WEB_TREASURY);

  assert.ok(treasury.owner.equals(WEB_VAULT), "Unexpected treasury authority");

  assert.ok(treasury.mint.equals(TOKEN_MINT), "Unexpected treasury mint");

  const sourceAta = getAssociatedTokenAddressSync(TOKEN_MINT, PHANTOM_OWNER);

  const sourceInfo = await connection.getAccountInfo(sourceAta);

  let currentBalance = BigInt(0);

  if (sourceInfo) {
    const source = await getAccount(connection, sourceAta);

    assert.ok(source.owner.equals(PHANTOM_OWNER));
    assert.ok(source.mint.equals(TOKEN_MINT));

    currentBalance = source.amount;
  }

  const missing =
    currentBalance >= TARGET_BALANCE
      ? BigInt(0)
      : TARGET_BALANCE - currentBalance;

  console.log("\n=== PHANTOM FUNDING PREPARATION ===");
  console.log("Network:", RPC_URL);
  console.log("Mint authority:", payer.publicKey.toBase58());
  console.log("Phantom owner:", PHANTOM_OWNER.toBase58());
  console.log("Source ATA:", sourceAta.toBase58());
  console.log("Source ATA exists:", sourceInfo !== null);
  console.log("Current balance:", currentBalance.toString());
  console.log("Target balance:", TARGET_BALANCE.toString());
  console.log("Additional mint needed:", missing.toString());

  // Default behavior: inspect only.
  if (process.env.CONFIRM_WEB_FUNDING !== "YES") {
    console.log("\nDRY RUN — no transaction submitted.");
    console.log("Set CONFIRM_WEB_FUNDING=YES to prepare the tokens.");
    return;
  }

  // The CLI mint authority pays the rent to create the
  // Phantom owner's associated token account if absent.
  const source = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    TOKEN_MINT,
    PHANTOM_OWNER
  );

  assert.ok(source.owner.equals(PHANTOM_OWNER));
  assert.ok(source.mint.equals(TOKEN_MINT));

  const additional =
    source.amount >= TARGET_BALANCE
      ? BigInt(0)
      : TARGET_BALANCE - source.amount;

  if (additional > BigInt(0)) {
    // Keep the existing mintTo logic unchanged.
  }

  if (additional > BigInt(0)) {
    const signature = await mintTo(
      connection,
      payer,
      TOKEN_MINT,
      source.address,
      payer,
      additional
    );

    console.log("Mint transaction:", signature);
  } else {
    console.log("Target already satisfied; mint skipped.");
  }

  const finalSource = await getAccount(connection, source.address, "confirmed");

  console.log("\n=== FUNDING SOURCE READY ===");
  console.log("Source ATA:", source.address.toBase58());
  console.log("Balance:", finalSource.amount.toString());
  console.log("Web treasury:", WEB_TREASURY.toBase58());
  console.log("Treasury balance:", treasury.amount.toString());
  console.log("Next step: Phantom must authorize the treasury deposit.");
}

main().catch((error: unknown) => {
  console.error(
    "Funding preparation failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
