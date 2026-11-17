/**
 * AgentVault — Issues an authorized developer API key for Devnet acceptance.
 *
 * Uses the canonical issueDeveloperApiKey() service from demo/api-key-issuance.ts.
 * Persists the hashed key record into PostgreSQL and writes the token to
 * ~/.config/agentvault/api.env (mode 0600).
 *
 * SAFETY GUARANTEES:
 * - Scoped to exact acceptance vault: G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U.
 * - Scoped to exact required permission: payments:request.
 * - Expires within 24 hours.
 * - Never prints or exposes secret tokens in output.
 *
 * Usage:
 *   npx tsx demo/issue-devnet-developer-key.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Pool } from "pg";
import dotenv from "dotenv";
import { issueDeveloperApiKey } from "./api-key-issuance.js";
import { PostgresDeveloperApiKeyRepository } from "./api-key-postgres-repository.js";
import { DEVNET_ACCEPTANCE_VAULT } from "./submit-devnet-acceptance-intent.js";

async function main(): Promise<void> {
  const cfgPath = join(homedir(), ".config/agentvault/api.env");
  if (!existsSync(cfgPath)) {
    throw new Error(`Config file not found: ${cfgPath}`);
  }

  const rawEnv = readFileSync(cfgPath, "utf8");
  const envConfig = dotenv.parse(rawEnv);
  const dbUrl = process.env.AGENTVAULT_DATABASE_URL || envConfig.AGENTVAULT_DATABASE_URL;

  if (!dbUrl) {
    throw new Error("AGENTVAULT_DATABASE_URL required to issue developer API key");
  }

  const pool = new Pool({ connectionString: dbUrl });
  try {
    const repository = new PostgresDeveloperApiKeyRepository(pool);
    const now = Date.now();
    const expiresAt = now + 23 * 3600 * 1000; // 23 hours from now

    const issued = await issueDeveloperApiKey({
      issuer: { role: "owner", vaults: [DEVNET_ACCEPTANCE_VAULT] },
      principalId: "acceptance-developer-01",
      vault: DEVNET_ACCEPTANCE_VAULT,
      scopes: ["payments:request"],
      now,
      expiresAt,
      repository,
    });

    // Update ~/.config/agentvault/api.env with new key
    let updatedEnv = rawEnv;
    if (updatedEnv.includes("AGENTVAULT_DEVELOPER_API_KEY=")) {
      updatedEnv = updatedEnv.replace(
        /AGENTVAULT_DEVELOPER_API_KEY=.*/,
        `AGENTVAULT_DEVELOPER_API_KEY=${issued.token}`
      );
    } else {
      updatedEnv += `\nAGENTVAULT_DEVELOPER_API_KEY=${issued.token}\n`;
    }

    if (updatedEnv.includes("AGENTVAULT_DEVELOPER_API_TOKEN=")) {
      updatedEnv = updatedEnv.replace(
        /AGENTVAULT_DEVELOPER_API_TOKEN=.*/,
        `AGENTVAULT_DEVELOPER_API_TOKEN=${issued.token}`
      );
    } else {
      updatedEnv += `AGENTVAULT_DEVELOPER_API_TOKEN=${issued.token}\n`;
    }

    if (updatedEnv.includes("AGENTVAULT_DEVELOPER_VAULT=")) {
      updatedEnv = updatedEnv.replace(
        /AGENTVAULT_DEVELOPER_VAULT=.*/,
        `AGENTVAULT_DEVELOPER_VAULT=${DEVNET_ACCEPTANCE_VAULT}`
      );
    } else {
      updatedEnv += `AGENTVAULT_DEVELOPER_VAULT=${DEVNET_ACCEPTANCE_VAULT}\n`;
    }

    writeFileSync(cfgPath, updatedEnv, { mode: 0o600 });

    console.log("====================================================");
    console.log("   Developer API Key Successfully Issued & Stored   ");
    console.log("====================================================");
    console.log(`Key ID:            ${issued.keyId}`);
    console.log(`Vault:             ${DEVNET_ACCEPTANCE_VAULT}`);
    console.log(`Scope:             payments:request`);
    console.log(`Expires At:        ${new Date(expiresAt).toISOString()}`);
    console.log(`Config File:       ${cfgPath} (mode 0600)`);
    console.log("====================================================");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Issuance error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
