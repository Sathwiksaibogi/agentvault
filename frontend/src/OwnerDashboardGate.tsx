import { useEffect, useState, type ReactNode } from "react";

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

  if (status === "checking") return <main style={{ padding: 32 }}>Checking owner session…</main>;
  if (status === "unauthenticated") {
    return (
      <main style={{ maxWidth: 580, margin: "15vh auto", padding: 32, fontFamily: "system-ui" }}>
        <h1>AgentVault Owner Dashboard</h1>
        <p>Connect your vault-owner wallet to view treasury, agents, approvals and activity.</p>
        <p>This is a local, read-only development dashboard. Signing in does not approve any payment.</p>
        {error && <p role="alert" style={{ color: "#b45309" }}>{error}</p>}
        <button type="button" disabled={busy} onClick={() => void connect()}>
          {busy ? "Verifying owner…" : "Connect owner wallet"}
        </button>
      </main>
    );
  }
  return (
    <>
      <div style={{ padding: "8px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, fontFamily: "system-ui", fontSize: 12, background: "#14251f", color: "#ffffff" }}>
        <span>Owner wallet verified · Read-only session</span>
        <button type="button" onClick={() => void logout()} disabled={busy}>Sign out</button>
      </div>
      {error && <p role="alert" style={{ padding: 12 }}>{error}</p>}
      {children}
    </>
  );
}
