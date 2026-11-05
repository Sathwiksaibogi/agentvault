import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { request as httpRequest } from "node:http";

import { authorizeApiRequest } from "./api-request-guard";
import type { ApiCredentials } from "./api-auth";

const VAULT_A = "11111111111111111111111111111111";
const VAULT_B = "SysvarC1ock11111111111111111111111111111111";

const credentials: ApiCredentials = {
  ownerToken: "a".repeat(64),
  developerToken: "b".repeat(64),
  developerVault: VAULT_A,
};

async function withServer(
  runtimeVault: string,
  run: (baseUrl: string) => Promise<void>
) {
  let handlerCalls = 0;

  const server: Server = createServer((request, response) => {
    const pathname = new URL(
      request.url ?? "/",
      "http://127.0.0.1"
    ).pathname;

    const authorization = authorizeApiRequest(
      request,
      pathname,
      credentials,
      runtimeVault
    );

    if (authorization.allowed === false) {
      response.writeHead(authorization.status, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({ error: authorization.error }));
      return;
    }

    handlerCalls++;

    response.writeHead(200, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify({ ok: true }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  return handlerCalls;
}

test("public health endpoint works without credentials", async () => {
  const calls = await withServer(VAULT_A, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
  });

  assert.equal(calls, 1);
});

test("unauthenticated requests never reach handlers", async () => {
  const calls = await withServer(VAULT_A, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/treasury`);
    assert.equal(response.status, 401);
  });

  assert.equal(calls, 0);
});

test("developer cannot access owner-only endpoints", async () => {
  const calls = await withServer(VAULT_A, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/treasury`, {
      headers: {
        Authorization: `Bearer ${credentials.developerToken}`,
      },
    });

    assert.equal(response.status, 403);
  });

  assert.equal(calls, 0);
});

test("developer can access activity for the assigned vault", async () => {
  const calls = await withServer(VAULT_A, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/activity`, {
      headers: {
        Authorization: `Bearer ${credentials.developerToken}`,
      },
    });

    assert.equal(response.status, 200);
  });

  assert.equal(calls, 1);
});

test("developer cannot access another vault", async () => {
  const calls = await withServer(VAULT_B, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/activity`, {
      headers: {
        Authorization: `Bearer ${credentials.developerToken}`,
      },
    });

    assert.equal(response.status, 403);
  });

  assert.equal(calls, 0);
});

test("owner can access the treasury", async () => {
  const calls = await withServer(VAULT_A, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/treasury`, {
      headers: {
        Authorization: `Bearer ${credentials.ownerToken}`,
      },
    });

    assert.equal(response.status, 200);
  });

  assert.equal(calls, 1);
});

test("unknown API routes are denied", async () => {
  const calls = await withServer(VAULT_A, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/unknown`, {
      headers: {
        Authorization: `Bearer ${credentials.ownerToken}`,
      },
    });

    assert.equal(response.status, 403);
  });

  assert.equal(calls, 0);
});

test("non-GET requests never reach handlers", async () => {
  const calls = await withServer(VAULT_A, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/treasury`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.ownerToken}`,
      },
    });

    assert.equal(response.status, 405);
  });

  assert.equal(calls, 0);
});

test("duplicate Authorization headers are rejected over HTTP", async () => {
  const calls = await withServer(VAULT_A, async (baseUrl) => {
    const response = await new Promise<{
      status: number | undefined;
      body: string;
    }>((resolve, reject) => {
      const req = httpRequest(
        `${baseUrl}/api/treasury`,
        {
          method: "GET",
          headers: {
            Authorization: [
              `Bearer ${credentials.ownerToken}`,
              `Bearer ${credentials.developerToken}`,
            ],
          },
        },
        (res) => {
          let body = "";

          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });

          res.on("end", () => {
            resolve({
              status: res.statusCode,
              body,
            });
          });

          res.on("error", reject);
        }
      );

      req.on("error", reject);
      req.end();
    });

    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(response.body), {
      error: "Unauthorized",
    });
  });

  assert.equal(calls, 0);
});