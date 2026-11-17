/**
 * Owner signs a selected-vault payment approval using Phantom.
 * Supports Model B (PaymentApprovalV2, native Ed25519 on-chain verification)
 * and Model A v1 legacy JSON download.
 *
 * Safety: Automatic broadcast coordinator remains disabled.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { CheckCircle2, FileSignature, ShieldCheck, Clock, ShieldAlert } from "lucide-react";
import {
  AGENTVAULT_PROGRAM_ID,
  MAX_SELECTED_PAYMENT_BASE_UNITS,
  encodeSelectedVaultApproval,
  type SelectedVaultApproval,
} from "./selected-vault-approval";
import {
  encodePaymentApprovalV2Browser,
  type PaymentApprovalV2,
} from "./selected-vault-approval-v2";
import "./selected-vault-approval.css";

type AgentTask = {
  taskPda: string;
  taskId: string;
  recipient: string;
  remainingBaseUnits: string;
  nextNonce?: string;
  expiresAtUnix: string;
  active: boolean;
};

type Agent = {
  agentPda: string;
  authority: string;
  active: boolean;
  tasks: AgentTask[];
};

type Treasury = {
  network: "devnet";
  vault: string;
  owner: string;
  tokenMint: string;
  paused: boolean;
};

type Wallet = {
  publicKey?: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  signMessage(
    data: Uint8Array,
    display?: "utf8"
  ): Promise<{ signature: Uint8Array }>;
};

type ModelBApprovalEntry = {
  requestId: string;
  authorizationModel: "model-b";
  status: "approved_pending_execution" | "executed" | "pending_owner_approval";
  agentAuthority: string;
  recipient: string;
  amountBaseUnits: string;
  nonce: string;
  expiresAtUnix: string;
};

function phantom(): Wallet | null {
  const browser = window as unknown as {
    phantom?: { solana?: Wallet };
    solana?: Wallet;
  };
  const wallet = browser.phantom?.solana ?? browser.solana;
  return wallet &&
    typeof wallet.connect === "function" &&
    typeof wallet.signMessage === "function"
    ? wallet
    : null;
}

async function authenticatedJson<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
  });
  if (!response.ok) {
    const errorText = await response.text();
    let msg = `Owner API ${path} HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(errorText);
      if (parsed.error) msg = parsed.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await response.json()) as T;
}

function validateCanonical(value: string): string {
  const pubkey = new PublicKey(value);
  if (pubkey.toBase58() !== value) throw new Error("Noncanonical public key");
  return value;
}

export default function SelectedVaultPaymentApprovalPanel({
  snapshot,
  agents,
  sessionOwner,
}: {
  snapshot: Treasury;
  agents: Agent[];
  sessionOwner: string;
}) {
  const [authModel, setAuthModel] = useState<"model-b" | "model-a">("model-b");
  const [taskPda, setTaskPda] = useState("");
  const [amountText, setAmountText] = useState("50000");
  const [category, setCategory] = useState<"procurement" | "operations">(
    "procurement"
  );
  const [description, setDescription] = useState("");
  const [selectedPendingId, setSelectedPendingId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedRequest, setSavedRequest] = useState<string | null>(null);
  const [approvalsList, setApprovalsList] = useState<ModelBApprovalEntry[]>([]);
  const [loadingApprovals, setLoadingApprovals] = useState(false);

  const loadApprovals = useCallback(async () => {
    try {
      setLoadingApprovals(true);
      const data = await authenticatedJson<{
        approvals: ModelBApprovalEntry[];
      }>("/owner-vault/api/approvals");
      setApprovalsList(data.approvals ?? []);
    } catch {
      // Backend may be offline in dev
    } finally {
      setLoadingApprovals(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    const timer = setTimeout(() => {
      if (!ignore) {
        void loadApprovals();
      }
    }, 0);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [loadApprovals]);

  const choices = useMemo(
    () =>
      agents
        .filter((agent) => agent.active)
        .flatMap((agent) =>
          agent.tasks
            .filter((task) => task.active)
            .map((task) => ({ agent, task }))
        ),
    [agents]
  );
  const selected = choices.find((entry) => entry.task.taskPda === taskPda);

  async function createApproval() {
    setBusy(true);
    setError(null);
    setSavedRequest(null);
    try {
      if (!selected) throw new Error("Select an active task first");
      if (!acknowledged)
        throw new Error("Confirm that this is a payment authorization");
      if (snapshot.network !== "devnet" || snapshot.paused)
        throw new Error("Only an active Devnet vault may authorize payments");
      if (!sessionOwner || snapshot.owner !== sessionOwner)
        throw new Error("Owner session scope mismatch");
      validateCanonical(snapshot.vault);
      validateCanonical(snapshot.owner);
      validateCanonical(snapshot.tokenMint);
      validateCanonical(selected.agent.authority);
      validateCanonical(selected.task.recipient);

      if (!/^[1-9]\d*$/.test(amountText))
        throw new Error("Enter an integer amount in token base units");
      const units = BigInt(amountText);
      if (units > BigInt(MAX_SELECTED_PAYMENT_BASE_UNITS))
        throw new Error(
          `Per-payment cap: ${MAX_SELECTED_PAYMENT_BASE_UNITS} base units`
        );
      if (units > BigInt(selected.task.remainingBaseUnits))
        throw new Error("Amount exceeds remaining task budget");
      const taskId = Number(selected.task.taskId);
      if (!Number.isSafeInteger(taskId) || taskId < 0)
        throw new Error("Task ID exceeds the approval format");
      if (description.trim().length < 8 || description.length > 300)
        throw new Error("Description must be 8–300 characters");

      const wallet = phantom();
      if (!wallet)
        throw new Error("Phantom wallet with signMessage is required");
      const connected = await wallet.connect();
      const owner = (connected.publicKey ?? wallet.publicKey)?.toBase58();
      if (owner !== snapshot.owner)
        throw new Error(
          "Connected Phantom wallet is not the selected vault owner"
        );

      // Re-fetch the authenticated owner-scoped snapshot immediately before signing.
      const [liveTreasury, inventory] = await Promise.all([
        authenticatedJson<Treasury>("/owner-vault/api/treasury"),
        authenticatedJson<{
          network: "devnet";
          owner: string;
          vault: string;
          agents: Agent[];
        }>("/owner-vault/api/agents"),
      ]);
      if (
        liveTreasury.vault !== snapshot.vault ||
        liveTreasury.owner !== snapshot.owner ||
        liveTreasury.tokenMint !== snapshot.tokenMint ||
        liveTreasury.paused ||
        inventory.network !== "devnet" ||
        inventory.owner !== snapshot.owner ||
        inventory.vault !== snapshot.vault
      ) {
        throw new Error("Latest owner data does not match the selected vault");
      }
      const liveAgent = inventory.agents.find(
        (a) => a.agentPda === selected.agent.agentPda && a.active
      );
      const liveTask = liveAgent?.tasks.find(
        (t) => t.taskPda === selected.task.taskPda && t.active
      );
      if (
        !liveAgent ||
        !liveTask ||
        liveAgent.authority !== selected.agent.authority ||
        liveTask.taskId !== selected.task.taskId ||
        liveTask.recipient !== selected.task.recipient ||
        BigInt(liveTask.remainingBaseUnits) < units
      ) {
        throw new Error(
          "Agent or task changed; refresh the console before signing"
        );
      }

      const nowUnix = Math.floor(Date.now() / 1000);
      const maxExpiry = BigInt(liveTask.expiresAtUnix);
      const expiresAtUnix = Number(
        BigInt(nowUnix + 600) < maxExpiry ? BigInt(nowUnix + 600) : maxExpiry
      );
      if (!Number.isSafeInteger(expiresAtUnix) || expiresAtUnix <= nowUnix + 30)
        throw new Error("Task expires too soon for a new payment approval");

      const connection = new Connection(
        "https://api.devnet.solana.com",
        "confirmed"
      );
      const genesisHash = validateCanonical(await connection.getGenesisHash());
      const requestId =
        selectedPendingId ||
        crypto.randomUUID().replace(/-/g, "").slice(0, 32);

      if (authModel === "model-b") {
        // Model B (PaymentApprovalV2, native Ed25519 on-chain verification)
        const paymentApproval: PaymentApprovalV2 = {
          version: 2,
          genesisHash,
          programId: AGENTVAULT_PROGRAM_ID,
          vault: snapshot.vault,
          owner: snapshot.owner,
          mint: snapshot.tokenMint,
          agent: selected.agent.agentPda,
          agentAuthority: liveAgent.authority,
          task: selected.task.taskPda,
          recipient: liveTask.recipient,
          amountBaseUnits: String(units),
          nonce: liveTask.nextNonce ?? "0",
          expiresAtUnix: String(expiresAtUnix),
          requestId,
        };

        const encodedBytes = await encodePaymentApprovalV2Browser(
          paymentApproval
        );
        const signedMessage = await wallet.signMessage(encodedBytes);

        if (
          signedMessage.signature.length !== 64 ||
          wallet.publicKey?.toBase58() !== snapshot.owner
        ) {
          throw new Error("Wallet returned an invalid signature");
        }

        const signatureBase64 = btoa(
          String.fromCharCode(...signedMessage.signature)
        );

        await authenticatedJson("/owner-vault/api/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paymentApproval,
            signatureBase64,
          }),
        });

        await loadApprovals();
        setSavedRequest(requestId);
      } else {
        // Model A v1 legacy JSON file download
        const workflow: SelectedVaultApproval = {
          version: 1,
          network: "devnet",
          requestId,
          genesisHash,
          programId: AGENTVAULT_PROGRAM_ID,
          vault: snapshot.vault,
          owner: snapshot.owner,
          mint: snapshot.tokenMint,
          assignedAgent: category === "procurement" ? "agent-a" : "agent-b",
          agentAuthority: liveAgent.authority,
          kind: category,
          taskId,
          recipient: liveTask.recipient,
          amountBaseUnits: Number(units),
          expiresAtUnix,
          description: description.trim(),
        };

        const signedMessage = await wallet.signMessage(
          encodeSelectedVaultApproval(workflow),
          "utf8"
        );
        if (
          signedMessage.signature.length !== 64 ||
          wallet.publicKey?.toBase58() !== snapshot.owner
        ) {
          throw new Error("Wallet changed or returned an invalid signature");
        }
        const signature = btoa(
          String.fromCharCode(...signedMessage.signature)
        );
        const output = JSON.stringify({ workflow, signature }, null, 2) + "\n";
        const url = URL.createObjectURL(
          new Blob([output], { type: "application/json" })
        );
        try {
          const link = document.createElement("a");
          link.href = url;
          link.download = `agentvault-approval-${workflow.requestId}.json`;
          document.body.appendChild(link);
          link.click();
          link.remove();
        } finally {
          URL.revokeObjectURL(url);
        }
        setSavedRequest(workflow.requestId);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Approval signing failed"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="av-approval-panel">
      {/* Model B Approval Queue */}
      <div className="av-approval-queue-section">
        <div className="av-approval-heading">
          <span className="av-approval-icon">
            <FileSignature size={25} />
          </span>
          <div>
            <p className="av-approval-eyebrow">MODEL B · PENDING APPROVAL QUEUE</p>
            <h2>Pending Owner Payment Approvals</h2>
            <p>
              Model B payments wait for explicit owner signature (PaymentApprovalV2)
              before execution. Automatic broadcasting remains disabled until approved.
            </p>
          </div>
        </div>

        {loadingApprovals ? (
          <p className="av-approval-foot">Loading pending approvals…</p>
        ) : approvalsList.length === 0 ? (
          <p className="av-approval-foot">No pending Model B approvals for this vault.</p>
        ) : (
          <div className="av-approval-queue-list">
            {approvalsList.map((app) => (
              <div key={app.requestId} className="av-approval-queue-card">
                <div className="av-queue-meta">
                  <span className="av-queue-req"><code>{app.requestId}</code></span>
                  <span className="av-queue-badge">
                    <Clock size={12} /> {app.status === "approved_pending_execution" ? "Approved · Awaiting Broadcast Approval" : app.status}
                  </span>
                </div>
                <div className="av-queue-details">
                  <span>Amount: <strong>{app.amountBaseUnits}</strong> base units</span>
                  <span>Nonce: <code>{app.nonce}</code></span>
                  <span>Recipient: <code>{app.recipient.slice(0, 8)}…{app.recipient.slice(-6)}</code></span>
                  {app.status === "pending_owner_approval" && (
                    <button
                      type="button"
                      style={{
                        marginLeft: "auto",
                        background: "#3b82f6",
                        color: "#fff",
                        border: "none",
                        borderRadius: "4px",
                        padding: "4px 8px",
                        cursor: "pointer",
                        fontSize: "12px",
                      }}
                      onClick={() => {
                        setSelectedPendingId(app.requestId);
                        setAmountText(app.amountBaseUnits);
                        setAuthModel("model-b");
                        const matchedChoice = choices.find(
                          (c) =>
                            c.task.recipient === app.recipient ||
                            c.agent.authority === app.agentAuthority
                        );
                        if (matchedChoice) setTaskPda(matchedChoice.task.taskPda);
                      }}
                    >
                      {selectedPendingId === app.requestId
                        ? "Selected"
                        : "Select to Approve"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <hr style={{ borderColor: "#29303d", margin: "28px 0" }} />

      {/* Authorize New Payment Form */}
      <div className="av-approval-heading">
        <span className="av-approval-icon">
          <ShieldCheck size={25} />
        </span>
        <div>
          <p className="av-approval-eyebrow">
            AUTHORIZATION PROTOCOL · DEVNET
          </p>
          <h2>Sign Payment Authorization</h2>
          <p>
            Choose Model B (server-persisted PaymentApprovalV2) or Model A (v1 file download).
          </p>
        </div>
      </div>

      <div className="av-approval-grid">
        <label>
          <span>Authorization Model</span>
          <select
            value={authModel}
            onChange={(e) => setAuthModel(e.target.value as "model-b" | "model-a")}
            disabled={busy}
          >
            <option value="model-b">Model B (PaymentApprovalV2, native Ed25519 on-chain verification)</option>
            <option value="model-a">Model A (Legacy v1 signed JSON file download)</option>
          </select>
        </label>
        <label>
          <span>Active agent task</span>
          <select
            value={taskPda}
            onChange={(e) => setTaskPda(e.target.value)}
            disabled={busy}
          >
            <option value="">Select a task</option>
            {choices.map(({ agent, task }) => (
              <option key={task.taskPda} value={task.taskPda}>
                {agent.authority.slice(0, 7)}… · Task #{task.taskId}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Workflow category</span>
          <select
            value={category}
            disabled={busy}
            onChange={(e) =>
              setCategory(e.target.value as "procurement" | "operations")
            }
          >
            <option value="procurement">Procurement (agent-a)</option>
            <option value="operations">Operations (agent-b)</option>
          </select>
        </label>
        <label>
          <span>Amount (token base units, maximum 50,000)</span>
          <input
            inputMode="numeric"
            value={amountText}
            disabled={busy}
            onChange={(e) => setAmountText(e.target.value)}
          />
        </label>
        <label className="av-approval-wide">
          <span>Business reason for this exact payment</span>
          <textarea
            rows={3}
            maxLength={300}
            value={description}
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>

      {selected && (
        <div className="av-approval-summary">
          <span>
            Allowed recipient: <code>{selected.task.recipient}</code>
          </span>
          <span>
            Remaining task budget:{" "}
            <code>{selected.task.remainingBaseUnits} base units</code>
          </span>
          <span>Approval lifetime: up to 10 minutes</span>
        </div>
      )}

      <label className="av-approval-confirm">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        <span>
          I understand this signature authorizes this exact payment terms with my
          connected owner wallet. Automatic execution remains disabled until explicitly approved.
        </span>
      </label>

      {error && (
        <div role="alert" className="av-approval-error">
          <ShieldAlert size={16} /> {error}
        </div>
      )}

      {savedRequest && (
        <div role="status" className="av-approval-success">
          <CheckCircle2 size={16} />
          {authModel === "model-b"
            ? `PaymentApprovalV2 signed and recorded on server. Request ID: ${savedRequest} (Broadcast coordinator disabled)`
            : `Signed approval downloaded. Request ID: ${savedRequest}`}
        </div>
      )}

      <button
        className="av-approval-submit"
        type="button"
        disabled={busy || !selected || !acknowledged}
        onClick={() => void createApproval()}
      >
        <ShieldCheck size={17} />{" "}
        {busy
          ? "Verifying and signing…"
          : authModel === "model-b"
          ? "Sign PaymentApprovalV2 in Phantom"
          : "Sign v1 approval in Phantom"}
      </button>

      <p className="av-approval-foot">
        Devnet test only · Protected by on-chain Ed25519 preflight instruction · Automatic broadcasting disabled pending security review
      </p>
    </section>
  );
}
