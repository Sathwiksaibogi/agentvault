import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  ShieldAlert,
  ShieldCheck,
  Ban,
  BotOff,
  PauseCircle,
} from "lucide-react";
import {
  deactivateOwnerAgent,
  revokeOwnerTask,
  setOwnerVaultPaused,
  type SecurityAgent,
  type SecurityResult,
} from "./owner-security";
import {
  type OwnerManagementWallet,
  type SelectedVaultSnapshot,
} from "./owner-management";

function phantom(): OwnerManagementWallet | null {
  const browser = window as unknown as {
    phantom?: { solana?: OwnerManagementWallet };
    solana?: OwnerManagementWallet;
  };
  const provider = browser.phantom?.solana ?? browser.solana;
  return provider &&
    typeof provider.connect === "function" &&
    typeof provider.signTransaction === "function"
    ? provider
    : null;
}

type Props = {
  snapshot: SelectedVaultSnapshot;
  sessionOwner: string;
  agents: readonly SecurityAgent[];
  onConfirmed: () => Promise<void>;
};

export default function OwnerSecurityPanel({
  snapshot,
  sessionOwner,
  agents,
  onConfirmed,
}: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SecurityResult | null>(null);

  async function run(
    action: (wallet: OwnerManagementWallet) => Promise<SecurityResult>
  ) {
    setError(null);
    setResult(null);
    if (!acknowledged) {
      setError(
        "Review and acknowledge this owner-signed Devnet policy transaction first"
      );
      return;
    }
    const wallet = phantom();
    if (!wallet) {
      setError("A wallet supporting signTransaction is required");
      return;
    }
    setBusy(true);
    try {
      await wallet.connect();
      if (!wallet.publicKey?.equals(new PublicKey(sessionOwner))) {
        throw new Error(
          "Connected wallet does not match authenticated vault owner"
        );
      }
      const value = await action(wallet);
      setResult(value);
      setAcknowledged(false);
      try {
        await onConfirmed();
      } catch {
        setError(
          "Policy transaction confirmed, but dashboard refresh failed. Please refresh."
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Owner policy transaction failed"
      );
    } finally {
      setBusy(false);
    }
  }

  const common = { snapshot, sessionOwner };
  return (
    <section className="av-control-panel av-security-panel av-owner-surface">
      <div className="av-panel-feature-header av-panel-feature-security">
        <span className="av-panel-symbol">
          <ShieldAlert size={25} />
        </span>
        <div>
          <span className="av-panel-eyebrow">VAULT SAFETY</span>
          <h2>Control access. Respond quickly.</h2>
          <p>
            Owner-signed emergency actions for your treasury, agents, and tasks.
          </p>
        </div>
        <span className="av-panel-env">OWNER ONLY</span>
      </div>
      <p style={{ color: "#fbbf24" }}>
        Revoking a Model A task releases its unused reservation. Deactivating an
        agent stops that agent, but does not itself release existing task
        reservations. Pause is a vault-wide emergency control.
      </p>
      {error && (
        <p role="alert" style={{ color: "#fca5a5", overflowWrap: "anywhere" }}>
          {error}
        </p>
      )}
      {result && (
        <p role="status">
          Confirmed on Devnet: <code>{result.account}</code>
          {" · "}
          <a
            style={{ color: "#93c5fd" }}
            target="_blank"
            rel="noopener noreferrer"
            href={`https://explorer.solana.com/tx/${encodeURIComponent(
              result.signature
            )}?cluster=devnet`}
          >
            View transaction
          </a>
        </p>
      )}
      <div className="av-security-grid">
        <div className="av-panel-card av-security-action av-emergency-action">
          <div className="av-panel-card-title">
            <span className="av-mini-icon">
              <PauseCircle size={21} />
            </span>
            <div>
              <small>VAULT WIDE</small>
              <h3>Emergency vault pause</h3>
            </div>
          </div>
          <p>
            Current status:{" "}
            <strong>{snapshot.paused ? "Paused" : "Active"}</strong>
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run((wallet) =>
                setOwnerVaultPaused({
                  wallet,
                  ...common,
                  paused: !snapshot.paused,
                })
              )
            }
          >
            {snapshot.paused
              ? "Resume vault (Phantom signature)"
              : "Pause vault (Phantom signature)"}
          </button>
        </div>
        <div className="av-panel-card av-security-action">
          <div className="av-panel-card-title">
            <span className="av-mini-icon">
              <Ban size={21} />
            </span>
            <div>
              <small>TASK ACCESS</small>
              <h3>Revoke Model A tasks</h3>
            </div>
          </div>
          {agents.every((agent) =>
            agent.tasks.every((task) => !task.active)
          ) && <p>No active Model A tasks to revoke.</p>}
          {agents.map((agent) =>
            agent.tasks
              .filter((task) => task.active)
              .map((task) => (
                <div key={task.taskPda} style={{ padding: "6px 0" }}>
                  <code style={{ overflowWrap: "anywhere" }}>
                    Agent {agent.authority} · Task #{task.taskId}
                  </code>{" "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run((wallet) =>
                        revokeOwnerTask({
                          wallet,
                          ...common,
                          agent,
                          task,
                        })
                      )
                    }
                  >
                    Revoke task #{task.taskId} (Phantom signature)
                  </button>
                </div>
              ))
          )}
        </div>
        <div className="av-panel-card av-security-action">
          <div className="av-panel-card-title">
            <span className="av-mini-icon">
              <BotOff size={21} />
            </span>
            <div>
              <small>AGENT ACCESS</small>
              <h3>Deactivate agents</h3>
            </div>
          </div>
          <p>
            Deactivation does not release task reservations. Revoke unneeded
            tasks separately.
          </p>
          {agents.filter((agent) => agent.active).length === 0 && (
            <p>No active agents to deactivate.</p>
          )}
          {agents
            .filter((agent) => agent.active)
            .map((agent) => (
              <div key={agent.agentPda} style={{ padding: "6px 0" }}>
                <code style={{ overflowWrap: "anywhere" }}>
                  {agent.authority}
                </code>{" "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run((wallet) =>
                      deactivateOwnerAgent({
                        wallet,
                        ...common,
                        agent,
                      })
                    )
                  }
                >
                  Deactivate agent (Phantom signature)
                </button>
              </div>
            ))}
        </div>
      </div>
      <label className="av-panel-consent">
        <ShieldCheck size={18} />
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        I understand this is a real Devnet owner-policy transaction and will
        review the exact action in Phantom.
      </label>
    </section>
  );
}
