
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getMint,
  getAccount,
} from "@solana/spl-token";
import { RPC_URL } from "./runtime-config";

const PHANTOM_OWNER = new PublicKey(
  "CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc",
);

const TOKEN_MINT = new PublicKey(
  "Dm75S15mto6y3vNeXZ8FENayPCiSev7PqJBmSfZkQW38",
);

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  const mint = await getMint(connection, TOKEN_MINT);

  const ownerAta = getAssociatedTokenAddressSync(
    TOKEN_MINT,
    PHANTOM_OWNER,
  );

  const ataInfo = await connection.getAccountInfo(ownerAta);

  console.log("=== WEB VAULT FUNDING INSPECTION ===");
  console.log("RPC:", RPC_URL);
  console.log("Mint:", TOKEN_MINT.toBase58());
  console.log(
    "Mint authority:",
    mint.mintAuthority?.toBase58() ?? "None",
  );
  console.log("Mint decimals:", mint.decimals);
  console.log("Phantom owner:", PHANTOM_OWNER.toBase58());
  console.log("Phantom source ATA:", ownerAta.toBase58());
  console.log("Source ATA exists:", ataInfo !== null);

  if (ataInfo) {
    const source = await getAccount(connection, ownerAta);

    console.log("Source token balance:", source.amount.toString());
  }

  const solBalance = await connection.getBalance(PHANTOM_OWNER);

  console.log("Phantom SOL balance (lamports):", solBalance);
  console.log("Inspection complete — no transaction submitted");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
