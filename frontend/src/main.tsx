import { Buffer } from "buffer";

// Make Buffer available to Solana browser libraries.
(
  globalThis as typeof globalThis & {
    Buffer: typeof Buffer;
  }
).Buffer = Buffer;

// Load React only AFTER Buffer has been initialized.
void import("./app-entry").catch((error: unknown) => {
  console.error("AgentVault frontend failed to initialize:", error);
});
