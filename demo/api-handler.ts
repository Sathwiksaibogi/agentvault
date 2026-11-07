import type {
  IncomingMessage,
  ServerResponse,
  RequestListener,
} from "node:http";

import { authenticateManagementOwner } from "./api-management-auth";

import { listManagedDeveloperApiKeys } from "./api-key-management";

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

  managementRepository?: Pick<DeveloperApiKeyRepository, "listByPrincipal">;
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

    if (pathname === "/api/keys") {
      // Explicitly restrict this management route to GET.
      if (request.method !== "GET") {
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
