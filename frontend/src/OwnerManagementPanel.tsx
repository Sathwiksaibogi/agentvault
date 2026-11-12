import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  createOwnerTask,
  registerOwnerAgent,
  type SelectedAgentSnapshot,
  type SelectedVaultSnapshot,
  type OwnerManagementWallet,
} from "./owner-management";
import { DEVNET_RPC_URL } from "./onboarding";

const border = { border: "1px solid #334155", padding: 18, borderRadius: 10, marginTop: 18 } as const;
const input = { padding: 9, width: "min(100%, 500px)", boxSizing: "border-box" } as const;

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
  agents: readonly SelectedAgentSnapshot[];
  onConfirmed: () => Promise<void>;
};

export default function OwnerManagementPanel({ snapshot, sessionOwner, agents, onConfirmed }: Props) {
  const [authority, setAuthority] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [taskId, setTaskId] = useState("");
  const [budget, setBudget] = useState("");
  const [recipient, setRecipient] = useState("");
  const [expiryHours, setExpiryHours] = useState("24");
  const [confirmedRisk, setConfirmedRisk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ signature: string; account: string } | null>(null);

  async function transact(action: (wallet: OwnerManagementWallet) => Promise<{ signature: string; account: string }>) {
    setError(null);
    setResult(null);
    const wallet = phantom();
    if (!wallet) { setError("A Phantom-compatible wallet supporting transactions is required"); return; }
    if (!confirmedRisk) { setError("Review and acknowledge the Devnet transaction before continuing"); return; }
    setBusy(true);
    try {
      await wallet.connect();
      if (!wallet.publicKey?.equals(new PublicKey(sessionOwner))) {
        throw new Error("Connected wallet does not match this vault's authenticated owner");
      }
      const value = await action(wallet);
      setResult(value);
      setConfirmedRisk(false);
      try {
        await onConfirmed();
      } catch {
        setError("Transaction confirmed; dashboard refresh failed. Refresh to inspect the new account.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Owner transaction failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginTop: 24, padding: 24, borderRadius: 12, background: "#172338" }}>
      <h2>Manage agents and tasks</h2>
      <p>Devnet only · Each change is an on-chain transaction signed by your connected owner wallet.</p>
      <p style={{ color: "#fbbf24" }}>
        Registering an agent or creating a task modifies the selected vault's policy. No agent payments are submitted by these controls.
        The Model B execution/finality quarantine remains unchanged.
      </p>
      <p style={{ color: "#94a3b8" }}>RPC: {DEVNET_RPC_URL}</p>
      {error && <p role="alert" style={{ color: "#fca5a5" }}>{error}</p>}
      {result && <p role="status">
        Transaction confirmed. Account: <code>{result.account}</code>{" · "}
        <a style={{ color: "#93c5fd" }} target="_blank" rel="noopener noreferrer"
          href={`https://explorer.solana.com/tx/${encodeURIComponent(result.signature)}?cluster=devnet`}>
          View transaction
        </a>
      </p>}
      <div style={border}>
        <h3>Register AI agent</h3>
        <p>Paste the public address of the agent's authority key. Do not enter its private key.</p>
        <label htmlFor="agent-authority">Agent authority address</label>
        <div><input style={input} id="agent-authority" value={authority}
          onChange={(event) => setAuthority(event.target.value.trim())} placeholder="Solana public key" /></div>
        <button style={{ marginTop: 12 }} type="button" disabled={busy || snapshot.paused || !authority}
          onClick={() => void transact((wallet) => registerOwnerAgent({
            wallet, snapshot, sessionOwner, authority,
          }))}>Register agent (Phantom signature)</button>
      </div>
      <div style={border}>
        <h3>Create Model A spending task</h3>
        <p>Choose an active agent and set its task-specific allowance. Budget will be reserved on-chain.</p>
        <label htmlFor="task-agent">Agent</label>
        <div><select style={input} id="task-agent" value={selectedAgent}
          onChange={(event) => setSelectedAgent(event.target.value)}>
          <option value="">Select active agent</option>
          {agents.filter((agent) => agent.active).map((agent) => (
            <option key={agent.agentPda} value={agent.agentPda}>{agent.authority}</option>
          ))}
        </select></div>
        <label htmlFor="task-id">Task ID (unsigned integer, unique for this agent)</label>
        <div><input style={input} id="task-id" value={taskId} onChange={(event) => setTaskId(event.target.value.trim())} placeholder="2" /></div>
        <label htmlFor="task-budget">Budget (token units, not base units)</label>
        <div><input style={input} id="task-budget" value={budget} onChange={(event) => setBudget(event.target.value.trim())} placeholder="0.01" /></div>
        <label htmlFor="task-recipient">Allowed recipient (wallet public key)</label>
        <div><input style={input} id="task-recipient" value={recipient} onChange={(event) => setRecipient(event.target.value.trim())} placeholder="Solana public key" /></div>
        <label htmlFor="task-expiry">Expires after (whole hours)</label>
        <div><input style={input} id="task-expiry" value={expiryHours} onChange={(event) => setExpiryHours(event.target.value.trim())} placeholder="24" /></div>
        <button style={{ marginTop: 12 }} type="button"
          disabled={busy || snapshot.paused || !selectedAgent || !taskId || !budget || !recipient || !expiryHours}
          onClick={() => {
            const agent = agents.find((a) => a.agentPda === selectedAgent);
            if (!agent) { setError("Select an active agent"); return; }
            void transact((wallet) => createOwnerTask({
              wallet, snapshot, sessionOwner, agent, taskId, budget, recipient,
              expiresInHours: expiryHours,
            }));
          }}>Create task (Phantom signature)</button>
      </div>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 16 }}>
        <input type="checkbox" checked={confirmedRisk} onChange={(event) => setConfirmedRisk(event.target.checked)} />
        I understand that the selected action is an actual Devnet policy transaction, costs Devnet SOL, and does not execute an agent payment.
      </label>
      {snapshot.paused && <p role="alert">This vault is paused; management transactions are disabled in this interface.</p>}
    </section>
  );
}
