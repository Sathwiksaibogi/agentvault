/**
 * First multi-owner dashboard slice: wallet-signed, selected-vault treasury.
 * Other read paths are deliberately unavailable until vault-scoped readers
 * exist; never mix a new vault with the original demo workflow index.
 */
import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";

type Wallet = {
  publicKey?: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  signMessage(message: Uint8Array, encoding?: "utf8"): Promise<{ signature: Uint8Array }>;
};

type Session = { authenticated: false } | {
  authenticated: true;
  owner: string;
  vault: string;
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
  if (!response.ok) throw new Error(`Owner-vault request failed (HTTP ${response.status})`);
  return (await response.json()) as T;
}

function preciseAmount(base: string, decimals: number): string {
  const amount = BigInt(base);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Invalid token decimals");
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = amount / divisor;
  const fractional = (amount % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

export default function SelectedVaultDashboard() {
  const vault = new URLSearchParams(window.location.search).get("vault") ?? "";
  const [session, setSession] = useState<Session | null>(null);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const value = await requestJson<Treasury>("/owner-vault/api/treasury");
    if (value.vault !== vault || value.network !== "devnet") {
      throw new Error("Selected vault does not match the authenticated session");
    }
    setTreasury(value);
  }, [vault]);

  useEffect(() => {
    let active = true;
    void requestJson<Session>("/owner-vault/auth/session")
      .then((status) => {
        if (!active) return;
        setSession(status);
        if (status.authenticated && status.vault === vault) {
          void requestJson<Treasury>("/owner-vault/api/treasury")
            .then((value) => {
              if (active && value.vault === vault) setTreasury(value);
            })
            .catch(() => { if (active) setError("Unable to load selected-vault treasury"); });
        }
      })
      .catch(() => { if (active) setError("Selected-vault API unavailable"); });
    return () => { active = false; };
  }, [vault]);

  async function signIn() {
    const wallet = walletProvider();
    if (!wallet) return setError("Connect a Phantom-compatible wallet supporting signMessage");
    setBusy(true);
    setError(null);
    try {
      // Reject malformed input before asking the wallet to sign anything.
      if (new PublicKey(vault).toBase58() !== vault) throw new Error("Invalid selected vault address");
      await wallet.connect();
      const owner = wallet.publicKey?.toBase58();
      if (!owner) throw new Error("Wallet returned no public key");
      const params = new URLSearchParams({ owner, vault });
      const challenge = await requestJson<{
        nonce: string; message: string; ownerPublicKey: string; vaultPublicKey: string;
      }>(`/owner-vault/auth/challenge?${params.toString()}`);
      if (challenge.ownerPublicKey !== owner || challenge.vaultPublicKey !== vault) {
        throw new Error("Owner challenge did not match the connected wallet or vault");
      }
      const signed = await wallet.signMessage(new TextEncoder().encode(challenge.message), "utf8");
      const signature = btoa(String.fromCharCode(...signed.signature));
      const nextSession = await requestJson<Session>("/owner-vault/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: challenge.nonce, publicKey: owner, vault, signature }),
      });
      if (!nextSession.authenticated || nextSession.vault !== vault || nextSession.owner !== owner) {
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
      setError(null);
    } catch {
      setError("Unable to end owner session; retry sign-out");
    } finally {
      setBusy(false);
    }
  }

  const authenticated = session?.authenticated && session.vault === vault;
  return (
    <main style={{ maxWidth: 850, margin: "48px auto", padding: 24, fontFamily: "system-ui", color: "#f8fafc" }}>
      <p style={{ color: "#93c5fd" }}>AGENTVAULT · DEVNET · SELECTED VAULT</p>
      <h1>Your AgentVault Treasury</h1>
      <p><a href="/onboarding" style={{ color: "#93c5fd" }}>Back to your vaults</a></p>
      <p>Vault: <code style={{ overflowWrap: "anywhere" }}>{vault}</code></p>
      <p>Each login is bound to the connected wallet and this exact on-chain vault.</p>
      {error && <p role="alert" style={{ color: "#fca5a5" }}>{error}</p>}
      {!session && <p>Checking owner session…</p>}
      {session && !authenticated && (
        <button type="button" disabled={busy || !vault} onClick={() => void signIn()}>
          {busy ? "Authenticating…" : "Connect owner wallet and sign in"}
        </button>
      )}
      {authenticated && (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
            <button type="button" disabled={busy} onClick={() => void refresh().catch(() => setError("Treasury refresh failed"))}>Refresh treasury</button>
            <button type="button" disabled={busy} onClick={() => void signOut()}>Sign out</button>
          </div>
          {treasury ? <section style={{ padding: 24, borderRadius: 12, background: "#172338" }}>
            <h2>Vault #{treasury.vaultId} · {treasury.paused ? "Paused" : "Active"}</h2>
            <p>Owner: <code>{treasury.owner}</code></p>
            <p>Mint: <code>{treasury.tokenMint}</code></p>
            <p>Treasury: <code>{treasury.treasury}</code></p>
            <p><strong>Balance:</strong> {preciseAmount(treasury.balanceBaseUnits, treasury.decimals)}</p>
            <p><strong>Reserved:</strong> {preciseAmount(treasury.reservedBaseUnits, treasury.decimals)}</p>
            <p><strong>Available:</strong> {preciseAmount(treasury.availableBaseUnits, treasury.decimals)}</p>
            <p style={{ color: "#94a3b8" }}>Amounts are shown in units of the selected vault's SPL token.</p>
          </section> : <p>Loading verified treasury…</p>}
          <p style={{ color: "#94a3b8" }}>
            Agent, task, approval, and activity views are not enabled for selected vaults yet.
            We will add vault-scoped readers rather than display the original demo's records.
          </p>
        </>
      )}
      <p style={{ color: "#fbbf24" }}>Local-development read-only view. This page does not submit payments or change vault policies.</p>
    </main>
  );
}
