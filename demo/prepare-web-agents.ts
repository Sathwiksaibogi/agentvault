import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

// Devnet only. Private keys stay outside the Git repository.
assert.equal(
  process.env.AGENTVAULT_NETWORK,
  "devnet",
  "Set AGENTVAULT_NETWORK=devnet"
);

const PROGRAM_ID = new PublicKey(
  "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d"
);

const OWNER = new PublicKey("CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc");

const MINT = new PublicKey("Dm75S15mto6y3vNeXZ8FENayPCiSev7PqJBmSfZkQW38");

const VAULT_ID = BigInt(8001);

const EXPECTED_VAULT = new PublicKey(
  "C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep"
);

const EXPECTED_TREASURY = new PublicKey(
  "8yX2mqJcx5ECA2r4gDNkEvTUvAZp6VZvj1rs8t8X1jyp"
);

function encodeU64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

const [vault] = PublicKey.findProgramAddressSync(
  [new TextEncoder().encode("vault"), OWNER.toBytes(), encodeU64(VAULT_ID)],
  PROGRAM_ID
);

assert.ok(vault.equals(EXPECTED_VAULT), "Vault PDA mismatch");

const KEY_DIR = join(
  homedir(),
  ".config",
  "agentvault",
  "devnet",
  "web-vault-8001"
);

const PUBLIC_PATH = join(process.cwd(), "frontend", "src", "webAgents.ts");

const MANIFEST_PATH = join(KEY_DIR, "verified-public-manifest.json");

mkdirSync(KEY_DIR, {
  recursive: true,
  mode: 0o700,
});

chmodSync(KEY_DIR, 0o700);

function loadOrCreate(name: string): Keypair {
  const filePath = join(KEY_DIR, `${name}.json`);

  if (existsSync(filePath)) {
    chmodSync(filePath, 0o600);

    const bytes = JSON.parse(readFileSync(filePath, "utf8")) as number[];

    assert.equal(bytes.length, 64, `Invalid ${name} keypair file`);

    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }

  const keypair = Keypair.generate();

  writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)), {
    flag: "wx",
    mode: 0o600,
  });

  console.log(`Created private identity ${name}`);

  return keypair;
}

const agents = [
  {
    id: "agent-a",
    name: "Procurement",
    budgetBaseUnits: "150000",
  },
  {
    id: "agent-b",
    name: "Operations",
    budgetBaseUnits: "100000",
  },
].map((config) => {
  const signer = loadOrCreate(`web-${config.id}`);
  const recipient = loadOrCreate(`web-recipient-${config.id}`);

  return {
    ...config,
    authority: signer.publicKey.toBase58(),
    recipient: recipient.publicKey.toBase58(),
    taskId: "1",
  };
});

assert.notEqual(agents[0].authority, agents[1].authority);

assert.notEqual(agents[0].recipient, agents[1].recipient);

const existingSource = existsSync(PUBLIC_PATH)
  ? readFileSync(PUBLIC_PATH, "utf8")
  : null;

const config = {
  network: "devnet",
  programId: PROGRAM_ID.toBase58(),
  owner: OWNER.toBase58(),
  vaultId: VAULT_ID.toString(),
  vault: EXPECTED_VAULT.toBase58(),
  treasury: EXPECTED_TREASURY.toBase58(),
  mint: MINT.toBase58(),
  agents,
};

if (existsSync(MANIFEST_PATH)) {
  const previous = JSON.parse(
    readFileSync(MANIFEST_PATH, "utf8")
  ) as typeof config;

  assert.deepEqual(
    previous,
    config,
    "Public config does not match preserved identities"
  );
} else {
  if (existingSource) {
    throw new Error(
      "webAgents.ts already exists but verified manifest is missing"
    );
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(config, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
}

if (existingSource) {
  for (const agent of agents) {
    assert.ok(
      existingSource.includes(agent.authority),
      `Missing ${agent.id} authority`
    );

    assert.ok(
      existingSource.includes(agent.recipient),
      `Missing ${agent.id} recipient`
    );
  }

  console.log("Existing webAgents.ts retains expected public identities.");
} else {
  const content =
    "// PUBLIC addresses only. Never put private keys here.\n" +
    `export const webAgents = ${JSON.stringify(config, null, 2)} as const;\n`;

  writeFileSync(PUBLIC_PATH, content, {
    flag: "wx",
    mode: 0o644,
  });

  console.log("Created frontend/src/webAgents.ts");
}

console.log("\n=== WEB AGENT IDENTITIES ===");
console.log("Vault:", EXPECTED_VAULT.toBase58());

for (const agent of agents) {
  console.log(`\n${agent.name}`);
  console.log("Authority:", agent.authority);
  console.log("Recipient:", agent.recipient);
  console.log("Budget:", agent.budgetBaseUnits);
}

console.log(
  "\nPrivate keys stored under ~/.config/agentvault/devnet/web-vault-8001"
);

console.log("No transaction signed or submitted.");
