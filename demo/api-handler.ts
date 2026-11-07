import type {
  IncomingMessage,
  ServerResponse,
  RequestListener,
} from "node:http";
import { issueDeveloperApiKey } from "./api-key-issuance";

import { authenticateManagementOwner } from "./api-management-auth";

import {
  listManagedDeveloperApiKeys,
  revokeManagedDeveloperApiKey,
} from "./api-key-management";

import type { DeveloperApiKeyRepository } from "./api-key-repository";

import type { ApiCredentials } from "./api-auth";
import { authorizeApiRequestAsync } from "./api-async-guard";

import type { DeveloperApiKeyLookup } from "./api-key-resolver";

export type ApiDataReaders = {
  getTreasuryData: () => Promise<unknown>;
  getAgentsData: () => Promise<unknown>;
  getWorkflowIds: () => string[];
  getWorkflowData: (requestId: string) => Promise<unknown | null>;
  getActivityData: () => Promise<unknown>;
};

export type ApiHandlerConfig = {
  network: string;
  runtimeVault: string;
  credentials: ApiCredentials;
  readers: ApiDataReaders;

  lookupDeveloperKey?: DeveloperApiKeyLookup;
  now?: () => number;

  cachedRead: <T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs?: number
  ) => Promise<T>;

  managementRepository?: Pick<
    DeveloperApiKeyRepository,
    "listByPrincipal" | "create" | "revokeForVault"
  >;
};

function sendJson(
  response: ServerResponse,
  status: number,
  data: unknown
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  response.end(JSON.stringify(data));
}

async function readManagementJsonBody(
  request: IncomingMessage
): Promise<unknown> {
  const MAX_BYTES = 4096;
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    size += buffer.length;

    if (size > MAX_BYTES) {
      throw new Error("Invalid request body");
    }

    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid request body");
  }
}

export function createApiHandler(config: ApiHandlerConfig): RequestListener {
  const {
    network,
    runtimeVault,
    credentials,
    readers,
    cachedRead,
    lookupDeveloperKey,
    managementRepository,
    now,
  } = config;

  return async (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

    if (pathname === "/api/keys/revoke") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (!managementRepository?.revokeForVault) {
        sendJson(response, 503, {
          error: "Credential management unavailable",
        });
        return;
      }

      const issuer = authenticateManagementOwner(
        request,
        credentials,
        runtimeVault
      );

      if (!issuer) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      const contentType = request.headers["content-type"];

      if (
        typeof contentType !== "string" ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
      ) {
        sendJson(response, 415, { error: "Unsupported media type" });
        return;
      }

      let body: unknown;

      try {
        body = await readManagementJsonBody(request);
      } catch {
        sendJson(response, 400, { error: "Invalid request body" });
        return;
      }

      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        sendJson(response, 400, { error: "Invalid request body" });
        return;
      }

      const input = body as Record<string, unknown>;

      if (
        Object.keys(input).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(input, "keyId") ||
        typeof input.keyId !== "string"
      ) {
        sendJson(response, 400, {
          error: "Invalid revocation parameters",
        });
        return;
      }

      const keyId = input.keyId;
      const revokedAt = now?.() ?? Date.now();

      // Validate before touching the repository.
      if (
        !/^[a-f0-9]{24}$/.test(keyId) ||
        !Number.isSafeInteger(revokedAt) ||
        revokedAt < 0
      ) {
        sendJson(response, 400, {
          error: "Invalid revocation parameters",
        });
        return;
      }

      try {
        const revoked = await revokeManagedDeveloperApiKey({
          issuer,
          keyId,
          vault: runtimeVault,
          revokedAt,
          repository: managementRepository,
        });

        if (!revoked) {
          // Do not distinguish unknown, already-revoked,
          // or unauthorized-vault credentials.
          sendJson(response, 404, { error: "Credential not found" });
          return;
        }

        sendJson(response, 200, { revoked: true });
      } catch {
        console.error("Credential revocation failed");

        sendJson(response, 503, {
          error: "Credential revocation temporarily unavailable",
        });
      }

      return;
    }

    if (pathname === "/api/keys") {
      // Explicitly restrict this management route to GET.
      if (request.method !== "GET" && request.method !== "POST") {
        sendJson(response, 405, {
          error: "Method not allowed",
        });
        return;
      }

      // No management capability without a configured repository.
      if (!managementRepository) {
        sendJson(response, 503, {
          error: "Credential management unavailable",
        });
        return;
      }

      // Derive owner identity exclusively from trusted authentication.
      const issuer = authenticateManagementOwner(
        request,
        credentials,
        runtimeVault
      );

      if (!issuer) {
        sendJson(response, 401, {
          error: "Unauthorized",
        });
        return;
      }

      if (request.method === "POST") {
        if (!managementRepository.create) {
          sendJson(response, 503, {
            error: "Credential management unavailable",
          });
          return;
        }

        const contentType = request.headers["content-type"];

        if (
          typeof contentType !== "string" ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
        ) {
          sendJson(response, 415, {
            error: "Unsupported media type",
          });
          return;
        }

        let body: unknown;

        try {
          body = await readManagementJsonBody(request);
        } catch {
          sendJson(response, 400, {
            error: "Invalid request body",
          });
          return;
        }

        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          sendJson(response, 400, {
            error: "Invalid request body",
          });
          return;
        }

        const input = body as Record<string, unknown>;
        const fields = Object.keys(input);

        // Never accept vault, scopes, issuer, or other authority
        // information from the HTTP request.
        if (
          fields.length !== 2 ||
          !fields.includes("principalId") ||
          !fields.includes("expiresAt")
        ) {
          sendJson(response, 400, {
            error: "Invalid issuance parameters",
          });
          return;
        }

        const principalId = input.principalId;
        const expiresAt = input.expiresAt;
        const issuedAt = now?.() ?? Date.now();

        if (
          typeof principalId !== "string" ||
          principalId.length === 0 ||
          principalId.length > 128 ||
          principalId.trim() !== principalId ||
          typeof expiresAt !== "number" ||
          !Number.isSafeInteger(expiresAt) ||
          !Number.isSafeInteger(issuedAt) ||
          issuedAt < 0 ||
          expiresAt <= issuedAt
        ) {
          sendJson(response, 400, {
            error: "Invalid issuance parameters",
          });
          return;
        }

        try {
          const issued = await issueDeveloperApiKey({
            issuer,
            principalId,
            vault: runtimeVault,
            scopes: ["activity:read"],
            expiresAt,
            now: issuedAt,
            repository: managementRepository,
          });

          sendJson(response, 201, issued);
        } catch {
          // Never log generated tokens, database errors, or
          // sensitive credential material.
          console.error("Credential issuance failed");

          sendJson(response, 503, {
            error: "Credential issuance temporarily unavailable",
          });
        }

        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      // Reject missing or duplicate principalId parameters.
      const principalIds = url.searchParams.getAll("principalId");

      if (principalIds.length !== 1) {
        sendJson(response, 400, {
          error: "Invalid principal ID",
        });
        return;
      }

      const principalId = principalIds[0];

      if (
        principalId.length === 0 ||
        principalId.length > 128 ||
        principalId.trim() !== principalId
      ) {
        sendJson(response, 400, {
          error: "Invalid principal ID",
        });
        return;
      }

      try {
        const keys = await listManagedDeveloperApiKeys({
          issuer,
          principalId,
          vault: runtimeVault,
          repository: managementRepository,
        });

        sendJson(response, 200, { keys });
      } catch {
        // Never expose raw database errors in HTTP responses or logs.
        console.error("Credential listing failed");

        sendJson(response, 503, {
          error: "Credential management temporarily unavailable",
        });
      }

      return;
    }

    const authorization = await authorizeApiRequestAsync(request, pathname, {
      credentials,
      runtimeVault,
      lookupDeveloperKey,
      now,
    });

    if (authorization.allowed === false) {
      sendJson(response, authorization.status, {
        error: authorization.error,
      });
      return;
    }

    if (pathname === "/health") {
      sendJson(response, 200, {
        service: "agentvault-api",
        network,
        mode: "read-only",
        status: "running",
      });
      return;
    }

    if (pathname === "/api/treasury") {
      try {
        const result = await cachedRead(
          "treasury",
          readers.getTreasuryData,
          30_000
        );
        sendJson(response, 200, result);
      } catch (error) {
        console.error(
          "Treasury read failed:",
          error instanceof Error ? error.message : error
        );
        sendJson(response, 503, {
          error: "Treasury data temporarily unavailable",
        });
      }
      return;
    }

    if (pathname === "/api/agents") {
      try {
        const result = await cachedRead(
          "agents",
          readers.getAgentsData,
          30_000
        );
        sendJson(response, 200, result);
      } catch (error) {
        console.error(
          "Agent read failed:",
          error instanceof Error ? error.message : error
        );
        sendJson(response, 503, {
          error: "Agent data temporarily unavailable",
        });
      }
      return;
    }

    if (pathname === "/api/workflows") {
      try {
        const requestIds = readers.getWorkflowIds();

        sendJson(response, 200, {
          network,
          requestIds,
        });
      } catch (error) {
        console.error(
          "Workflow list failed:",
          error instanceof Error ? error.message : error
        );

        sendJson(response, 503, {
          error: "Workflow list temporarily unavailable",
        });
      }

      return;
    }

    const workflowMatch = pathname.match(
      /^\/api\/workflows\/([a-zA-Z0-9_-]{8,64})$/
    );

    if (workflowMatch) {
      try {
        const requestId = workflowMatch[1];

        const result = await cachedRead(
          `workflow:${requestId}`,
          () => readers.getWorkflowData(requestId),
          15_000
        );

        if (result === null) {
          sendJson(response, 404, {
            error: "Workflow not found",
          });
          return;
        }

        sendJson(response, 200, result);
      } catch (error) {
        console.error(
          "Workflow status failed:",
          error instanceof Error ? error.message : error
        );
        sendJson(response, 503, {
          error: "Workflow status temporarily unavailable",
        });
      }
      return;
    }

    if (pathname === "/api/activity") {
      try {
        const result = await cachedRead(
          "activity",
          readers.getActivityData,
          60_000
        );
        sendJson(response, 200, result);
      } catch (error) {
        console.error(
          "Activity read failed:",
          error instanceof Error ? error.message : error
        );
        sendJson(response, 503, {
          error: "Activity data temporarily unavailable",
        });
      }
      return;
    }

    sendJson(response, 404, {
      error: "Endpoint not found",
    });
  };
}
