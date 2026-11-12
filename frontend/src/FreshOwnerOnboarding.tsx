import { useCallback, useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
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

  const loadVaults = useCallback(async (publicKey: PublicKey) => {
    const discovered = await discoverOwnedVaults(connection, publicKey, programId);
    setVaults(discovered);
  }, [connection]);

  async function connect() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const wallet = injectedWallet();
      if (!wallet) throw new Error("Phantom (or a compatible Solana browser wallet) is required");
      const result = await wallet.connect();
      const publicKey = result.publicKey ?? wallet.publicKey;
      if (!publicKey) throw new Error("Wallet did not return a public key");
      setOwner(publicKey);
      setVaults([]);
      await loadVaults(publicKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to connect wallet");
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
      setError(cause instanceof Error ? cause.message : "Vault discovery failed");
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
      const result = await createOwnerVault({ connection, wallet, owner, mint, programId });
      setSuccess(`Vault created: ${result.vault} (transaction ${result.signature})`);
      await loadVaults(owner);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vault creation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 850, margin: "48px auto", padding: 24, fontFamily: "system-ui", color: "#f8fafc" }}>
      <p style={{ color: "#93c5fd", fontSize: 13, letterSpacing: 1 }}>AGENTVAULT · DEVNET ONBOARDING</p>
      <h1>Create your own AgentVault</h1>
      <p>Connect your wallet, find vaults you already own, or initialize a new vault and treasury on Solana Devnet.</p>
      <p style={{ color: "#fbbf24" }}>Devnet only. Creating a vault signs and broadcasts an on-chain transaction and spends Devnet SOL on fees and rent. It does not authorize agent payments.</p>
      <p style={{ fontSize: 12 }}>Program: <code>{programId.toBase58()}</code></p>
      <p><a style={{ color: "#93c5fd" }} href="/">Existing single-vault demo dashboard</a></p>

      <section style={{ background: "#172338", borderRadius: 12, padding: 24, marginTop: 24 }}>
        <h2>1. Connect wallet</h2>
        <button type="button" disabled={busy} onClick={() => void connect()}>
          {busy ? "Working…" : owner ? "Connect another wallet" : "Connect Phantom"}
        </button>
        {owner && <p>Connected owner: <code>{owner.toBase58()}</code></p>}
      </section>

      {owner && <section style={{ background: "#172338", borderRadius: 12, padding: 24, marginTop: 16 }}>
        <h2>2. Your vaults on Devnet</h2>
        <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh vaults</button>
        {vaults.length === 0 ? <p>No vaults found for this owner in the current AgentVault program.</p> :
          <ul style={{ paddingLeft: 20 }}>
            {vaults.map((vault) => <li key={vault.address} style={{ marginBottom: 20 }}>
              <strong>Vault ID {vault.vaultId}</strong> · {vault.paused ? "Paused" : "Active"}
              <div>Vault: <a style={{ color: "#93c5fd" }} href={explorer(vault.address)} target="_blank" rel="noopener noreferrer">{vault.address}</a></div>
              <div>Mint: <code>{vault.tokenMint}</code></div>
              <div>Treasury: <code>{vault.treasury}</code></div>
              <div>Reserved base units: {vault.totalReservedBaseUnits}</div>
              <div><a style={{ color: "#93c5fd" }} href={`/vault?vault=${encodeURIComponent(vault.address)}`}>Open your treasury dashboard</a></div>
            </li>)}
          </ul>}
      </section>}

      {owner && <section style={{ background: "#172338", borderRadius: 12, padding: 24, marginTop: 16 }}>
        <h2>3. Create a vault + treasury</h2>
        <label htmlFor="tokenMint">Existing Devnet SPL Token mint address</label>
        <input
          id="tokenMint"
          type="text"
          value={mintInput}
          onChange={(event) => setMintInput(event.target.value)}
          placeholder="Paste your initialized legacy SPL Token mint"
          spellCheck={false}
          autoComplete="off"
          style={{ display: "block", width: "100%", maxWidth: 600, margin: "12px 0", padding: 10 }}
        />
        <p style={{ fontSize: 13, color: "#cbd5e1" }}>Use a mint already deployed to Devnet (for example, your AgentVault demo test mint). No mint or tokens are created by this action.</p>
        <button type="button" disabled={busy || !mintInput.trim()} onClick={() => void createVault()}>
          {busy ? "Working…" : "Create vault and treasury (sign transaction)"}
        </button>
      </section>}

      {error && <p role="alert" style={{ color: "#fca5a5", marginTop: 20 }}>{error}</p>}
      {success && <p role="status" style={{ color: "#86efac", marginTop: 20 }}>{success}</p>}
      <p style={{ color: "#94a3b8", fontSize: 13, marginTop: 32 }}>
        You can now open your own vault's authenticated read-only treasury. Agent, task, approval and activity views remain disabled until their per-vault APIs are implemented.
      </p>
    </main>
  );
}
