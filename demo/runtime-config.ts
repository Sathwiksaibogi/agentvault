import { join } from "node:path";

const selectedNetwork = process.env.AGENTVAULT_NETWORK ?? "localnet";

if (selectedNetwork !== "localnet" && selectedNetwork !== "devnet") {
  throw new Error("AGENTVAULT_NETWORK must be localnet or devnet");
}

export const NETWORK = selectedNetwork;

export const RPC_URL =
  process.env.AGENTVAULT_RPC_URL ??
  (NETWORK === "devnet"
    ? "https://api.devnet.solana.com"
    : "http://127.0.0.1:8899");

// Preserve the existing localnet directory.
// Devnet gets its own separate state and private keys.
// Supports custom persistent volume mount path (e.g. Render Persistent Disk) via AGENTVAULT_RUNTIME_DIR.
export const RUNTIME_DIR =
  process.env.AGENTVAULT_RUNTIME_DIR ??
  join(
    process.cwd(),
    "demo",
    NETWORK === "localnet" ? "local" : "devnet"
  );
