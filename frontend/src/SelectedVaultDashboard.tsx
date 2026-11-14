/**
 * First multi-owner dashboard slice: wallet-signed, selected-vault treasury.
 * Other read paths are deliberately unavailable until vault-scoped readers
 * exist; never mix a new vault with the original demo workflow index.
 */
import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  Activity,
  ChevronDown,
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Coins,
  ArrowDownToLine,
  KeyRound,
  LayoutDashboard,
  FileSignature,
  LockKeyhole,
  LogOut,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import "./vault-console.css";
import "./console-enhancements.css";
import OwnerManagementPanel from "./OwnerManagementPanel";
import OwnerSecurityPanel from "./OwnerSecurityPanel";
import DeveloperCredentialsPanel from "./DeveloperCredentialsPanel";
import TreasuryDepositPanel from "./TreasuryDepositPanel";
import SelectedVaultPaymentApprovalPanel from "./SelectedVaultPaymentApprovalPanel";

type ConsoleSection =
  | "overview"
  | "deposit"
  | "agents"
  | "approvals"
  | "manage"
  | "developer"
  | "security";

const consoleSections = [
  {
    id: "overview",
    name: "Overview",
    description: "Treasury overview",
    icon: LayoutDashboard,
  },
  {
    id: "deposit",
    name: "Deposit funds",
    description: "Top up your treasury",
    icon: ArrowDownToLine,
  },
  {
    id: "agents",
    name: "Agents & tasks",
    description: "Permissions and budgets",
    icon: Bot,
  },
  {
    id: "approvals",
    name: "Payment approvals",
    description: "Sign exact payment requests",
    icon: FileSignature,
  },
  {
    id: "manage",
    name: "Manage policies",
    description: "Register and create",
    icon: Settings2,
  },
  {
    id: "security",
    name: "Security",
    description: "Pause and revoke",
    icon: ShieldCheck,
  },
] as const;

const sectionDetails: Record<
  ConsoleSection,
  { eyebrow: string; title: string; description: string }
> = {
  overview: {
    eyebrow: "CONTROL CENTER",
    title: "Treasury overview",
    description:
      "A clear view of your vault's funds, reservations, and active agents.",
  },
  deposit: {
    eyebrow: "TREASURY FUNDING",
    title: "Deposit funds",
    description:
      "Fund this vault with its configured Devnet SPL token before creating task budgets.",
  },
  agents: {
    eyebrow: "AGENT OPERATIONS",
    title: "Agents & tasks",
    description:
      "Inspect registered authorities, spending allowances, and task limits.",
  },
  approvals: {
    eyebrow: "SIGNED WORKFLOWS",
    title: "Payment approvals",
    description:
      "Create an owner-signed, vault-scoped approval for a separate Devnet simulation.",
  },
  manage: {
    eyebrow: "OWNER ACTIONS",
    title: "Manage policies",
    description:
      "Register agents and create scoped spending tasks with your owner wallet.",
  },
  developer: {
    eyebrow: "DEVELOPER TOOLS",
    title: "Developer access",
    description:
      "Manage scoped API credentials for integrating with AgentVault.",
  },
  security: {
    eyebrow: "RISK CONTROLS",
    title: "Security controls",
    description:
      "Safeguard the vault, revoke task permissions, or deactivate an agent.",
  },
};

function compactAddress(value: string): string {
  return value.length > 20 ? `${value.slice(0, 7)}…${value.slice(-7)}` : value;
}

type Wallet = {
  publicKey?: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  signMessage(
    message: Uint8Array,
    encoding?: "utf8"
  ): Promise<{ signature: Uint8Array }>;
};

type Session =
  | { authenticated: false }
  | {
      authenticated: true;
      owner: string;
      vault: string;
    };

type AgentTask = {
  taskPda: string;
  taskId: string;
  recipient: string;
  budgetBaseUnits: string;
  spentBaseUnits: string;
  remainingBaseUnits: string;
  nextNonce: string;
  expiresAtUnix: string;
  active: boolean;
};
type AgentRow = {
  agentPda: string;
  authority: string;
  active: boolean;
  tasks: AgentTask[];
};
type AgentsResponse = {
  network: "devnet";
  owner: string;
  vault: string;
  agents: AgentRow[];
};

type Treasury = {
  network: "devnet";
  owner: string;
  vault: string;
  vaultId: string;
  tokenMint: string;
  treasury: string;
  decimals: number;
  paused: boolean;
  balanceBaseUnits: string;
  reservedBaseUnits: string;
  availableBaseUnits: string;
};

function walletProvider(): Wallet | null {
  const browser = window as unknown as {
    phantom?: { solana?: Wallet };
    solana?: Wallet;
  };
  const provider = browser.phantom?.solana ?? browser.solana;
  return provider &&
    typeof provider.connect === "function" &&
    typeof provider.signMessage === "function"
    ? provider
    : null;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    // Show only the endpoint label and status. Never display session data,
    // response bodies, or query parameters from protected routes.
    const endpoint = path.split("?")[0];
    throw new Error(`Owner-vault ${endpoint} HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function preciseAmount(base: string, decimals: number): string {
  const amount = BigInt(base);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw new Error("Invalid token decimals");
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = amount / divisor;
  const fractional = (amount % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

export default function SelectedVaultDashboard() {
  const vault = new URLSearchParams(window.location.search).get("vault") ?? "";
  const [session, setSession] = useState<Session | null>(null);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [activeSection, setActiveSection] =
    useState<ConsoleSection>("overview");

  const refresh = useCallback(async () => {
    try {
      const [value, inventory] = await Promise.all([
        requestJson<Treasury>("/owner-vault/api/treasury"),
        requestJson<AgentsResponse>("/owner-vault/api/agents"),
      ]);
      if (
        value.vault !== vault ||
        value.network !== "devnet" ||
        inventory.vault !== vault ||
        inventory.owner !== value.owner ||
        inventory.network !== "devnet" ||
        !Array.isArray(inventory.agents)
      ) {
        throw new Error(
          "Selected-vault data does not match the authenticated session"
        );
      }
      // Update both verified snapshots together, never mix fresh and stale scopes.
      setTreasury(value);
      setAgents(inventory.agents);
      setLastVerifiedAt(new Date());
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to refresh verified vault data"
      );
      throw cause;
    }
  }, [vault]);

  async function refreshFromButton() {
    setRefreshing(true);
    setError(null);
    try {
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to refresh verified vault data"
      );
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let active = true;
    void requestJson<Session>("/owner-vault/auth/session")
      .then((status) => {
        if (!active) return;
        setSession(status);
        if (status.authenticated && status.vault === vault) {
          void Promise.all([
            requestJson<Treasury>("/owner-vault/api/treasury"),
            requestJson<AgentsResponse>("/owner-vault/api/agents"),
          ])
            .then(([value, inventory]) => {
              if (!active) return;
              if (
                value.vault !== vault ||
                value.network !== "devnet" ||
                inventory.owner !== value.owner ||
                inventory.vault !== vault ||
                inventory.network !== "devnet" ||
                !Array.isArray(inventory.agents)
              ) {
                setError("Selected-vault data scope mismatch");
                return;
              }
              setTreasury(value);
              setAgents(inventory.agents);
              setLastVerifiedAt(new Date());
              setError(null);
            })
            .catch((cause: unknown) => {
              if (active) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Unable to load selected-vault data"
                );
              }
            });
        }
      })
      .catch(() => {
        if (active) setError("Selected-vault API unavailable");
      });
    return () => {
      active = false;
    };
  }, [vault]);

  async function signIn() {
    const wallet = walletProvider();
    if (!wallet)
      return setError(
        "Connect a Phantom-compatible wallet supporting signMessage"
      );
    setBusy(true);
    setError(null);
    try {
      // Reject malformed input before asking the wallet to sign anything.
      if (new PublicKey(vault).toBase58() !== vault)
        throw new Error("Invalid selected vault address");
      const connected = await wallet.connect();
      // Prefer the public key returned by this connection, not stale provider state.
      const owner = (connected.publicKey ?? wallet.publicKey)?.toBase58();
      if (!owner) throw new Error("Wallet returned no public key");
      const params = new URLSearchParams({ owner, vault });
      const challenge = await requestJson<{
        nonce: string;
        message: string;
        ownerPublicKey: string;
        vaultPublicKey: string;
      }>(`/owner-vault/auth/challenge?${params.toString()}`);
      if (
        challenge.ownerPublicKey !== owner ||
        challenge.vaultPublicKey !== vault
      ) {
        throw new Error(
          "Owner challenge did not match the connected wallet or vault"
        );
      }
      const signed = await wallet.signMessage(
        new TextEncoder().encode(challenge.message),
        "utf8"
      );
      const signature = btoa(String.fromCharCode(...signed.signature));
      const nextSession = await requestJson<Session>(
        "/owner-vault/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nonce: challenge.nonce,
            publicKey: owner,
            vault,
            signature,
          }),
        }
      );
      if (
        !nextSession.authenticated ||
        nextSession.vault !== vault ||
        nextSession.owner !== owner
      ) {
        throw new Error("Vault authentication failed");
      }
      setSession(nextSession);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Owner login failed");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await requestJson("/owner-vault/auth/logout", { method: "POST" });
      setSession({ authenticated: false });
      setTreasury(null);
      setAgents(null);
      setError(null);
    } catch {
      setError("Unable to end owner session; retry sign-out");
    } finally {
      setBusy(false);
    }
  }

  const authenticated = session?.authenticated && session.vault === vault;
  const agentCount = agents?.length ?? 0;
  // Only active authorities and unrevoked tasks appear in the default inventory.
  // Preserve complete verified snapshot for Security: deactivating an agent
  // does NOT release the reservations of its still-active tasks.
  const visibleAgents = agents
    ?.filter((agent) => agent.active)
    .map((agent) => ({
      ...agent,
      tasks: agent.tasks.filter((task) => task.active),
    }));
  const activeAgentCount = visibleAgents?.length ?? 0;
  const activeTaskCount =
    visibleAgents?.reduce((total, agent) => total + agent.tasks.length, 0) ?? 0;
  const reservedShare =
    treasury && BigInt(treasury.balanceBaseUnits) > 0n
      ? Number(
          (BigInt(treasury.reservedBaseUnits) * 100n) /
            BigInt(treasury.balanceBaseUnits)
        )
      : 0;
  const reservedProgress = Math.min(100, Math.max(0, reservedShare));
  const amounts = (value: string) =>
    preciseAmount(value, treasury?.decimals ?? 0);
  const current = sectionDetails[activeSection];

  function openSection(section: ConsoleSection) {
    setActiveSection(section);
    // Use actual state rather than navigation links, preserving authenticated context.
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="av-owner-page av-vault-page av-console-page">
      {!authenticated ? (
        <div className="av-console-auth-shell">
          <div className="av-console-auth-copy">
            <span className="av-console-overline">
              <ShieldCheck size={15} /> PRIVATE OWNER WORKSPACE · DEVNET
            </span>
            <h1>
              Your treasury.
              <br />
              <span>Your rules.</span>
            </h1>
            <p>
              One vault for your agents, with on-chain spending policies and
              owner-signed controls. Sign in with the wallet that owns this
              vault.
            </p>
            <div className="av-console-auth-features">
              <span>
                <LockKeyhole size={16} /> Wallet-verified owner access
              </span>
              <span>
                <Bot size={16} /> Agent-specific spending budgets
              </span>
              <span>
                <ShieldCheck size={16} /> On-chain policy enforcement
              </span>
            </div>
          </div>
          <section
            className="av-console-auth-card"
            aria-label="Owner wallet sign in"
          >
            <div className="av-console-iconbox">
              <Wallet size={25} />
            </div>
            <span className="av-console-overline">SECURE CONNECTION</span>
            <h2>Access your vault</h2>
            <p>
              Authenticate with your owner wallet to view balances and manage
              agent policies.
            </p>
            <div className="av-console-auth-address">
              <span>Selected vault</span>
              <code title={vault}>
                {vault ? compactAddress(vault) : "No vault selected"}
              </code>
            </div>
            {error && (
              <div role="alert" className="av-console-alert">
                <CircleAlert size={17} />
                <span>{error}</span>
              </div>
            )}
            {!session && (
              <p role="status" className="av-console-status-text">
                Checking owner session…
              </p>
            )}
            {session && !authenticated && (
              <button
                type="button"
                className="av-console-primary av-console-signin"
                disabled={busy || !vault}
                onClick={() => void signIn()}
              >
                <Wallet size={17} />{" "}
                {busy ? "Authenticating…" : "Connect owner wallet"}{" "}
                <ArrowRight size={17} />
              </button>
            )}
            <a className="av-console-back" href="/onboarding">
              <ArrowLeft size={15} /> Back to your vaults
            </a>
            <p className="av-console-devnet-note">
              Devnet preview. Wallet authentication does not authorize a
              payment.
            </p>
          </section>
        </div>
      ) : (
        <div className="av-console-layout">
          <aside
            className="av-console-sidebar"
            aria-label="Vault workspace sidebar"
          >
            <div className="av-console-side-heading">
              <span className="av-console-side-kicker">WORKSPACE</span>
              <strong>Owner console</strong>
              <div className="av-console-side-vault">
                <span className="av-console-mini-icon">
                  <Wallet size={18} />
                </span>
                <div>
                  <strong
                    title={
                      treasury ? `Vault #${treasury.vaultId}` : "Your vault"
                    }
                  >
                    {treasury ? `Vault #${treasury.vaultId}` : "Your vault"}
                  </strong>
                  <small title={vault}>{compactAddress(vault)}</small>
                </div>
                <span className="av-console-green-dot" aria-hidden="true" />
              </div>
            </div>
            <nav className="av-console-nav" aria-label="Vault sections">
              <span className="av-console-nav-label">MANAGE YOUR VAULT</span>
              {consoleSections.map(({ id, name, description, icon: Icon }) => (
                <button
                  type="button"
                  key={id}
                  className={`av-console-nav-item${
                    activeSection === id ? " is-active" : ""
                  }`}
                  aria-current={activeSection === id ? "page" : undefined}
                  onClick={() => openSection(id)}
                >
                  <Icon size={19} strokeWidth={1.8} />
                  <span>
                    <strong>{name}</strong>
                    <small>{description}</small>
                  </span>
                  {activeSection === id && (
                    <ChevronRight
                      size={16}
                      className="av-console-nav-chevron"
                    />
                  )}
                </button>
              ))}
              <div className="av-console-side-divider" />
              <span className="av-console-nav-label">OPTIONAL</span>
              <button
                type="button"
                className={`av-console-nav-item av-console-expand${
                  activeSection === "developer" ? " is-active" : ""
                }`}
                aria-expanded={advancedOpen}
                aria-controls="av-console-advanced-nav"
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                <KeyRound size={19} strokeWidth={1.8} />
                <span>
                  <strong>Developer tools</strong>
                  <small>For API integrations</small>
                </span>
                <ChevronDown
                  size={16}
                  className={advancedOpen ? "is-open" : ""}
                />
              </button>
              {advancedOpen && (
                <div id="av-console-advanced-nav">
                  <button
                    type="button"
                    className={`av-console-nav-item av-console-advanced${
                      activeSection === "developer" ? " is-active" : ""
                    }`}
                    onClick={() => openSection("developer")}
                  >
                    <KeyRound size={17} />
                    <span>
                      <strong>API credentials</strong>
                      <small>Issue and revoke keys</small>
                    </span>
                  </button>
                </div>
              )}
              <div className="av-console-side-divider" />
              <span className="av-console-nav-label">WORKSPACE</span>
              <a
                className="av-console-nav-item av-console-nav-link"
                href="/onboarding"
              >
                <ArrowLeft size={19} strokeWidth={1.8} />
                <span>
                  <strong>All vaults</strong>
                  <small>Switch treasury</small>
                </span>
              </a>
            </nav>
            <div className="av-console-side-foot">
              <span className="av-console-connected">
                <span className="av-console-green-dot" /> Solana Devnet
              </span>
              <p>Experimental software. Not audited for customer funds.</p>
            </div>
          </aside>

          <div className="av-console-workspace">
            <header className="av-console-workspace-top">
              <div>
                <div className="av-console-breadcrumb">
                  <span>Workspace</span>
                  <ChevronRight size={14} />{" "}
                  {treasury ? `Vault #${treasury.vaultId}` : "Vault"}{" "}
                  <ChevronRight size={14} />{" "}
                  <strong>
                    {activeSection === "developer"
                      ? "Developer access"
                      : consoleSections.find((s) => s.id === activeSection)
                          ?.name}
                  </strong>
                </div>
                <span className="av-console-overline">
                  {current.eyebrow} · SOLANA DEVNET
                </span>
                <h1>{current.title}</h1>
                <p>{current.description}</p>
              </div>
              <div className="av-console-workspace-actions">
                <span
                  className={`av-console-state-chip${
                    treasury?.paused ? " is-paused" : ""
                  }`}
                >
                  <span className="av-console-green-dot" />
                  {treasury?.paused
                    ? "Vault paused"
                    : treasury
                    ? "Vault active"
                    : "Loading vault"}
                </span>
                <button
                  type="button"
                  disabled={busy || refreshing}
                  aria-busy={refreshing}
                  onClick={() => void refreshFromButton()}
                  title="Refresh verified vault data"
                >
                  <RefreshCw
                    size={17}
                    className={refreshing ? "av-refresh-spin" : undefined}
                  />
                  <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void signOut()}
                  title="End authenticated owner session"
                >
                  <LogOut size={17} /> <span>Sign out</span>
                </button>
              </div>
            </header>

            {lastVerifiedAt && (
              <div
                className={`av-console-freshness${error ? " is-stale" : ""}`}
                role="status"
              >
                <CheckCircle2 size={15} />
                <span>
                  {error ? "Showing last verified data" : "Data last verified"}{" "}
                  at {lastVerifiedAt.toLocaleTimeString()}
                  {error ? " · Refresh again after checking the API" : ""}
                </span>
              </div>
            )}
            {error && (
              <div
                role="alert"
                className="av-console-alert av-console-top-alert"
              >
                <CircleAlert size={17} />
                <span>{error}</span>
              </div>
            )}
            {!treasury && (
              <div role="status" className="av-console-loading">
                Loading verified treasury and agent inventory…
              </div>
            )}

            <div
              className="av-console-view"
              hidden={activeSection !== "overview"}
            >
              {treasury && (
                <>
                  <div className="av-console-intro">
                    <div>
                      <span className="av-console-overline">
                        TOTAL TREASURY
                      </span>
                      <h2>{amounts(treasury.balanceBaseUnits)}</h2>
                      <p>Selected vault SPL token units</p>
                    </div>
                    <div className="av-console-vault-id">
                      <Wallet size={17} />
                      <span>Vault #{treasury.vaultId}</span>
                      <span className="av-console-id-dot" />
                      {treasury.paused ? "Paused" : "On-chain active"}
                    </div>
                  </div>
                  <div className="av-console-metrics">
                    <article className="av-console-metric">
                      <div>
                        <span>Reserved funds</span>
                        <LockKeyhole size={19} />
                      </div>
                      <strong>{amounts(treasury.reservedBaseUnits)}</strong>
                      <small>Allocated to task budgets</small>
                    </article>
                    <article className="av-console-metric">
                      <div>
                        <span>Available funds</span>
                        <Coins size={19} />
                      </div>
                      <strong>{amounts(treasury.availableBaseUnits)}</strong>
                      <small>Unreserved treasury tokens</small>
                    </article>
                    <article className="av-console-metric">
                      <div>
                        <span>Active agents</span>
                        <Bot size={19} />
                      </div>
                      <strong>
                        {activeAgentCount}
                        <em> / {agentCount}</em>
                      </strong>
                      <small>
                        {activeTaskCount} active task
                        {activeTaskCount === 1 ? "" : "s"}
                      </small>
                    </article>
                  </div>
                  <div className="av-console-overview-grid">
                    <section className="av-console-glass av-console-budget-card">
                      <div className="av-console-card-head">
                        <div>
                          <span className="av-console-overline">
                            ALLOCATION
                          </span>
                          <h2>Budget allocation</h2>
                        </div>
                        <span className="av-console-card-icon">
                          <Activity size={18} />
                        </span>
                      </div>
                      <div className="av-console-budget-values">
                        <span>Reserved treasury funds</span>
                        <strong>{reservedShare}%</strong>
                      </div>
                      <div
                        className="av-console-progress"
                        role="progressbar"
                        aria-label="Reserved share of treasury balance"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={reservedProgress}
                      >
                        <div style={{ width: `${reservedProgress}%` }} />
                      </div>
                      <div className="av-console-budget-split">
                        <span>
                          <i className="av-console-legend-dot reserved" />{" "}
                          Reserved: {amounts(treasury.reservedBaseUnits)}
                        </span>
                        <span>
                          <i className="av-console-legend-dot available" />{" "}
                          Available: {amounts(treasury.availableBaseUnits)}
                        </span>
                      </div>
                      <div className="av-console-budget-bottom">
                        <ShieldCheck size={16} />
                        <span>
                          Funds remain governed by your on-chain spending
                          policy.
                        </span>
                      </div>
                    </section>
                    <section className="av-console-glass av-console-info-card">
                      <div className="av-console-card-head">
                        <div>
                          <span className="av-console-overline">
                            ON-CHAIN DETAILS
                          </span>
                          <h2>Vault identity</h2>
                        </div>
                        <span className="av-console-card-icon">
                          <Wallet size={18} />
                        </span>
                      </div>
                      <dl>
                        <div>
                          <dt>Vault address</dt>
                          <dd title={vault}>{compactAddress(vault)}</dd>
                        </div>
                        <div>
                          <dt>Owner</dt>
                          <dd title={treasury.owner}>
                            {compactAddress(treasury.owner)}
                          </dd>
                        </div>
                        <div>
                          <dt>Token mint</dt>
                          <dd title={treasury.tokenMint}>
                            {compactAddress(treasury.tokenMint)}
                          </dd>
                        </div>
                        <div>
                          <dt>Treasury PDA</dt>
                          <dd title={treasury.treasury}>
                            {compactAddress(treasury.treasury)}
                          </dd>
                        </div>
                      </dl>
                    </section>
                  </div>
                  <div className="av-console-actions-title">
                    <div>
                      <span className="av-console-overline">QUICK ACTIONS</span>
                      <h2>What would you like to do?</h2>
                    </div>
                  </div>
                  <div className="av-console-quick-grid">
                    <button
                      type="button"
                      onClick={() => openSection("deposit")}
                    >
                      <span className="av-console-quick-icon">
                        <ArrowDownToLine size={21} />
                      </span>
                      <strong>Deposit funds</strong>
                      <small>Top up this vault's SPL token treasury</small>
                      <ArrowRight size={18} />
                    </button>
                    <button type="button" onClick={() => openSection("agents")}>
                      <span className="av-console-quick-icon">
                        <Bot size={21} />
                      </span>
                      <strong>View agents & tasks</strong>
                      <small>
                        {activeTaskCount} active task
                        {activeTaskCount === 1 ? "" : "s"} in this vault
                      </small>
                      <ArrowRight size={18} />
                    </button>
                    <button type="button" onClick={() => openSection("manage")}>
                      <span className="av-console-quick-icon">
                        <Settings2 size={21} />
                      </span>
                      <strong>Create a task</strong>
                      <small>Set a budget and recipient</small>
                      <ArrowRight size={18} />
                    </button>
                    <button
                      type="button"
                      onClick={() => openSection("security")}
                    >
                      <span className="av-console-quick-icon">
                        <ShieldCheck size={21} />
                      </span>
                      <strong>Security controls</strong>
                      <small>Pause vault or revoke access</small>
                      <ArrowRight size={18} />
                    </button>
                  </div>
                  <div className="av-console-readonly">
                    <CircleAlert size={17} />
                    <p>
                      Payment execution and activity history are not available
                      in this selected-vault view. Use Payment approvals to sign
                      an exact request for separate CLI preview; no payment is
                      executed by this browser console.
                    </p>
                  </div>
                </>
              )}
            </div>

            <div
              className="av-console-view av-console-form-view"
              hidden={activeSection !== "deposit"}
            >
              <div className="av-console-view-callout">
                <ArrowDownToLine size={18} />
                <div>
                  <strong>Direct owner-wallet deposit</strong>
                  <p>
                    Transfer the selected legacy SPL token to your vault's
                    verified treasury with a Phantom-approved Devnet
                    transaction.
                  </p>
                </div>
              </div>
              {treasury && (
                <TreasuryDepositPanel
                  snapshot={treasury}
                  sessionOwner={session?.authenticated ? session.owner : ""}
                  onConfirmed={refresh}
                />
              )}
            </div>
            <div
              className="av-console-view"
              hidden={activeSection !== "agents"}
            >
              {treasury && (
                <>
                  <div className="av-console-section-meta">
                    <span>
                      {activeAgentCount} active agent
                      {activeAgentCount === 1 ? "" : "s"} · {activeTaskCount}{" "}
                      active task{activeTaskCount === 1 ? "" : "s"}
                    </span>
                    <button type="button" onClick={() => openSection("manage")}>
                      <Settings2 size={16} /> Manage agents{" "}
                      <ArrowRight size={16} />
                    </button>
                  </div>
                  {agents === null && (
                    <div role="status" className="av-console-loading">
                      Loading verified agents…
                    </div>
                  )}
                  {visibleAgents?.length === 0 && (
                    <div className="av-console-empty">
                      <Bot size={28} />
                      <h2>No active agents</h2>
                      <p>
                        {agents?.length
                          ? "Previously registered agents are inactive and hidden from this view."
                          : "Register your first agent authority to start creating scoped spending tasks."}
                      </p>
                      <button
                        type="button"
                        onClick={() => openSection("manage")}
                      >
                        Register an agent <ArrowRight size={16} />
                      </button>
                    </div>
                  )}
                  {agents !== null && (
                    <p className="av-console-inventory-note">
                      Showing active agents and non-revoked tasks only.
                      Deactivated agents and revoked tasks remain recorded
                      on-chain for audit purposes.
                    </p>
                  )}
                  <div className="av-console-agents-list">
                    {visibleAgents?.map((agent, index) => (
                      <article
                        className="av-console-agent"
                        key={agent.agentPda}
                      >
                        <div className="av-console-agent-head">
                          <div className="av-console-agent-head-main">
                            <span className="av-console-agent-avatar">
                              <Bot size={21} />
                            </span>
                            <div>
                              <span className="av-console-overline">
                                AGENT {String(index + 1).padStart(2, "0")}
                              </span>
                              <h2>{compactAddress(agent.authority)}</h2>
                              <small title={agent.agentPda}>
                                PDA: {compactAddress(agent.agentPda)}
                              </small>
                            </div>
                          </div>
                          <span
                            className={`av-console-status ${
                              agent.active ? "good" : "off"
                            }`}
                          >
                            {agent.active ? (
                              <CheckCircle2 size={14} />
                            ) : (
                              <CircleAlert size={14} />
                            )}{" "}
                            {agent.active ? "Active" : "Inactive"}
                          </span>
                        </div>
                        <div className="av-console-agent-content">
                          <div className="av-console-agent-subhead">
                            <strong>Spending tasks</strong>
                            <span>
                              {agent.tasks.length} task
                              {agent.tasks.length === 1 ? "" : "s"}
                            </span>
                          </div>
                          {agent.tasks.length === 0 ? (
                            <p className="av-console-no-tasks">
                              No active spending tasks for this agent.
                            </p>
                          ) : (
                            agent.tasks.map((task) => {
                              const total = BigInt(task.budgetBaseUnits);
                              const spent = BigInt(task.spentBaseUnits);
                              const percent =
                                total > 0n
                                  ? Math.min(
                                      100,
                                      Number((spent * 100n) / total)
                                    )
                                  : 0;
                              return (
                                <div
                                  className="av-console-task"
                                  key={task.taskPda}
                                >
                                  <div className="av-console-task-head">
                                    <strong>Task #{task.taskId}</strong>
                                    <span
                                      className={`av-console-status ${
                                        task.active ? "good" : "off"
                                      }`}
                                    >
                                      {task.active ? "Active" : "Revoked"}
                                    </span>
                                  </div>
                                  <div className="av-console-task-money">
                                    <span>
                                      Remaining{" "}
                                      <strong>
                                        {amounts(task.remainingBaseUnits)}
                                      </strong>
                                    </span>
                                    <span>
                                      Budget {amounts(task.budgetBaseUnits)}
                                    </span>
                                  </div>
                                  <div
                                    className="av-console-progress av-console-task-progress"
                                    role="progressbar"
                                    aria-label={`Task ${task.taskId} budget spent`}
                                    aria-valuenow={percent}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                  >
                                    <div style={{ width: `${percent}%` }} />
                                  </div>
                                  <div className="av-console-task-meta">
                                    <span>
                                      Spent: {amounts(task.spentBaseUnits)}
                                    </span>
                                    <span>Next nonce: {task.nextNonce}</span>
                                    <span>
                                      Expires (Unix): {task.expiresAtUnix}
                                    </span>
                                  </div>
                                  <div className="av-console-task-recipient">
                                    Allowed recipient{" "}
                                    <code title={task.recipient}>
                                      {compactAddress(task.recipient)}
                                    </code>
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div
              className="av-console-view av-console-form-view"
              hidden={activeSection !== "approvals"}
            >
              {treasury && agents && (
                <SelectedVaultPaymentApprovalPanel
                  snapshot={treasury}
                  sessionOwner={session?.authenticated ? session.owner : ""}
                  agents={visibleAgents ?? []}
                />
              )}
            </div>

            {/* Keep live owner-control forms mounted across views to preserve edits and wallet state. */}
            <div
              className="av-console-view av-console-form-view"
              hidden={activeSection !== "manage"}
            >
              <div className="av-console-view-callout">
                <Settings2 size={18} />
                <div>
                  <strong>Owner-signed policy management</strong>
                  <p>
                    Register agent authorities and create Model A tasks. Every
                    submission requires your connected owner wallet and a Devnet
                    transaction.
                  </p>
                </div>
              </div>
              {treasury && (
                <OwnerManagementPanel
                  snapshot={treasury}
                  sessionOwner={session?.authenticated ? session.owner : ""}
                  agents={agents ?? []}
                  onConfirmed={refresh}
                />
              )}
            </div>
            <div
              className="av-console-view av-console-form-view"
              hidden={activeSection !== "developer"}
            >
              <div className="av-console-view-callout">
                <KeyRound size={18} />
                <div>
                  <strong>Scoped developer credentials</strong>
                  <p>
                    Manage keys for integrations. Treat new credentials as
                    secrets; do not share them or paste them into screenshots.
                  </p>
                </div>
              </div>
              {treasury && (
                <DeveloperCredentialsPanel
                  key={`${
                    session?.authenticated ? session.owner : ""
                  }:${vault}`}
                  owner={session?.authenticated ? session.owner : ""}
                  vault={vault}
                />
              )}
            </div>
            <div
              className="av-console-view av-console-form-view"
              hidden={activeSection !== "security"}
            >
              <div className="av-console-view-callout warning">
                <ShieldCheck size={18} />
                <div>
                  <strong>Critical owner controls</strong>
                  <p>
                    Pausing, revoking tasks, and deactivating agents change
                    on-chain policy. Review every action in Phantom.
                  </p>
                </div>
              </div>
              {treasury && agents !== null && (
                <OwnerSecurityPanel
                  snapshot={treasury}
                  sessionOwner={session?.authenticated ? session.owner : ""}
                  agents={agents}
                  onConfirmed={refresh}
                />
              )}
            </div>
            <footer className="av-console-footer">
              <ShieldCheck size={15} />
              <span>
                Local development · Solana Devnet · No agent payment execution
                available through this console.
              </span>
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}
