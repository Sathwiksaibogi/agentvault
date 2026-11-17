import assert from "node:assert/strict";
import { test } from "node:test";

import { mapWithConcurrency } from "./api-concurrency";

test("limits simultaneous operations to the configured maximum", async () => {
  let active = 0;
  let peak = 0;

  const items = Array.from({ length: 12 }, (_, i) => i);

  const results = await mapWithConcurrency(items, 4, async (item) => {
    active += 1;
    peak = Math.max(peak, active);

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return item * 2;
    } finally {
      active -= 1;
    }
  });

  assert.deepEqual(
    results,
    items.map((item) => item * 2)
  );

  assert.equal(peak, 4);
  assert.equal(active, 0);
});

test("preserves input ordering despite out-of-order completion", async () => {
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (item) => {
    await new Promise<void>((resolve) => setTimeout(resolve, (5 - item) * 10));

    return item * 10;
  });

  assert.deepEqual(results, [10, 20, 30, 40]);
});

test("rejects invalid concurrency limits", async () => {
  await assert.rejects(
    mapWithConcurrency([1], 0, async (item) => item),
    /Invalid concurrency limit/
  );

  await assert.rejects(
    mapWithConcurrency([1], -1, async (item) => item),
    /Invalid concurrency limit/
  );

  await assert.rejects(
    mapWithConcurrency([1], 1.5, async (item) => item),
    /Invalid concurrency limit/
  );
});

test("returns an empty result for empty input", async () => {
  const results = await mapWithConcurrency([], 4, async () => "unexpected");

  assert.deepEqual(results, []);
});

test("propagates worker failures", async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) {
        throw new Error("RPC unavailable");
      }

      return item;
    }),
    /RPC unavailable/
  );
});
