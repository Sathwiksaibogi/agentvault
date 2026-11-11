import type { Agent, AgentVaultClientOptions, Treasury } from "./types.js";

export class AgentVaultHttpError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
  ) {
    super(`AgentVault API returned HTTP ${status} for ${path}`);
    this.name = "AgentVaultHttpError";
  }
}

export class AgentVaultTransportError extends Error {
  constructor(public readonly path: string) {
    // Do not leak credentials or a URL embedded in a lower-level fetch error.
    super(`AgentVault API transport failed for ${path}`);
    this.name = "AgentVaultTransportError";
  }
}

export class AgentVaultProtocolError extends Error {
  constructor(public readonly path: string) {
    super(`AgentVault API returned an unexpected JSON response for ${path}`);
    this.name = "AgentVaultProtocolError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUnsignedIntegerText(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTreasury(value: unknown): value is Treasury {
  if (!isObject(value)) return false;
  return (
    isText(value.network) &&
    isText(value.vault) &&
    isText(value.owner) &&
    isText(value.tokenMint) &&
    isText(value.treasury) &&
    isText(value.vaultId) &&
    isInteger(value.decimals) &&
    typeof value.paused === "boolean" &&
    isUnsignedIntegerText(value.balanceBaseUnits) &&
    isUnsignedIntegerText(value.reservedBaseUnits) &&
    isUnsignedIntegerText(value.availableBaseUnits)
  );
}

function isAgent(value: unknown): value is Agent {
  if (!isObject(value) || !isObject(value.task)) return false;
  const task = value.task;
  return (
    isText(value.id) &&
    isText(value.name) &&
    isText(value.workflow) &&
    isText(value.authority) &&
    isText(value.agentPda) &&
    typeof value.active === "boolean" &&
    isInteger(task.taskId) &&
    isText(task.taskPda) &&
    typeof task.active === "boolean" &&
    isText(task.recipient) &&
    isUnsignedIntegerText(task.budgetBaseUnits) &&
    isUnsignedIntegerText(task.spentBaseUnits) &&
    isUnsignedIntegerText(task.remainingBaseUnits) &&
    isUnsignedIntegerText(task.nextNonce) &&
    isUnsignedIntegerText(task.expiresAtUnix)
  );
}

export class AgentVaultClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AgentVaultClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new TypeError("baseUrl must be an absolute HTTP(S) origin");
    }

    const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(
      url.hostname.toLowerCase(),
    );
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new TypeError("baseUrl must be an HTTPS origin or a local-loopback HTTP origin");
    }
    if (typeof options.token !== "string" || !options.token || /\s/.test(options.token)) {
      throw new TypeError("token must be a non-empty Bearer token without whitespace");
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new RangeError("timeoutMs must be an integer from 1 to 120000");
    }

    this.origin = url.origin;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  /** Read-only treasury view. No payment or key-management actions are exposed. */
  async getTreasury(): Promise<Treasury> {
    const path = "/api/treasury";
    const body = await this.getJson(path);
    if (!isTreasury(body)) throw new AgentVaultProtocolError(path);
    return body;
  }

  /** Read-only agent/task summaries. Access depends on the server-side role policy. */
  async listAgents(): Promise<Agent[]> {
    const path = "/api/agents";
    const body = await this.getJson(path);
    if (!isObject(body) || !Array.isArray(body.agents) || !body.agents.every(isAgent)) {
      throw new AgentVaultProtocolError(path);
    }
    return body.agents;
  }

  private async getJson(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${this.token}` },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AgentVaultTransportError(path);
    }
    if (!response.ok) throw new AgentVaultHttpError(path, response.status);
    try {
      return await response.json();
    } catch {
      throw new AgentVaultProtocolError(path);
    }
  }
}
