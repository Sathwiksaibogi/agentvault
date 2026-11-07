import assert from "node:assert/strict";
import { test } from "node:test";

import { createApiReadCache } from "./api-read-cache";

test("a stalled cache loader times out and permits a retry", async () => {
  const cache = createApiReadCache({ timeoutMs: 30 });

  let attempts = 0;

  const loader = async (): Promise<string> => {
    attempts += 1;

    if (attempts === 1) {
      return new Promise<string>(() => {});
    }

    return "recovered";
  };

  await assert.rejects(cache.cachedRead("treasury", loader), /timed out/);

  const result = await cache.cachedRead("treasury", loader);

  assert.equal(result, "recovered");
  assert.equal(attempts, 2);
});

test("concurrent requests for the same key share one loader", async () => {
  const cache = createApiReadCache({ timeoutMs: 1000 });

  let calls = 0;
  let resolveLoader!: (value: string) => void;

  const loader = () => {
    calls += 1;

    return new Promise<string>((resolve) => {
      resolveLoader = resolve;
    });
  };

  const first = cache.cachedRead("agents", loader);
  const second = cache.cachedRead("agents", loader);

  // Allow the loader microtask to execute.
  await Promise.resolve();

  assert.equal(calls, 1);

  resolveLoader("shared");

  const results = await Promise.all([first, second]);

  assert.deepEqual(results, ["shared", "shared"]);
  assert.equal(calls, 1);
});

test("a late timed-out loader cannot overwrite a newer result", async () => {
  const cache = createApiReadCache({ timeoutMs: 30 });

  let resolveOld!: (value: string) => void;

  const oldLoader = () =>
    new Promise<string>((resolve) => {
      resolveOld = resolve;
    });

  const first = cache.cachedRead("treasury", oldLoader);

  await assert.rejects(first, /timed out/);

  const newer = await cache.cachedRead("treasury", async () => "new-value");

  assert.equal(newer, "new-value");

  resolveOld("old-value");

  await new Promise<void>((resolve) => setImmediate(resolve));

  const cached = await cache.cachedRead("treasury", async () => "unexpected");

  assert.equal(cached, "new-value");
});

test("expired cached values are refreshed", async () => {
  const cache = createApiReadCache({ timeoutMs: 1000 });

  let calls = 0;

  const loader = async () => {
    calls += 1;
    return calls;
  };

  assert.equal(await cache.cachedRead("agents", loader, 20), 1);
  assert.equal(await cache.cachedRead("agents", loader, 20), 1);

  await new Promise<void>((resolve) => setTimeout(resolve, 30));

  assert.equal(await cache.cachedRead("agents", loader, 20), 2);
  assert.equal(calls, 2);
});

test("failed loaders are not cached and can be retried", async () => {
  const cache = createApiReadCache({ timeoutMs: 1000 });

  let calls = 0;

  const loader = async () => {
    calls += 1;

    if (calls === 1) {
      throw new Error("RPC unavailable");
    }

    return "recovered";
  };

  await assert.rejects(cache.cachedRead("agents", loader), /RPC unavailable/);

  assert.equal(await cache.cachedRead("agents", loader), "recovered");

  assert.equal(calls, 2);
});
