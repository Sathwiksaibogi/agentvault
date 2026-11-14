import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck, Wallet } from "lucide-react";
import { BrandLockup } from "./Brand";

/** Browser-wallet signature provider (Phantom-compatible signMessage API). */
type OwnerWallet = {
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<unknown>;
  signMessage(message: Uint8Array, encoding?: "utf8"): Promise<{ signature: Uint8Array }>;
};

function getWallet(): OwnerWallet | null {
  return (window as Window & { solana?: OwnerWallet }).solana ?? null;
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Dashboard login failed (HTTP ${response.status})`);
  return (await response.json()) as T;
}

/**
 * A wallet-signed, read-only local session. No API token, private key,
 * signature, or session ID is written to JavaScript storage.
 */
export function OwnerDashboardGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"checking" | "unauthenticated" | "authenticated">("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getJson<{ authenticated: boolean }>("/dashboard/auth/session")
      .then(({ authenticated }) => { if (active) setStatus(authenticated ? "authenticated" : "unauthenticated"); })
      .catch(() => { if (active) { setStatus("unauthenticated"); setError("Owner session service unavailable"); } });
    return () => { active = false; };
  }, []);

  async function connect() {
    const wallet = getWallet();
    if (!wallet) {
      setError("Install or enable a Solana wallet supporting signMessage to open the owner dashboard.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await wallet.connect();
      const ch = await getJson<{ nonce: string; message: string; ownerPublicKey: string }>("/dashboard/auth/challenge");
      const publicKey = wallet.publicKey?.toBase58();
      if (!publicKey || publicKey !== ch.ownerPublicKey) {
        throw new Error("The connected wallet is not the configured AgentVault owner.");
      }
      const signed = await wallet.signMessage(new TextEncoder().encode(ch.message), "utf8");
      const signature = btoa(String.fromCharCode(...signed.signature));
      await getJson<{ authenticated: boolean }>("/dashboard/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: ch.nonce, publicKey, signature }),
      });
      setStatus("authenticated");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet authorization unsuccessful");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await getJson("/dashboard/auth/logout", { method: "POST" });
      setStatus("unauthenticated");
      setError(null);
    } catch {
      setError("Unable to sign out. Close the browser or retry.");
    } finally {
      setBusy(false);
    }
  }

  if (status === "checking") return (
    <main className="av-auth-page"><div className="av-auth-panel"><span className="av-auth-spinner"/> Checking owner session…</div></main>
  );
  if (status === "unauthenticated") {
    return (
      <div className="av-auth-page">
        <div className="av-auth-top"><a href="/" className="av-brand-anchor"><BrandLockup /></a><span className="av-env-chip"><span className="av-live-dot"/> DEVNET</span></div>
        <main className="av-auth-panel">
          <span className="av-auth-symbol"><LockKeyhole size={26} strokeWidth={1.6}/></span>
          <span className="av-auth-eyebrow">SECURE OWNER ACCESS</span>
          <h1>Your treasury.<br/><em>Your control.</em></h1>
          <p>Sign in with your vault-owner wallet to inspect treasury balances, agent policies, workflow approvals and on-chain activity.</p>
          <div className="av-auth-info"><ShieldCheck size={18}/><span>Wallet-signed, read-only session. Signing in will not approve or execute a payment.</span></div>
          {error && <p className="av-auth-error" role="alert">{error}</p>}
          <button className="av-auth-submit" type="button" disabled={busy} onClick={() => void connect()}>
            <Wallet size={18}/>{busy ? "Verifying owner…" : "Connect owner wallet"}<ArrowRight size={17}/>
          </button>
          <div className="av-auth-links"><a href="/"><ArrowLeft size={15}/> Back to website</a><a href="/onboarding">Manage your vaults <ArrowRight size={15}/></a></div>
        </main>
        <span className="av-auth-bottom">AGENTVAULT · LOCAL DEVNET PREVIEW · NOT FOR CUSTOMER FUNDS</span>
      </div>
    );
  }
  return (
    <>
      <div className="av-verified-ribbon">
        <span><ShieldCheck size={14}/> Owner wallet verified <i/> Read-only session</span>
        <button type="button" onClick={() => void logout()} disabled={busy}>Sign out</button>
      </div>
      {error && <p className="av-global-error" role="alert">{error}</p>}
      {children}
    </>
  );
}
