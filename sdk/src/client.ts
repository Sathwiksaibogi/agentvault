import type {
  ActivityEntry,
  Agent,
  AgentVaultClientOptions,
  Treasury,
  WorkflowStatus,
} from "./types.js";

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

// Match the API router's workflow ID rule; reject invalid IDs before any request.
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  if (
    !isObject(value) ||
    !isObject(value.approval) ||
    !isObject(value.aiDecision) ||
    !isObject(value.execution)
  ) return false;
  const { approval, aiDecision, execution } = value;
  const payment = execution.payment;
  return (
    isRequestId(value.requestId) &&
    isText(value.assignedAgent) &&
    isText(value.workflowKind) &&
    isInteger(value.taskId) &&
    isInteger(value.amountBaseUnits) &&
    isText(value.network) &&
    isText(value.recipient) &&
    typeof approval.signatureVerified === "boolean" &&
    typeof approval.currentlyValid === "boolean" &&
    isInteger(approval.expiresAtUnix) &&
    typeof aiDecision.receiptFilePresent === "boolean" &&
    isText(aiDecision.verification) &&
    isText(execution.journalStatus) &&
    (payment === null ||
      (isObject(payment) &&
        isText(payment.signature) &&
        isText(payment.recoveryState) &&
        isInteger(payment.amountBaseUnits) &&
        isUnsignedIntegerText(payment.nonce)))
  );
}

function isActivityEntry(value: unknown): value is ActivityEntry {
  if (!isObject(value)) return false;
  return (
    isText(value.signature) &&
    isInteger(value.slot) &&
    (value.blockTimeUnix === null || isInteger(value.blockTimeUnix)) &&
    isText(value.agentId) &&
    isText(value.workflow) &&
    isInteger(value.taskId) &&
    isText(value.taskPda) &&
    typeof value.succeeded === "boolean" &&
    isText(value.explorerUrl)
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

  /** List workflow IDs visible to the authenticated principal. */
  async listWorkflowIds(): Promise<string[]> {
    const path = "/api/workflows";
    const body = await this.getJson(path);
    if (
      !isObject(body) ||
      !Array.isArray(body.requestIds) ||
      !body.requestIds.every(isRequestId)
    ) {
      throw new AgentVaultProtocolError(path);
    }
    return body.requestIds;
  }

  /** Inspect a previously authorized workflow; never broadcasts a payment. */
  async getWorkflow(requestId: string): Promise<WorkflowStatus> {
    if (!isRequestId(requestId)) {
      throw new TypeError("requestId must match [a-zA-Z0-9_-]{8,64}");
    }
    const path = `/api/workflows/${encodeURIComponent(requestId)}`;
    const body = await this.getJson(path);
    if (!isWorkflowStatus(body) || body.requestId !== requestId) {
      throw new AgentVaultProtocolError(path);
    }
    return body;
  }

  /** Read recent on-chain activity. The API may return an empty array. */
  async listActivity(): Promise<ActivityEntry[]> {
    const path = "/api/activity";
    const body = await this.getJson(path);
    if (
      !isObject(body) ||
      !Array.isArray(body.activity) ||
      !body.activity.every(isActivityEntry)
    ) {
      throw new AgentVaultProtocolError(path);
    }
    return body.activity;
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
