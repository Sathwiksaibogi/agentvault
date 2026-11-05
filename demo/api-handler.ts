import type {
  IncomingMessage,
  ServerResponse,
  RequestListener,
} from "node:http";

import type { ApiCredentials } from "./api-auth";
import { authorizeApiRequest } from "./api-request-guard";

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
  cachedRead: <T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs?: number
  ) => Promise<T>;
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

export function createApiHandler(
  config: ApiHandlerConfig
): RequestListener {
  const {
    network,
    runtimeVault,
    credentials,
    readers,
    cachedRead,
  } = config;

  return async (
    request: IncomingMessage,
    response: ServerResponse
  ) => {
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