import type { Server } from "node:http";

/**
 * Applies explicit HTTP connection limits to the AgentVault API.
 *
 * These limits bound request reception and connection reuse.
 * They do not replace application-level RPC/database timeouts.
 */
export function configureApiHttpServer(server: Server): void {
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
}
