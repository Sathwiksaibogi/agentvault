import assert from "node:assert/strict";
import { test } from "node:test";

import { createRpcConcurrencyGate } from "./api-rpc-concurrency";

test("limits active RPC operations and preserves FIFO ordering", async () => {
  const gate = createRpcConcurrencyGate({
    maxActive: 2,
    maxQueued: 4,
    queueTimeoutMs: 1000,
  });

  let active = 0;
  let peak = 0;

  const started: number[] = [];

  const releases: Array<() => void> = [];

  const operations = Array.from({ length: 4 }, (_, index) =>
    gate.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(index);

      try {
        await new Promise<void>((resolve) => {
          releases[index] = resolve;
        });

        return index;
      } finally {
        active -= 1;
      }
    })
  );

  // The gate reserves slots synchronously, but workers begin
  // in a microtask.
  await Promise.resolve();

  assert.equal(active, 2);
  assert.deepEqual(started, [0, 1]);

  releases[0]();

  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(active, 2);

  releases[1]();

  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(active, 2);

  releases[2]();
  releases[3]();

  assert.deepEqual(await Promise.all(operations), [0, 1, 2, 3]);

  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test("rejects requests when the waiting queue is full", async () => {
  const gate = createRpcConcurrencyGate({
    maxActive: 1,
    maxQueued: 1,
    queueTimeoutMs: 1000,
  });

  let release!: () => void;

  const first = gate.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );

  const second = gate.run(async () => "second");

  await assert.rejects(
    gate.run(async () => "third"),
    /queue is full/
  );

  await Promise.resolve();
  release();

  await first;
  assert.equal(await second, "second");
});

test("removes cancelled requests from the waiting queue", async () => {
  const gate = createRpcConcurrencyGate({
    maxActive: 1,
    maxQueued: 1,
    queueTimeoutMs: 1000,
  });

  const controller = new AbortController();

  let release!: () => void;
  let cancelledOperationStarted = false;

  const first = gate.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );

  const cancelled = gate.run(async () => {
    cancelledOperationStarted = true;
  }, controller.signal);

  controller.abort(new Error("Caller cancelled"));

  await assert.rejects(cancelled, /Caller cancelled/);

  const replacement = gate.run(async () => "replacement");

  await Promise.resolve();
  release();

  await first;

  assert.equal(await replacement, "replacement");
  assert.equal(cancelledOperationStarted, false);
});

test("rejects queued requests after their waiting deadline", async () => {
  const gate = createRpcConcurrencyGate({
    maxActive: 1,
    maxQueued: 1,
    queueTimeoutMs: 20,
  });

  let release!: () => void;
  let timedOutOperationStarted = false;

  const first = gate.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );

  const timedOut = gate.run(async () => {
    timedOutOperationStarted = true;
  });

  await assert.rejects(timedOut, /queue timed out/);

  const replacement = gate.run(async () => "replacement");

  await Promise.resolve();
  release();

  await first;

  assert.equal(await replacement, "replacement");
  assert.equal(timedOutOperationStarted, false);
});

test("releases active slots when an operation fails", async () => {
  const gate = createRpcConcurrencyGate({
    maxActive: 1,
    maxQueued: 1,
    queueTimeoutMs: 1000,
  });

  const first = gate.run(async () => {
    throw new Error("RPC failed");
  });

  const second = gate.run(async () => "recovered");

  await assert.rejects(first, /RPC failed/);

  assert.equal(await second, "recovered");
});

test("rejects invalid concurrency configurations", () => {
  const invalid = [
    { maxActive: 0, maxQueued: 1, queueTimeoutMs: 100 },
    { maxActive: 1, maxQueued: -1, queueTimeoutMs: 100 },
    { maxActive: 1, maxQueued: 1, queueTimeoutMs: 0 },
    { maxActive: 1.5, maxQueued: 1, queueTimeoutMs: 100 },
  ];

  for (const options of invalid) {
    assert.throws(
      () => createRpcConcurrencyGate(options),
      /Invalid RPC concurrency configuration/
    );
  }
});

test("shutdown rejects queued operations and prevents new work", async () => {
  const gate = createRpcConcurrencyGate({
    maxActive: 1,
    maxQueued: 2,
    queueTimeoutMs: 1000,
  });

  let releaseActive!: () => void;
  let queuedStarted = false;

  const active = gate.run(
    () =>
      new Promise<string>((resolve) => {
        releaseActive = () => resolve("active completed");
      })
  );

  const queued = gate.run(async () => {
    queuedStarted = true;
    return "queued completed";
  });

  await Promise.resolve();

  gate.close();

  await assert.rejects(queued, /RPC concurrency gate is closed/);

  await assert.rejects(
    gate.run(async () => "new work"),
    /RPC concurrency gate is closed/
  );

  assert.equal(queuedStarted, false);

  releaseActive();

  assert.equal(await active, "active completed");
  assert.equal(queuedStarted, false);
});

test("shutdown is idempotent and preserves the original rejection reason", async () => {
  const gate = createRpcConcurrencyGate({
    maxActive: 1,
    maxQueued: 1,
    queueTimeoutMs: 1000,
  });

  let releaseActive!: () => void;

  const active = gate.run(
    () =>
      new Promise<void>((resolve) => {
        releaseActive = resolve;
      })
  );

  const queued = gate.run(async () => "queued");

  await Promise.resolve();

  const reason = new Error("API server shutting down");

  gate.close(reason);
  gate.close(new Error("Second shutdown"));

  await assert.rejects(queued, (error: unknown) => error === reason);

  await assert.rejects(
    gate.run(async () => "new request"),
    (error: unknown) => error === reason
  );

  releaseActive();
  await active;
});
