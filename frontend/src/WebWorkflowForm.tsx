import { useState } from "react";
import type { DashboardData } from "./api";
import { getPhantomProvider } from "./phantom";
import {
  signAndSaveWebWorkflow,
  type StoredWebApproval,
  type WebAgentId,
} from "./webWorkflowApproval";

export function WebWorkflowForm({
  dashboard,
  walletAddress,
}: {
  dashboard: DashboardData;
  walletAddress: string | null;
}) {
  const [agentId, setAgentId] = useState<WebAgentId>("agent-a");
  const [amount, setAmount] = useState("0.01");
  const [description, setDescription] = useState(
    "Pay the approved supplier for a procurement expense"
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StoredWebApproval | null>(null);
  const ownerMatches = walletAddress === dashboard.treasury.owner;

  async function approve() {
    const provider = getPhantomProvider();
    if (!provider?.publicKey || !ownerMatches) {
      setError("Connect the Phantom wallet that owns Vault 2");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const approval = await signAndSaveWebWorkflow({
        provider,
        dashboard,
        agentId,
        amountTokens: amount,
        description,
      });
      setResult(approval);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" aria-label="Create owner-approved workflow">
      <div className="section-heading">
        <div>
          <div className="section-eyebrow">OWNER AUTHORIZATION</div>
          <h2>Create Vault 2 workflow</h2>
        </div>
      </div>
      <div className="panel" style={{ padding: 24, display: "grid", gap: 16 }}>
        <p>
          Phantom signs a bounded workflow. This does not call Gemini or send a
          payment. Approved requests are saved by the local backend only.
        </p>
        <label htmlFor="web-workflow-agent">AI agent</label>
        <select
          id="web-workflow-agent"
          className="vault-picker-select"
          value={agentId}
          disabled={busy}
          onChange={(event) => setAgentId(event.target.value as WebAgentId)}
        >
          <option value="agent-a">Procurement</option>
          <option value="agent-b">Operations</option>
        </select>
        <label htmlFor="web-workflow-amount">
          Amount in custom Devnet test tokens
        </label>
        <input
          id="web-workflow-amount"
          className="vault-picker-select"
          style={{ maxWidth: 240 }}
          value={amount}
          disabled={busy}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.01"
          inputMode="decimal"
        />
        <label htmlFor="web-workflow-description">Agent instruction</label>
        <textarea
          id="web-workflow-description"
          className="vault-picker-select"
          style={{ width: "100%", maxWidth: "100%", minHeight: 100 }}
          value={description}
          disabled={busy}
          maxLength={300}
          onChange={(event) => setDescription(event.target.value)}
        />
        <p>
          Recipient is fixed by the selected agent's on-chain task. Approvals
          expire after at most 15 minutes.
        </p>
        <button
          type="button"
          className="refresh-button"
          disabled={busy || !ownerMatches}
          onClick={() => void approve()}
        >
          {busy
            ? "Waiting for Phantom / verification..."
            : "Sign owner approval in Phantom"}
        </button>
        {!ownerMatches && (
          <p role="status">
            Connect the Vault 2 Phantom owner to approve a workflow.
          </p>
        )}
        {error && (
          <div className="wallet-error" role="alert">
            {error}
          </div>
        )}
        {result && (
          <div role="status" style={{ overflowWrap: "anywhere" }}>
            <strong>
              Signature verified; workflow saved locally. NOT EXECUTED.
            </strong>
            <p>Request ID: {result.requestId}</p>
            <p>Agent: {result.assignedAgent}</p>
            <p>Approved base units: {result.amountBaseUnits}</p>
            <p>
              Expires: {new Date(result.expiresAtUnix * 1000).toLocaleString()}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
