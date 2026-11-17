import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentVaultClient,
  AgentVaultHttpError,
  AgentVaultProtocolError,
  AgentVaultTransportError,
} from "../dist/index.js";

const vault = "C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep";
const request = Object.freeze({
  requestId: "invoice_001",
  agentAuthority: "8xF8jf7n4WHVNekuEggo9Ekvt8NYEarNo1c9M6fFD7pY",
  taskId: "1",
  recipient: "CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc",
  amountBaseUnits: "18446744073709551615",
  expiresAtUnix: "1794579474",
  reason: "Report request",
});
const acceptance = Object.freeze({
  requestId: request.requestId,
  status: "received",
  duplicate: false,
  network: "devnet",
  vault,
  notice: "Request only; not approved, queued for execution, or paid",
});
const record = Object.freeze({
  version: 1,
  kind: "model-a-payment-intent",
  status: "received",
  network: "devnet",
  vault,
  principalId: "research-agent",
  createdAtUnix: 1794575000,
  request,
});
const urlRoot = "http://127.0.0.1:8787";
function client(fetchImpl) {
  return new AgentVaultClient({
    baseUrl: urlRoot,
    token: "private-developer-token",
    fetchImpl,
  });
}

test("POST sends only canonical payment fields, Bearer auth, and no redirects", async () => {
  let calls = 0;
  const sdk = client(async (url, options) => {
    calls++;
    assert.equal(url, `${urlRoot}/api/model-a/payment-intents`);
    assert.equal(options.method, "POST");
    assert.equal(
      options.headers.Authorization,
      "Bearer private-developer-token"
    );
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), request);
    return Response.json(acceptance, { status: 202 });
  });
  assert.deepEqual(await sdk.submitModelAPaymentIntent(request), acceptance);
  assert.equal(calls, 1);
});

test("identical retry response is received/duplicate, never paid", async () => {
  const sdk = client(async () =>
    Response.json({ ...acceptance, duplicate: true }, { status: 200 })
  );
  assert.deepEqual(await sdk.submitModelAPaymentIntent(request), {
    ...acceptance,
    duplicate: true,
  });
});

test("GET reads durable status with request terms, never infers execution", async () => {
  const sdk = client(async (url, options) => {
    assert.equal(
      url,
      `${urlRoot}/api/model-a/payment-intents/${request.requestId}`
    );
    assert.equal(options.method, "GET");
    assert.equal(
      options.headers.Authorization,
      "Bearer private-developer-token"
    );
    return Response.json(record);
  });
  assert.deepEqual(await sdk.getModelAPaymentIntent(request.requestId), record);
});

test("invalid request IDs, noncanonical amounts and extra keys fail before HTTP", async () => {
  let calls = 0;
  const sdk = client(async () => {
    calls++;
    return Response.json(acceptance, { status: 202 });
  });
  for (const bad of [
    { ...request, requestId: "../attack" },
    { ...request, requestId: "abc" },
    { ...request, amountBaseUnits: "0" },
    { ...request, amountBaseUnits: "0.1" },
    { ...request, amountBaseUnits: "0001" },
    { ...request, amountBaseUnits: "18446744073709551616" },
    { ...request, taskId: 1 },
    { ...request, recipient: "not-a-pubkey" },
    { ...request, expiresAtUnix: 178 },
    { ...request, reason: " trailing " },
    { ...request, vault },
  ]) {
    await assert.rejects(sdk.submitModelAPaymentIntent(bad), TypeError);
  }
  for (const bad of [
    "a",
    "../attack",
    "aa%2Fbb11",
    "1234567",
    "a".repeat(65),
  ]) {
    await assert.rejects(sdk.getModelAPaymentIntent(bad), TypeError);
  }
  assert.equal(calls, 0);
});

test("POST rejects misleading status, mismatched ID and forged payment status", async () => {
  for (const [status, payload] of [
    [202, { ...acceptance, status: "paid" }],
    [202, { ...acceptance, requestId: "invoice_999" }],
    [202, { ...acceptance, duplicate: true }],
    [200, { ...acceptance, duplicate: false }],
    [202, { ...acceptance, notice: "paid" }],
    [200, { ...acceptance, duplicate: true, network: "mainnet-beta" }],
  ]) {
    await assert.rejects(
      client(async () =>
        Response.json(payload, { status })
      ).submitModelAPaymentIntent(request),
      AgentVaultProtocolError
    );
  }
});

test("GET fails closed on wrong ID, non-received state and malformed stored amount", async () => {
  for (const payload of [
    { ...record, request: { ...request, requestId: "invoice_999" } },
    { ...record, status: "paid" },
    { ...record, request: { ...request, amountBaseUnits: "1.5" } },
    { ...record, principalId: "" },
    { ...record, version: 2 },
  ]) {
    await assert.rejects(
      client(async () => Response.json(payload)).getModelAPaymentIntent(
        request.requestId
      ),
      AgentVaultProtocolError
    );
  }
});

test("HTTP errors keep status and path without exposing secrets or server body", async () => {
  for (const status of [401, 403, 404, 409, 503]) {
    const sdk = client(async () =>
      Response.json({ error: "private-developer-token" }, { status })
    );
    await assert.rejects(sdk.submitModelAPaymentIntent(request), (error) => {
      assert.ok(error instanceof AgentVaultHttpError);
      assert.equal(error.status, status);
      assert.equal(error.path, "/api/model-a/payment-intents");
      assert.ok(!error.message.includes("private-developer-token"));
      return true;
    });
  }
});

test("transport failure does not retry POST; caller must reconcile by request ID", async () => {
  let calls = 0;
  const sdk = client(async () => {
    calls++;
    throw new Error("private-developer-token");
  });
  await assert.rejects(sdk.submitModelAPaymentIntent(request), (error) => {
    assert.ok(error instanceof AgentVaultTransportError);
    assert.equal(error.path, "/api/model-a/payment-intents");
    assert.ok(!error.message.includes("private-developer-token"));
    return true;
  });
  assert.equal(calls, 1);
});

test("malformed response JSON fails as protocol error", async () => {
  const sdk = client(async () => new Response("{no-json", { status: 202 }));
  await assert.rejects(
    sdk.submitModelAPaymentIntent(request),
    AgentVaultProtocolError
  );
  await assert.rejects(
    sdk.getModelAPaymentIntent(request.requestId),
    AgentVaultProtocolError
  );
});
