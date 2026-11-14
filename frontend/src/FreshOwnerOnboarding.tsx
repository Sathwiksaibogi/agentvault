import { useCallback, useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  Fingerprint,
  Layers3,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import {
  createOwnerVault,
  DEFAULT_PROGRAM_ID,
  DEVNET_RPC_URL,
  discoverOwnedVaults,
  type OwnedVault,
  type SignAndSendWallet,
} from "./onboarding";

function injectedWallet(): SignAndSendWallet | null {
  const browser = window as unknown as {
    phantom?: { solana?: SignAndSendWallet };
    solana?: SignAndSendWallet;
  };
  const wallet = browser.phantom?.solana ?? browser.solana;
  if (!wallet?.connect || !wallet?.signAndSendTransaction) return null;
  return wallet;
}

const programId = DEFAULT_PROGRAM_ID;
const rpcUrl = DEVNET_RPC_URL;
const shortKey = (value: string) => `${value.slice(0, 6)}…${value.slice(-6)}`;
const explorer = (address: string) =>
  `https://explorer.solana.com/address/${address}?cluster=devnet`;

export default function FreshOwnerOnboarding() {
  const connection = useMemo(() => new Connection(rpcUrl, "confirmed"), []);
  const [owner, setOwner] = useState<PublicKey | null>(null);
  const [vaults, setVaults] = useState<OwnedVault[]>([]);
  const [mintInput, setMintInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadVaults = useCallback(
    async (publicKey: PublicKey) => {
      const discovered = await discoverOwnedVaults(
        connection,
        publicKey,
        programId
      );
      setVaults(discovered);
    },
    [connection]
  );

  async function connect() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const wallet = injectedWallet();
      if (!wallet)
        throw new Error(
          "Phantom (or a compatible Solana browser wallet) is required"
        );
      const result = await wallet.connect();
      const publicKey = result.publicKey ?? wallet.publicKey;
      if (!publicKey) throw new Error("Wallet did not return a public key");
      setOwner(publicKey);
      setVaults([]);
      await loadVaults(publicKey);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to connect wallet"
      );
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!owner) return;
    setBusy(true);
    setError(null);
    try {
      await loadVaults(owner);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Vault discovery failed"
      );
    } finally {
      setBusy(false);
    }
  }

  async function createVault() {
    if (!owner) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const wallet = injectedWallet();
      if (!wallet) throw new Error("Wallet disconnected");
      const mint = new PublicKey(mintInput.trim());
      const result = await createOwnerVault({
        connection,
        wallet,
        owner,
        mint,
        programId,
      });
      setSuccess(
        `Vault created: ${result.vault} (transaction ${result.signature})`
      );
      await loadVaults(owner);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Vault creation failed"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="av-ob-main">
      <section className="av-ob-hero" aria-labelledby="av-ob-heading">
        <div className="av-ob-hero-grid" aria-hidden="true" />
        <div className="av-ob-glow av-ob-glow-a" aria-hidden="true" />
        <div className="av-ob-glow av-ob-glow-b" aria-hidden="true" />
        <div className="av-ob-hero-copy">
          <div className="av-ob-eyebrow">
            <span className="av-ob-eyebrow-line" /> THE OWNER CONTROL PLANE{" "}
            <span className="av-ob-separator">/</span> SOLANA DEVNET
          </div>
          <h1 id="av-ob-heading">
            Control starts
            <br />
            with <em>your vault.</em>
          </h1>
          <p className="av-ob-hero-lead">
            Connect your wallet, discover the treasuries you control, and set up
            your own secure spending environment for AI agents.
          </p>
          <div className="av-ob-hero-cta">
            <a href="#av-ob-setup" className="av-ob-primary-link">
              {owner ? "Continue to your vaults" : "Get started"}
              <ArrowRight size={18} />
            </a>
            <span className="av-ob-hero-meta">
              <span className="av-live-dot" /> DEVNET PREVIEW · NO MAINNET FUNDS
            </span>
          </div>
        </div>
        <div
          className="av-ob-orbit"
          aria-label="Illustration of an owner-controlled treasury with policy-bound AI agents"
        >
          <div className="av-ob-ring av-ob-ring-one" />
          <div className="av-ob-ring av-ob-ring-two" />
          <div className="av-ob-ring av-ob-ring-three" />
          <div className="av-ob-core">
            <span className="av-ob-core-icon">
              <LockKeyhole size={26} strokeWidth={1.6} />
            </span>
            <span className="av-ob-core-kicker">OWNER CONTROLLED</span>
            <strong>AgentVault</strong>
            <small>On-chain treasury policy</small>
          </div>
          <div className="av-ob-satellite av-ob-satellite-a">
            <Bot size={17} />
            <span>
              <strong>Agent identity</strong>
              <small>Scoped authority</small>
            </span>
          </div>
          <div className="av-ob-satellite av-ob-satellite-b">
            <ShieldCheck size={17} />
            <span>
              <strong>Spending policy</strong>
              <small>Bounded by the owner</small>
            </span>
          </div>
          <div className="av-ob-satellite av-ob-satellite-c">
            <Layers3 size={17} />
            <span>
              <strong>Shared treasury</strong>
              <small>One vault, many tasks</small>
            </span>
          </div>
          <div className="av-ob-orbit-caption">
            ILLUSTRATIVE CONTROL FLOW / DEVNET
          </div>
        </div>
      </section>

      <div className="av-ob-container" id="av-ob-setup">
        <div className="av-ob-stepper" aria-label="Onboarding progress">
          <div className={`av-ob-step ${owner ? "is-complete" : "is-current"}`}>
            <span className="av-ob-step-number">
              {owner ? <Check size={17} /> : "01"}
            </span>
            <span>
              <strong>Connect wallet</strong>
              <small>Verify wallet access</small>
            </span>
          </div>
          <span className="av-ob-step-connector" aria-hidden="true" />
          <div className={`av-ob-step ${owner ? "is-current" : ""}`}>
            <span className="av-ob-step-number">02</span>
            <span>
              <strong>Discover vaults</strong>
              <small>Find on-chain treasuries</small>
            </span>
          </div>
          <span className="av-ob-step-connector" aria-hidden="true" />
          <div
            className={`av-ob-step ${
              owner && vaults.length ? "is-current" : ""
            }`}
          >
            <span className="av-ob-step-number">03</span>
            <span>
              <strong>Manage policies</strong>
              <small>Enter your owner console</small>
            </span>
          </div>
        </div>

        <div className="av-ob-section-heading">
          <div>
            <span className="av-ob-kicker">GET STARTED</span>
            <h2>Set up your workspace</h2>
          </div>
          <p>
            Everything begins with a wallet you control. Your vault state is
            discovered directly from Solana Devnet.
          </p>
        </div>

        {error && (
          <div className="av-ob-notice av-ob-notice-error" role="alert">
            <CircleHelp size={19} />
            <div>
              <strong>Unable to complete the last step</strong>
              <p>{error}</p>
              <small>
                If wallet discovery fails, verify Phantom is on Devnet and your
                connection is available.
              </small>
            </div>
          </div>
        )}
        {success && (
          <div className="av-ob-notice av-ob-notice-success" role="status">
            <CheckCircle2 size={19} />
            <p>{success}</p>
          </div>
        )}

        <div className="av-ob-top-grid">
          <section className="av-ob-card av-ob-wallet-card">
            <div className="av-ob-card-heading">
              <span className="av-ob-card-icon">
                <Wallet size={23} />
              </span>
              <span className={`av-ob-status ${owner ? "is-connected" : ""}`}>
                <span />
                {owner ? "CONNECTED" : "NOT CONNECTED"}
              </span>
            </div>
            <span className="av-ob-kicker">STEP 01 / YOUR IDENTITY</span>
            <h3>Connect your wallet</h3>
            <p>
              Use Phantom or a compatible Solana wallet. Your wallet stays in
              control of all signing requests.
            </p>
            {owner && (
              <div className="av-ob-connected-owner">
                <span>CONNECTED OWNER</span>
                <div>
                  <Fingerprint size={18} />
                  <code title={owner.toBase58()}>
                    {shortKey(owner.toBase58())}
                  </code>
                  <a
                    href={explorer(owner.toBase58())}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="View connected owner on Solana Explorer"
                  >
                    <ExternalLink size={15} />
                  </a>
                </div>
              </div>
            )}
            <button
              className="av-ob-primary-button"
              type="button"
              disabled={busy}
              onClick={() => void connect()}
            >
              <Wallet size={17} />
              {busy
                ? "Connecting / discovering…"
                : owner
                ? "Switch connected wallet"
                : "Connect Phantom wallet"}
              <ArrowRight size={18} />
            </button>
            <span className="av-ob-help">
              <LockKeyhole size={13} /> Connecting does not authorize or send a
              payment.
            </span>
          </section>

          <section
            className={`av-ob-card av-ob-create-card ${
              !owner ? "is-locked" : ""
            }`}
          >
            <div className="av-ob-card-heading">
              <span className="av-ob-card-icon av-ob-card-icon-coral">
                <Plus size={23} />
              </span>
              <span className="av-ob-status">
                <span />
                {owner ? "READY TO CONFIGURE" : "WALLET REQUIRED"}
              </span>
            </div>
            <span className="av-ob-kicker">NEW VAULT</span>
            <h3>Create a treasury</h3>
            <p>
              Initialize a vault and treasury for an existing Devnet legacy SPL
              Token mint.
            </p>
            {owner ? (
              <>
                <label className="av-ob-field-label" htmlFor="tokenMint">
                  SPL TOKEN MINT ADDRESS
                </label>
                <input
                  id="tokenMint"
                  type="text"
                  value={mintInput}
                  onChange={(event) => setMintInput(event.target.value)}
                  placeholder="Paste an existing Devnet mint address"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="av-ob-input-help">
                  The mint must already exist on Devnet. No token mint is
                  created here.
                </span>
                <button
                  className="av-ob-secondary-button"
                  type="button"
                  disabled={busy || !mintInput.trim()}
                  onClick={() => void createVault()}
                >
                  {busy ? "Working…" : "Create vault & treasury"}
                  <ArrowUpRight size={18} />
                </button>
              </>
            ) : (
              <div className="av-ob-locked-preview">
                <LockKeyhole size={22} />
                <span>Connect your wallet to enable vault creation.</span>
              </div>
            )}
            <div className="av-ob-fee-notice">
              <ShieldCheck size={15} /> Creating a vault sends a Devnet
              transaction and spends Devnet SOL on fees and rent. It does not
              approve agent payments.
            </div>
          </section>
        </div>

        <section
          className="av-ob-card av-ob-vaults"
          aria-labelledby="av-ob-vault-title"
        >
          <div className="av-ob-vault-top">
            <div>
              <span className="av-ob-kicker">STEP 02 / ON-CHAIN ACCOUNTS</span>
              <h2 id="av-ob-vault-title">
                Your vaults{" "}
                <span className="av-ob-vault-count">
                  {owner ? vaults.length : "—"}
                </span>
              </h2>
              <p>
                Only vaults owned by the connected wallet and current AgentVault
                program are shown.
              </p>
            </div>
            {owner && (
              <button
                type="button"
                className="av-ob-refresh-button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                <RefreshCw size={16} />
                {busy ? "Checking…" : "Refresh vaults"}
              </button>
            )}
          </div>
          {!owner ? (
            <div className="av-ob-empty-state">
              <span className="av-ob-empty-icon">
                <Wallet size={27} />
              </span>
              <strong>Connect a wallet to discover your vaults</strong>
              <p>
                Your existing Devnet treasuries will appear here after wallet
                connection.
              </p>
            </div>
          ) : vaults.length === 0 ? (
            <div className="av-ob-empty-state">
              <span className="av-ob-empty-icon">
                <Layers3 size={27} />
              </span>
              <strong>No vaults found for this wallet</strong>
              <p>
                Try refreshing, switch to the correct owner wallet, or create a
                vault using the panel above.
              </p>
            </div>
          ) : (
            <div className="av-ob-vault-grid">
              {vaults.map((vault) => (
                <article className="av-ob-vault-tile" key={vault.address}>
                  <div className="av-ob-vault-tile-head">
                    <span className="av-ob-vault-icon">
                      <Layers3 size={22} />
                    </span>
                    <span
                      className={`av-ob-vault-state ${
                        vault.paused ? "is-paused" : ""
                      }`}
                    >
                      <span />
                      {vault.paused ? "PAUSED" : "ACTIVE"}
                    </span>
                  </div>
                  <h3>Vault #{vault.vaultId}</h3>
                  <p className="av-ob-vault-address">
                    <code title={vault.address}>{shortKey(vault.address)}</code>
                    <a
                      href={explorer(vault.address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`View Vault ${vault.vaultId} on Solana Explorer`}
                    >
                      <ExternalLink size={14} />
                    </a>
                  </p>
                  <dl>
                    <div>
                      <dt>Token mint</dt>
                      <dd title={vault.tokenMint}>
                        {shortKey(vault.tokenMint)}
                      </dd>
                    </div>
                    <div>
                      <dt>Treasury</dt>
                      <dd title={vault.treasury}>{shortKey(vault.treasury)}</dd>
                    </div>
                    <div>
                      <dt>Reserved (base units)</dt>
                      <dd>{vault.totalReservedBaseUnits}</dd>
                    </div>
                  </dl>
                  <a
                    className="av-ob-vault-open"
                    href={`/vault?vault=${encodeURIComponent(vault.address)}`}
                  >
                    Open owner console <ChevronRight size={18} />
                  </a>
                </article>
              ))}
            </div>
          )}
        </section>

        <div className="av-ob-bottom">
          <p>
            <ShieldCheck size={17} /> Devnet preview · experimental software ·
            not audited for customer funds.
          </p>
          <details>
            <summary>
              Advanced: program information <ChevronRight size={15} />
            </summary>
            <p>
              AgentVault program ID: <code>{programId.toBase58()}</code>
            </p>
            <p>Verify all vault addresses and wallet prompts before signing.</p>
          </details>
        </div>
      </div>
    </main>
  );
}
