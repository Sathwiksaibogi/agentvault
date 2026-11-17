import { createApiDatabase, verifyApiDatabase } from "./api-database.js";

async function main(): Promise<void> {
  const database = createApiDatabase();

  try {
    await verifyApiDatabase(database);
    console.log("PASS: PostgreSQL authentication readiness verified");
  } finally {
    await database.pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "FAIL:",
    error instanceof Error ? error.message : "Unknown error"
  );
  process.exitCode = 1;
});
