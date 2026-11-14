import { useState } from "react";
import { KeyRound, ShieldCheck, PlugZap, LockKeyhole } from "lucide-react";
import {
  authorizeCredentialAction,
  listCredentials,
  validApplicationId,
  type CredentialMetadata,
  type CredentialScope,
  type CredentialWallet,
  type IssuedCredential,
} from "./developer-credentials";

type Props = { owner: string; vault: string };
function walletProvider(): CredentialWallet | null {
  const w = window as unknown as {
    phantom?: { solana?: CredentialWallet };
    solana?: CredentialWallet;
  };
  const provider = w.phantom?.solana ?? w.solana;
  return provider &&
    typeof provider.connect === "function" &&
    typeof provider.signMessage === "function"
    ? provider
    : null;
}
function status(record: CredentialMetadata): string {
  if (record.revokedAt !== null) return "Revoked";
  if (record.expiresAt !== null && record.expiresAt <= Date.now())
    return "Expired";
  return "Active";
}
function dateTime(timestamp: number | null): string {
  return timestamp === null ? "Not set" : new Date(timestamp).toLocaleString();
}

/** Mounted only during the authenticated selected-vault owner session. */
export default function DeveloperCredentialsPanel({ owner, vault }: Props) {
  const [principalId, setPrincipalId] = useState("research-agent");
  const [scope, setScope] = useState<CredentialScope>("payments:request");
  const [hours, setHours] = useState("1");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keys, setKeys] = useState<CredentialMetadata[] | null>(null);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  // The dashboard keys this panel by authenticated owner + vault, so a
  // session/vault change unmounts the component and drops the one-time secret.
  function changeApplication(next: string) {
    setPrincipalId(next);
    setIssued(null);
    setKeys(null);
    setAck(false);
    setError(null);
    setNotice(null);
    setRevokeId(null);
  }

  async function refresh() {
    if (!validApplicationId(principalId))
      throw new Error(
        "Use a 3–64 character application ID (letters, digits, _ or -)"
      );
    const next = await listCredentials(principalId);
    setKeys(next);
  }

  async function loadKeys() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to load credentials"
      );
    } finally {
      setBusy(false);
    }
  }

  async function issue() {
    setError(null);
    setNotice(null);
    // Clear any existing secret BEFORE starting another action.
    setIssued(null);
    if (!ack) return setError("Acknowledge the credential risk before signing");
    const wallet = walletProvider();
    if (!wallet)
      return setError("Connect a Phantom wallet supporting signMessage");
    const duration = Number(hours);
    if (!Number.isInteger(duration) || duration < 1 || duration > 24) {
      return setError("Choose a whole number of hours from 1 to 24");
    }
    if (!validApplicationId(principalId))
      return setError("Invalid application ID");
    setBusy(true);
    try {
      const result = await authorizeCredentialAction(
        { owner, vault, origin: window.location.origin, wallet },
        {
          action: "issue",
          principalId,
          scope,
          expiresAt: Date.now() + duration * 3_600_000,
        }
      );
      if (!("token" in result)) throw new Error("Unexpected issuance result");
      setIssued(result);
      setAck(false);
      setNotice(
        "Credential issued. Copy it now: this token cannot be retrieved again."
      );
      // Best-effort refresh: successful issuance must not be hidden if listing fails.
      try {
        await refresh();
      } catch {
        setKeys(null);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Credential issuance failed"
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(keyId: string) {
    setError(null);
    setNotice(null);
    setIssued(null);
    if (!ack) return setError("Acknowledge the credential risk before signing");
    const wallet = walletProvider();
    if (!wallet)
      return setError("Connect a Phantom wallet supporting signMessage");
    setBusy(true);
    try {
      const result = await authorizeCredentialAction(
        { owner, vault, origin: window.location.origin, wallet },
        { action: "revoke", keyId }
      );
      if (!("revoked" in result) || !result.revoked)
        throw new Error("Credential revocation failed");
      setNotice(`Credential ${keyId} revoked.`);
      setAck(false);
      setRevokeId(null);
      try {
        await refresh();
      } catch {
        setKeys(null);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Credential revocation failed"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="av-control-panel av-dev-panel av-owner-surface av-developer-panel"
      aria-label="Developer credentials"
    >
      <div className="av-panel-feature-header av-panel-feature-developer">
        <span className="av-panel-symbol">
          <PlugZap size={25} />
        </span>
        <div>
          <span className="av-panel-eyebrow">OPTIONAL · INTEGRATIONS</span>
          <h2>Connect your agent applications</h2>
          <p>
            Generate scoped credentials for backend services that submit intents
            or read activity.
          </p>
        </div>
        <span className="av-panel-env">ADVANCED</span>
      </div>
      <div className="av-dev-key-story">
        <div>
          <KeyRound size={21} />
          <strong>Granular access</strong>
          <small>Limit API permissions and lifespan.</small>
        </div>
        <div>
          <LockKeyhole size={21} />
          <strong>Owner verified</strong>
          <small>Approve issuance and revocation with Phantom.</small>
        </div>
      </div>
      <p>
        Local Solana Devnet only · Vault{" "}
        <code style={{ overflowWrap: "anywhere" }}>{vault}</code>
      </p>
      <p style={{ color: "#fbbf24" }}>
        A <code>payments:request</code> key can submit payment intents, but
        cannot authorize, sign or execute a transfer. Treat it as a secret; do
        not paste it into chat, screenshots, source code or browser storage.
      </p>
      {error && (
        <p role="alert" style={{ color: "#fca5a5" }}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" style={{ color: "#86efac" }}>
          {notice}
        </p>
      )}
      <label htmlFor="developer-application">
        Application ID (3–64 characters)
      </label>
      <div>
        <input
          id="developer-application"
          className="av-field-control"
          value={principalId}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => changeApplication(e.target.value)}
        />
      </div>
      <p>
        <button
          type="button"
          disabled={busy || !validApplicationId(principalId)}
          onClick={() => void loadKeys()}
        >
          List credentials for this application
        </button>
      </p>
      <div className="av-dev-issue av-panel-card">
        <div className="av-panel-card-title">
          <span className="av-mini-icon">
            <KeyRound size={20} />
          </span>
          <div>
            <small>ISSUE KEY</small>
            <h3>New credential</h3>
          </div>
        </div>
        <label htmlFor="developer-permission">Permission</label>
        <div>
          <select
            id="developer-permission"
            className="av-field-control"
            disabled={busy}
            value={scope}
            onChange={(e) => setScope(e.target.value as CredentialScope)}
          >
            <option value="payments:request">
              Submit payment intents only
            </option>
            <option value="activity:read">Read activity only</option>
          </select>
        </div>
        <label htmlFor="developer-expiry">
          Expires after (1–24 whole hours)
        </label>
        <div>
          <input
            id="developer-expiry"
            className="av-field-control"
            type="number"
            min="1"
            max="24"
            step="1"
            value={hours}
            disabled={busy}
            onChange={(e) => setHours(e.target.value)}
          />
        </div>
      </div>
      <p>
        <label className="av-panel-consent">
          <ShieldCheck size={17} />
          <input
            type="checkbox"
            checked={ack}
            disabled={busy}
            onChange={(e) => setAck(e.target.checked)}
          />{" "}
          I understand that issuing/revoking credentials requires a fresh
          Phantom signature and grants/restricts API access to this vault.
        </label>
      </p>
      <p>
        <button
          type="button"
          disabled={busy || !ack || !validApplicationId(principalId)}
          onClick={() => void issue()}
        >
          {busy ? "Processing…" : "Issue credential (Phantom signature)"}
        </button>
      </p>
      {issued && (
        <div
          className="av-dev-secret"
          role="region"
          aria-label="One-time API credential"
        >
          <h3>One-time credential — copy now</h3>
          <p>
            Key ID: <code>{issued.keyId}</code>
          </p>
          <p>
            <code style={{ overflowWrap: "anywhere", userSelect: "all" }}>
              {issued.token}
            </code>
          </p>
          <p>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(issued.token)
                  .then(() =>
                    setNotice(
                      "Copied to clipboard. Store only in a secure backend secret manager."
                    )
                  )
                  .catch(() =>
                    setError(
                      "Clipboard copy failed; copy manually and store securely."
                    )
                  );
              }}
            >
              Copy credential
            </button>{" "}
            <button
              type="button"
              onClick={() => {
                setIssued(null);
                setNotice("One-time credential hidden.");
              }}
            >
              Hide credential
            </button>
          </p>
          <p style={{ color: "#fbbf24" }}>
            Never put this token in frontend JavaScript, Git or screenshots.
          </p>
        </div>
      )}
      {keys !== null && (
        <div className="av-dev-existing">
          <h3>Credential metadata for {principalId}</h3>
          {keys.length === 0 && (
            <p>No credentials found for this application in this vault.</p>
          )}
          {keys.map((key) => (
            <div key={key.keyId} className="av-dev-existing-item">
              <p>
                <strong>{status(key)}</strong> · <code>{key.keyId}</code>
              </p>
              <p>
                Scope: {key.scopes.join(", ")} · Expires:{" "}
                {dateTime(key.expiresAt)}
              </p>
              {status(key) === "Active" && (
                <>
                  <button
                    type="button"
                    disabled={busy || !ack}
                    onClick={() => setRevokeId(key.keyId)}
                  >
                    Revoke this credential
                  </button>
                  {revokeId === key.keyId && (
                    <p>
                      <strong>Revoke {key.keyId} permanently?</strong>{" "}
                      <button
                        type="button"
                        disabled={busy || !ack}
                        onClick={() => void revoke(key.keyId)}
                      >
                        Confirm with Phantom
                      </button>{" "}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setRevokeId(null)}
                      >
                        Cancel
                      </button>
                    </p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
