/** Devnet-only, local one-shot discovery. Never submits a payment transaction. */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

async function main(): Promise<void> {
  const keyPath = process.env.AGENTVAULT_AGENT_KEYPAIR_PATH;
  const vaultText = process.env.AGENTVAULT_POLL_VAULT;
  if (!keyPath || !isAbsolute(keyPath) || !vaultText) {
    throw new Error(
      "Set AGENTVAULT_AGENT_KEYPAIR_PATH (absolute private file path) and AGENTVAULT_POLL_VAULT"
    );
  }
  if ((statSync(keyPath).mode & 0o077) !== 0) {
    throw new Error(
      "Refusing an agent keypair file readable by other users; chmod 600 the keypair"
    );
  }
  const secret = JSON.parse(readFileSync(keyPath, "utf8")) as unknown;
  if (
    !Array.isArray(secret) ||
    secret.length !== 64 ||
    !secret.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new Error("Invalid agent keypair file");
  }
  const signer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const vault = new PublicKey(vaultText).toBase58();
  if (vault !== vaultText) throw new Error("Noncanonical vault key");
  const base = "http://127.0.0.1:8787/api/model-a/agent-inbox";
  const jsonPost = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(`Agent inbox ${path} HTTP ${response.status}`);
    return (await response.json()) as unknown;
  };
  const challenge = (await jsonPost("challenge", {
    vault,
    agentAuthority: signer.publicKey.toBase58(),
  })) as {
    nonce?: unknown;
    message?: unknown;
  };
  if (
    typeof challenge.nonce !== "string" ||
    typeof challenge.message !== "string" ||
    !challenge.message.includes(`Vault: ${vault}\n`) ||
    !challenge.message.includes(
      `Agent authority: ${signer.publicKey.toBase58()}\n`
    ) ||
    !challenge.message.includes(`Nonce: ${challenge.nonce}\n`)
  )
    throw new Error("Unexpected inbox challenge");
  const signature = bs58.encode(
    nacl.sign.detached(
      new TextEncoder().encode(challenge.message),
      signer.secretKey
    )
  );
  const result = (await jsonPost("poll", {
    nonce: challenge.nonce,
    signature,
  })) as {
    network?: unknown;
    vault?: unknown;
    agentAuthority?: unknown;
    items?: unknown;
  };
  if (
    result.network !== "devnet" ||
    result.vault !== vault ||
    result.agentAuthority !== signer.publicKey.toBase58() ||
    !Array.isArray(result.items)
  ) {
    throw new Error("Unexpected agent inbox response");
  }
  console.log("Agent:", signer.publicKey.toBase58());
  console.log("Vault:", vault);
  console.log("Discovered requests:", result.items.length);
  for (const item of result.items) {
    const request = (
      item as {
        request?: {
          requestId?: string;
          taskId?: string;
          amountBaseUnits?: string;
          recipient?: string;
        };
      }
    ).request;
    if (!request) throw new Error("Malformed inbox item");
    console.log({
      requestId: request.requestId,
      taskId: request.taskId,
      amountBaseUnits: request.amountBaseUnits,
      recipient: request.recipient,
    });
  }
  console.log("READ ONLY: no request has been approved, claimed or paid.");
}

main().catch(() => {
  // Avoid echoing low-level errors which can include paths or sensitive data.
  console.error(
    "Agent inbox polling failed. Check Devnet, agent authority, vault and backend logs."
  );
  process.exitCode = 1;
});
