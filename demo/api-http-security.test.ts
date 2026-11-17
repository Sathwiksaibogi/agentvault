import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { configureApiHttpServer } from "./api-http-security";

test("configures bounded HTTP request and connection limits", () => {
  const server = createServer((_request, response) => {
    response.end("ok");
  });

  try {
    configureApiHttpServer(server);

    assert.equal(server.headersTimeout, 10_000);
    assert.equal(server.requestTimeout, 15_000);
    assert.equal(server.keepAliveTimeout, 5_000);
    assert.equal(server.maxHeadersCount, 64);
    assert.equal(server.maxRequestsPerSocket, 100);
  } finally {
    server.close();
  }
});

test("HTTP security configuration is safe to apply repeatedly", () => {
  const server = createServer((_request, response) => {
    response.end("ok");
  });

  try {
    configureApiHttpServer(server);
    configureApiHttpServer(server);

    assert.equal(server.headersTimeout, 10_000);
    assert.equal(server.requestTimeout, 15_000);
    assert.equal(server.keepAliveTimeout, 5_000);
    assert.equal(server.maxHeadersCount, 64);
    assert.equal(server.maxRequestsPerSocket, 100);
  } finally {
    server.close();
  }
});
