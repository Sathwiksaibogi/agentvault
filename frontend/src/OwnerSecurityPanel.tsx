import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  deactivateOwnerAgent, revokeOwnerTask, setOwnerVaultPaused,
  type SecurityAgent, type SecurityResult,
} from "./owner-security";
import {
  type OwnerManagementWallet, type SelectedVaultSnapshot,
} from "./owner-management";

const section = { marginTop: 24, padding: 24, borderRadius: 12, background: "#172338" } as const;
const line = { padding: "12px 0", borderTop: "1px solid #334155" } as const;

function phantom(): OwnerManagementWallet | null {
  const browser = window as unknown as {
    phantom?: { solana?: OwnerManagementWallet };
    solana?: OwnerManagementWallet;
  };
  const provider = browser.phantom?.solana ?? browser.solana;
  return provider && typeof provider.connect === "function" &&
    typeof provider.signTransaction === "function" ? provider : null;
}

type Props = {
  snapshot: SelectedVaultSnapshot;
  sessionOwner: string;
  agents: readonly SecurityAgent[];
  onConfirmed: () => Promise<void>;
};

export default function OwnerSecurityPanel({ snapshot, sessionOwner, agents, onConfirmed }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SecurityResult | null>(null);

  async function run(action: (wallet: OwnerManagementWallet) => Promise<SecurityResult>) {
    setError(null);
    setResult(null);
    if (!acknowledged) {
      setError("Review and acknowledge this owner-signed Devnet policy transaction first");
      return;
    }
    const wallet = phantom();
    if (!wallet) { setError("A wallet supporting signTransaction is required"); return; }
    setBusy(true);
    try {
      await wallet.connect();
      if (!wallet.publicKey?.equals(new PublicKey(sessionOwner))) {
        throw new Error("Connected wallet does not match authenticated vault owner");
      }
      const value = await action(wallet);
      setResult(value);
      setAcknowledged(false);
      try { await onConfirmed(); }
      catch { setError("Policy transaction confirmed, but dashboard refresh failed. Please refresh."); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Owner policy transaction failed");
    } finally {
      setBusy(false);
    }
  }

  const common = { snapshot, sessionOwner };
  return (
    <section style={section}>
      <h2>Owner security controls</h2>
      <p>Only your authenticated owner wallet can sign these Devnet policy changes. No payments are submitted here.</p>
      <p style={{ color: "#fbbf24" }}>
        Revoking a Model A task releases its unused reservation. Deactivating an agent stops that agent,
        but does not itself release existing task reservations. Pause is a vault-wide emergency control.
      </p>
      {error && <p role="alert" style={{ color: "#fca5a5", overflowWrap: "anywhere" }}>{error}</p>}
      {result && <p role="status">Confirmed on Devnet: <code>{result.account}</code>{" · "}
        <a style={{ color: "#93c5fd" }} target="_blank" rel="noopener noreferrer"
          href={`https://explorer.solana.com/tx/${encodeURIComponent(result.signature)}?cluster=devnet`}>
          View transaction
        </a>
      </p>}
      <div style={line}>
        <h3>Emergency vault pause</h3>
        <p>Current status: <strong>{snapshot.paused ? "Paused" : "Active"}</strong></p>
        <button type="button" disabled={busy}
          onClick={() => void run((wallet) => setOwnerVaultPaused({
            wallet, ...common, paused: !snapshot.paused,
          }))}>
          {snapshot.paused ? "Resume vault (Phantom signature)" : "Pause vault (Phantom signature)"}
        </button>
      </div>
      <div style={line}>
        <h3>Revoke Model A tasks</h3>
        {agents.every((agent) => agent.tasks.every((task) => !task.active)) &&
          <p>No active Model A tasks to revoke.</p>}
        {agents.map((agent) => agent.tasks.filter((task) => task.active).map((task) => (
          <div key={task.taskPda} style={{ padding: "6px 0" }}>
            <code style={{ overflowWrap: "anywhere" }}>Agent {agent.authority} · Task #{task.taskId}</code>{" "}
            <button type="button" disabled={busy} onClick={() => void run((wallet) => revokeOwnerTask({
              wallet, ...common, agent, task,
            }))}>Revoke task #{task.taskId} (Phantom signature)</button>
          </div>
        )))}
      </div>
      <div style={line}>
        <h3>Deactivate agents</h3>
        <p>Deactivation does not release task reservations. Revoke unneeded tasks separately.</p>
        {agents.filter((agent) => agent.active).length === 0 && <p>No active agents to deactivate.</p>}
        {agents.filter((agent) => agent.active).map((agent) => (
          <div key={agent.agentPda} style={{ padding: "6px 0" }}>
            <code style={{ overflowWrap: "anywhere" }}>{agent.authority}</code>{" "}
            <button type="button" disabled={busy} onClick={() => void run((wallet) => deactivateOwnerAgent({
              wallet, ...common, agent,
            }))}>Deactivate agent (Phantom signature)</button>
          </div>
        ))}
      </div>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 16 }}>
        <input type="checkbox" checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)} />
        I understand this is a real Devnet owner-policy transaction and will review the exact action in Phantom.
      </label>
    </section>
  );
}
