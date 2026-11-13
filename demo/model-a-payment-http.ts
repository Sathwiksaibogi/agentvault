/**
 * Local-development-only developer payment-intent API; NEVER executes payments.
 * Only explicit, single-vault, short-lived payments:request API keys may submit.
 * No legacy owner/developer Bearer token, session cookie, or activity-only key
 * can reach payment intake. Backend binds the vault from VERIFIED credentials.
 */
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import { extractDeveloperApiKeyId } from "./api-key-crypto";
import {
  resolveDeveloperApiKey,
  type DeveloperApiKeyLookup,
} from "./api-key-resolver";
import {
  receiveModelAPaymentIntent,
  readModelAPaymentIntent,
  PaymentIntentConflict,
  validateModelAPaymentIntent,
  type TrustedPaymentIntakeScope,
} from "./model-a-payment-intake";

export type ModelAPaymentHttpOptions = {
  fallbackHandler: RequestListener;
  lookupDeveloperKey: DeveloperApiKeyLookup;
  network: "devnet" | "localnet";
  runtimeDir: string;
  expectedGenesisHash: string;
  getGenesisHash: () => Promise<string>;
  checkPolicy: (args: {
    trustedScope: TrustedPaymentIntakeScope;
    input: unknown;
  }) => Promise<void>;
  now?: () => number;
};

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function bearer(req: IncomingMessage): string | null {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === "authorization") count++;
  }
  if (count !== 1 || typeof req.headers.authorization !== "string") return null;
  const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization);
  return match && extractDeveloperApiKeyId(match[1]) ? match[1] : null;
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw new Error("Unsupported content type");
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > 2048) throw new Error("Request too large");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function createModelAPaymentHttpHandler(
  options: ModelAPaymentHttpOptions
): RequestListener {
  const {
    fallbackHandler,
    lookupDeveloperKey,
    network,
    runtimeDir,
    expectedGenesisHash,
    getGenesisHash,
    checkPolicy,
    now = Date.now,
  } = options;
  const index = "/api/model-a/payment-intents";
  const itemPattern =
    /^\/api\/model-a\/payment-intents\/([A-Za-z0-9_-]{8,64})$/;
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = itemPattern.exec(url.pathname);
    if (url.pathname !== index && !match) {
      if (url.pathname.startsWith(`${index}/`)) {
        return void respond(res, 404, { error: "Endpoint not found" });
      }
      fallbackHandler(req, res);
      return;
    }
    const method = match ? "GET" : "POST";
    if (req.method !== method)
      return void respond(res, 405, { error: "Method not allowed" });
    if (url.search)
      return void respond(res, 400, { error: "Unexpected query" });
    if (network !== "devnet")
      return void respond(res, 503, { error: "Payment intake unavailable" });
    const token = bearer(req);
    if (!token) return void respond(res, 401, { error: "Unauthorized" });
    void (async () => {
      // Refuse unknown/revoked/expired API keys and all read-only credentials.
      let principal;
      try {
        principal = await resolveDeveloperApiKey(
          token,
          lookupDeveloperKey,
          now()
        );
      } catch {
        return void respond(res, 401, { error: "Unauthorized" });
      }
      if (!principal) return void respond(res, 401, { error: "Unauthorized" });
      if (
        principal.role !== "developer" ||
        principal.vaults.length !== 1 ||
        principal.scopes.length !== 1 ||
        principal.scopes[0] !== "payments:request"
      ) {
        return void respond(res, 403, { error: "Forbidden" });
      }
      try {
        if (
          (await getGenesisHash()) !== expectedGenesisHash ||
          !expectedGenesisHash
        ) {
          throw new Error("Devnet genesis mismatch");
        }
      } catch {
        return void respond(res, 503, {
          error: "Devnet verification unavailable",
        });
      }
      const scope: TrustedPaymentIntakeScope = {
        network: "devnet",
        principalId: principal.principalId,
        vault: principal.vaults[0],
        nowUnix: Math.floor(now() / 1000),
      };
      if (match) {
        try {
          const record = readModelAPaymentIntent({
            runtimeDir,
            trustedScope: scope,
            requestId: match[1],
          });
          if (!record)
            return void respond(res, 404, { error: "Intent not found" });
          return void respond(res, 200, record);
        } catch {
          return void respond(res, 503, { error: "Intent status unavailable" });
        }
      }
      let input: unknown;
      try {
        input = await jsonBody(req);
      } catch {
        return void respond(res, 400, { error: "Invalid payment request" });
      }
      try {
        validateModelAPaymentIntent(input, scope.nowUnix);
      } catch {
        return void respond(res, 400, { error: "Invalid payment request" });
      }
      try {
        await checkPolicy({ trustedScope: scope, input });
      } catch {
        return void respond(res, 403, {
          error: "Payment policy not satisfied",
        });
      }
      try {
        const result = receiveModelAPaymentIntent({
          runtimeDir,
          trustedScope: scope,
          input,
        });
        respond(res, result.duplicate ? 200 : 202, {
          requestId: result.record.request.requestId,
          status: "received",
          duplicate: result.duplicate,
          network: "devnet",
          vault: scope.vault,
          notice: "Request only; not approved, queued for execution, or paid",
        });
      } catch (error) {
        if (error instanceof PaymentIntentConflict) {
          return void respond(res, 409, { error: "Request ID conflict" });
        }
        respond(res, 503, { error: "Payment-intent storage unavailable" });
      }
    })().catch(() => {
      if (!res.headersSent)
        respond(res, 503, { error: "Payment-intent API unavailable" });
    });
  };
}
