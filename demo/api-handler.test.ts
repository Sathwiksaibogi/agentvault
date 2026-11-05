import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { createApiHandler, type ApiDataReaders } from "./api-handler";
import type { ApiCredentials } from "./api-auth";

const VAULT_A = "11111111111111111111111111111111";
const VAULT_B = "SysvarC1ock11111111111111111111111111111111";

const credentials: ApiCredentials = {
  ownerToken: "a".repeat(64),
  developerToken: "b".repeat(64),
  developerVault: VAULT_A,
};

const REQUEST_ID = "workflow123";

async function withApi(
  run: (
    baseUrl: string,
    calls: string[]
  ) => Promise<void>,
  options: {
    runtimeVault?: string;
    readerFailure?: boolean;
  } = {}
): Promise<void> {
  const calls: string[] = [];

  const readers: ApiDataReaders = {
    getTreasuryData: async () => {
      calls.push("treasury");
      if (options.readerFailure) {
        throw new Error("Sensitive internal RPC failure");
      }
      return { balanceBaseUnits: "1000" };
    },

    getAgentsData: async () => {
      calls.push("agents");
      return { agents: [] };
    },

    getWorkflowIds: () => {
      calls.push("workflowIds");
      return [REQUEST_ID];
    },

    getWorkflowData: async (requestId) => {
      calls.push(`workflow:${requestId}`);
      return requestId === REQUEST_ID
        ? { requestId, status: "verified" }
        : null;
    },

    getActivityData: async () => {
      calls.push("activity");
      return { activity: [] };
    },
  };

  const server = createServer(
    createApiHandler({
      network: "devnet",
      runtimeVault: options.runtimeVault ?? VAULT_A,
      credentials,
      readers,

      cachedRead: async <T>(
        _key: string,
        loader: () => Promise<T>,
        _ttlMs?: number
      ): Promise<T> => loader(),
    })
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error ? reject(error) : resolve()
      );
    });
  }
}

function auth(token: string) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

test("real handler serves public health endpoint", async () => {
  await withApi(async (url, calls) => {
    const response = await fetch(`${url}/health`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "running");
    assert.deepEqual(calls, []);
  });
});

test("unauthenticated treasury request never reaches reader", async () => {
  await withApi(async (url, calls) => {
    const response = await fetch(`${url}/api/treasury`);

    assert.equal(response.status, 401);
    assert.deepEqual(calls, []);
  });
});

test("developer cannot execute owner-only treasury reader", async () => {
  await withApi(async (url, calls) => {
    const response = await fetch(`${url}/api/treasury`, {
      headers: auth(credentials.developerToken),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(calls, []);
  });
});

test("owner can read treasury through actual routing", async () => {
  await withApi(async (url, calls) => {
    const response = await fetch(`${url}/api/treasury`, {
      headers: auth(credentials.ownerToken),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      balanceBaseUnits: "1000",
    });
    assert.deepEqual(calls, ["treasury"]);
  });
});

test("developer can read assigned-vault activity", async () => {
  await withApi(async (url, calls) => {
    const response = await fetch(`${url}/api/activity`, {
      headers: auth(credentials.developerToken),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["activity"]);
  });
});

test("cross-vault developer request never reaches activity reader", async () => {
  await withApi(
    async (url, calls) => {
      const response = await fetch(`${url}/api/activity`, {
        headers: auth(credentials.developerToken),
      });

      assert.equal(response.status, 403);
      assert.deepEqual(calls, []);
    },
    { runtimeVault: VAULT_B }
  );
});

test("workflow list and detail use correct readers", async () => {
  await withApi(async (url, calls) => {
    const headers = auth(credentials.ownerToken);

    const list = await fetch(`${url}/api/workflows`, {
      headers,
    });

    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), {
      network: "devnet",
      requestIds: [REQUEST_ID],
    });

    const detail = await fetch(
      `${url}/api/workflows/${REQUEST_ID}`,
      { headers }
    );

    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), {
      requestId: REQUEST_ID,
      status: "verified",
    });

    assert.deepEqual(calls, [
      "workflowIds",
      `workflow:${REQUEST_ID}`,
    ]);
  });
});

test("missing workflow returns 404", async () => {
  await withApi(async (url, calls) => {
    const response = await fetch(
      `${url}/api/workflows/missing123`,
      { headers: auth(credentials.ownerToken) }
    );

    assert.equal(response.status, 404);
    assert.deepEqual(calls, ["workflow:missing123"]);
  });
});

test("treasury reader failures return sanitized 503", async () => {
  await withApi(
    async (url, calls) => {
      const response = await fetch(`${url}/api/treasury`, {
        headers: auth(credentials.ownerToken),
      });

      assert.equal(response.status, 503);

      const body = await response.text();

      assert.deepEqual(JSON.parse(body), {
        error: "Treasury data temporarily unavailable",
      });

      assert.ok(!body.includes("Sensitive internal RPC failure"));
      assert.deepEqual(calls, ["treasury"]);
    },
    { readerFailure: true }
  );
});

test("unknown protected routes never invoke readers", async () => {
  await withApi(async (url, calls) => {
    const response = await fetch(`${url}/api/unknown`, {
      headers: auth(credentials.ownerToken),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(calls, []);
  });
});

test("non-GET requests never invoke readers", async () => {
  await withApi(async (url, calls) => {
    const response = await fetch(`${url}/api/treasury`, {
      method: "POST",
      headers: auth(credentials.ownerToken),
    });

    assert.equal(response.status, 405);
    assert.deepEqual(calls, []);
  });
});