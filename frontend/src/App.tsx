import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Bot,
  Clock3,
  ExternalLink,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Wallet,
  Workflow,
} from "lucide-react";

import { loadDashboard, type DashboardData, type WorkflowStatus } from "./api";

function formatAmount(amount: string, decimals: number): string {
  const value = BigInt(amount);

  if (decimals === 0) {
    return value.toString();
  }

  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;

  const fraction = (value % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function shortAddress(value: string): string {
  return `${value.slice(0, 5)}...${value.slice(-5)}`;
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

function workflowStatus(workflow: WorkflowStatus): {
  label: string;
  tone: string;
} {
  const recovery = workflow.execution.payment?.recoveryState;

  if (recovery === "CONFIRMED" || recovery === "FINALIZED") {
    return { label: "Confirmed", tone: "success" };
  }

  if (recovery === "EXPIRED_UNRESOLVED") {
    return { label: "Expired / unresolved", tone: "warning" };
  }

  if (workflow.execution.journalStatus !== "unclaimed") {
    return { label: "Execution claimed", tone: "warning" };
  }

  if (!workflow.approval.currentlyValid) {
    return { label: "Approval expired", tone: "muted" };
  }

  if (workflow.aiDecision.receiptFilePresent) {
    return { label: "AI receipt present", tone: "muted" };
  }

  return { label: "Awaiting AI decision", tone: "warning" };
}

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [expandedWorkflowId, setExpandedWorkflowId] = useState<string | null>(
    null
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await loadDashboard();
      setData(result);
      setUpdatedAt(new Date());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to load AgentVault data"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void loadDashboard()
      .then((result) => {
        if (cancelled) return;

        setData(result);
        setUpdatedAt(new Date());
      })
      .catch((cause: unknown) => {
        if (cancelled) return;

        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to load AgentVault data"
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const decimals = data?.treasury.decimals ?? 6;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <ShieldCheck size={24} />
          </div>
          <div>
            <strong>AgentVault</strong>
            <span>Autonomous Finance Infrastructure</span>
          </div>
        </div>

        <div className="header-actions">
          <span className="network-pill">
            <span className="network-dot" />
            Solana Devnet
          </span>

          <button
            className="refresh-button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw size={16} />
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </header>

      <main className="main-content">
        <section className="hero">
          <div className="eyebrow">
            <LockKeyhole size={15} />
            OWNER-CONTROLLED · MULTI-AGENT TREASURY
          </div>

          <h1>
            Secure spending for
            <span> autonomous agents.</span>
          </h1>

          <p>
            Monitor your shared treasury, independent AI agents, spending
            policies, owner approvals, and on-chain activity from one place.
          </p>

          <div className="hero-footer">
            <span className="read-only-pill">
              <ShieldCheck size={15} />
              Read-only dashboard
            </span>

            {updatedAt && (
              <span className="muted-text">
                Updated {updatedAt.toLocaleTimeString()}
              </span>
            )}
          </div>
        </section>

        {error && (
          <div className="error-panel">
            <strong>Unable to refresh dashboard</strong>
            <p>{error}</p>
            <p>Check that the AgentVault API is running on port 8787.</p>
          </div>
        )}

        {!data && loading && (
          <div className="empty-panel">Loading live Devnet data...</div>
        )}

        {data && (
          <>
            <section className="metrics-grid">
              <div className="panel metric-card">
                <div className="metric-heading">
                  <span>Treasury balance</span>
                  <Wallet size={19} />
                </div>
                <div className="metric-value">
                  {formatAmount(data.treasury.balanceBaseUnits, decimals)}
                </div>
                <div className="metric-caption">Custom Devnet test tokens</div>
              </div>

              <div className="panel metric-card">
                <div className="metric-heading">
                  <span>Reserved funds</span>
                  <LockKeyhole size={19} />
                </div>
                <div className="metric-value">
                  {formatAmount(data.treasury.reservedBaseUnits, decimals)}
                </div>
                <div className="metric-caption">Committed to task budgets</div>
              </div>

              <div className="panel metric-card">
                <div className="metric-heading">
                  <span>Unreserved funds</span>
                  <ArrowUpRight size={19} />
                </div>
                <div className="metric-value accent-value">
                  {formatAmount(data.treasury.availableBaseUnits, decimals)}
                </div>
                <div className="metric-caption">
                  Available for new reservations
                </div>
              </div>
            </section>

            <section className="section">
              <div className="section-heading">
                <div>
                  <div className="section-eyebrow">ACCESS CONTROL</div>
                  <h2>Registered agents</h2>
                </div>
                <span className="count-pill">{data.agents.length} agents</span>
              </div>

              <div className="agents-grid">
                {data.agents.map((agent) => {
                  const budget = BigInt(agent.task.budgetBaseUnits);

                  const spent = BigInt(agent.task.spentBaseUnits);

                  const percent =
                    budget === 0n ? 0 : Number((spent * 100n) / budget);

                  return (
                    <article className="panel agent-card" key={agent.id}>
                      <div className="agent-header">
                        <div className="agent-icon">
                          <Bot size={23} />
                        </div>
                        <span
                          className={
                            agent.active && agent.task.active
                              ? "status success"
                              : "status muted"
                          }
                        >
                          {agent.active && agent.task.active
                            ? "Active"
                            : "Inactive"}
                        </span>
                      </div>

                      <h3>{agent.name}</h3>
                      <p className="agent-subtitle">
                        {agent.workflow} workflow
                      </p>

                      <div className="agent-budget">
                        <span>Remaining task budget</span>
                        <strong>
                          {formatAmount(
                            agent.task.remainingBaseUnits,
                            decimals
                          )}
                        </strong>
                      </div>

                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${Math.min(100, percent)}%`,
                          }}
                        />
                      </div>

                      <div className="budget-caption">
                        <span>
                          Spent{" "}
                          {formatAmount(agent.task.spentBaseUnits, decimals)}
                        </span>
                        <span>
                          Budget{" "}
                          {formatAmount(agent.task.budgetBaseUnits, decimals)}
                        </span>
                      </div>

                      <div className="agent-details">
                        <div>
                          <span>Agent authority</span>
                          <code>{shortAddress(agent.authority)}</code>
                        </div>
                        <div>
                          <span>Allowed recipient</span>
                          <code>{shortAddress(agent.task.recipient)}</code>
                        </div>
                        <div>
                          <span>Next nonce</span>
                          <strong>{agent.task.nextNonce}</strong>
                        </div>
                        <div>
                          <span>Task expiry</span>
                          <strong>
                            {formatDate(Number(agent.task.expiresAtUnix))}
                          </strong>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="section">
              <div className="section-heading">
                <div>
                  <div className="section-eyebrow">AUTHORIZATION</div>
                  <h2>Workflow approvals</h2>
                </div>
                <Workflow size={20} className="section-icon" />
              </div>

              <div className="panel list-panel">
                {data.workflows.length === 0 && (
                  <div className="empty-row">No workflows found.</div>
                )}

                {data.workflows.map((workflow) => {
                  const status = workflowStatus(workflow);
                  const expanded = expandedWorkflowId === workflow.requestId;
                  const payment = workflow.execution.payment;

                  return (
                    <div className="workflow-entry" key={workflow.requestId}>
                      <div className="list-row">
                        <div className="list-icon">
                          <ShieldCheck size={19} />
                        </div>

                        <div className="list-description">
                          <strong>{workflow.requestId}</strong>
                          <span>
                            {workflow.assignedAgent} ·{" "}
                            {formatAmount(
                              String(workflow.amountBaseUnits),
                              decimals
                            )}{" "}
                            test tokens
                          </span>
                        </div>

                        <span className={`status ${status.tone}`}>
                          {status.label}
                        </span>

                        <button
                          type="button"
                          className="workflow-toggle"
                          aria-expanded={expanded}
                          aria-controls={`details-${workflow.requestId}`}
                          onClick={() =>
                            setExpandedWorkflowId(
                              expanded ? null : workflow.requestId
                            )
                          }
                        >
                          {expanded ? "Hide details" : "View details"}
                        </button>
                      </div>

                      {expanded && (
                        <div
                          className="workflow-details"
                          id={`details-${workflow.requestId}`}
                        >
                          <div className="workflow-details-grid">
                            <div>
                              <span>Owner approval signature</span>
                              <strong>
                                {workflow.approval.signatureVerified
                                  ? "Verified"
                                  : "Not verified"}
                              </strong>
                            </div>

                            <div>
                              <span>Approval authorization</span>
                              <strong>
                                {workflow.approval.currentlyValid
                                  ? "Within expiry"
                                  : "Expired"}
                              </strong>
                            </div>

                            <div>
                              <span>Approval expires</span>
                              <strong>
                                {formatDate(workflow.approval.expiresAtUnix)}
                              </strong>
                            </div>

                            <div>
                              <span>AI decision</span>
                              <strong>
                                {workflow.aiDecision.receiptFilePresent
                                  ? "Receipt file present — unverified here"
                                  : "No saved receipt"}
                              </strong>
                            </div>

                            <div>
                              <span>Workflow type</span>
                              <strong>{workflow.workflowKind}</strong>
                            </div>

                            <div>
                              <span>Task ID</span>
                              <strong>{workflow.taskId}</strong>
                            </div>

                            <div>
                              <span>Allowed recipient</span>
                              <code>{workflow.recipient}</code>
                            </div>

                            <div>
                              <span>Execution journal</span>
                              <strong>
                                {workflow.execution.journalStatus}
                              </strong>
                            </div>

                            <div>
                              <span>Transaction recovery</span>
                              <strong>
                                {payment?.recoveryState ?? "No saved payment"}
                              </strong>
                            </div>

                            <div>
                              <span>Recorded nonce</span>
                              <strong>{payment?.nonce ?? "—"}</strong>
                            </div>
                          </div>

                          {payment && (
                            <div className="workflow-transaction">
                              <span>Saved transaction signature</span>

                              <a
                                href={`https://explorer.solana.com/tx/${payment.signature}?cluster=devnet`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {shortAddress(payment.signature)}
                                <ExternalLink size={14} />
                              </a>

                              <p>
                                A saved signature does not prove a payment was
                                confirmed. Unresolved transactions may not
                                appear in Explorer.
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="section">
              <div className="section-heading">
                <div>
                  <div className="section-eyebrow">SOLANA DEVNET</div>
                  <h2>Recent on-chain activity</h2>
                </div>
                <Activity size={20} className="section-icon" />
              </div>

              <div className="panel list-panel">
                {data.activity.length === 0 && (
                  <div className="empty-row">
                    No task-account activity found.
                  </div>
                )}

                {data.activity.map((entry) => (
                  <a
                    className="list-row activity-row"
                    href={entry.explorerUrl}
                    key={`${entry.agentId}-${entry.signature}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <div className="list-icon">
                      <Clock3 size={19} />
                    </div>

                    <div className="list-description">
                      <strong>
                        {entry.agentId === "agent-a"
                          ? "Procurement Agent"
                          : "Operations Agent"}
                      </strong>
                      <span>
                        {shortAddress(entry.signature)} · Slot {entry.slot}
                      </span>
                    </div>

                    <span
                      className={
                        entry.succeeded ? "status success" : "status warning"
                      }
                    >
                      {entry.succeeded ? "Succeeded" : "Failed"}
                    </span>

                    <ExternalLink size={16} className="external-icon" />
                  </a>
                ))}
              </div>
            </section>

            <footer className="footer">
              <span>AgentVault · Solana Fall School Demo</span>
              <span>
                On-chain policies enforce spending limits. AI decisions alone
                cannot move funds.
              </span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
