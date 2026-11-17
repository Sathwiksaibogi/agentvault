import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  ArrowDownToLine,
  CheckCircle2,
  CircleAlert,
  Coins,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import type {
  OwnerManagementWallet,
  SelectedVaultSnapshot,
} from "./owner-management";
import {
  depositToTreasury,
  formatDepositAmount,
  inspectDeposit,
} from "./treasury-deposit";
import "./treasury-deposit.css";

type Props = {
  snapshot: SelectedVaultSnapshot;
  sessionOwner: string;
  onConfirmed: () => Promise<void>;
};

function phantom(): OwnerManagementWallet | null {
  const browser = window as unknown as {
    phantom?: { solana?: OwnerManagementWallet };
    solana?: OwnerManagementWallet;
  };
  const wallet = browser.phantom?.solana ?? browser.solana;
  return wallet &&
    typeof wallet.connect === "function" &&
    typeof wallet.signTransaction === "function"
    ? wallet
    : null;
}

function compact(value: string): string {
  return value.length > 21 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
}

export default function TreasuryDepositPanel({
  snapshot,
  sessionOwner,
  onConfirmed,
}: Props) {
  const [amount, setAmount] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [sourceAccount, setSourceAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  async function connectForDeposit(): Promise<OwnerManagementWallet> {
    const wallet = phantom();
    if (!wallet)
      throw new Error(
        "Use a Phantom-compatible wallet with transaction signing enabled"
      );
    const connected = await wallet.connect();
    const key = connected.publicKey ?? wallet.publicKey;
    if (!key?.equals(new PublicKey(sessionOwner))) {
      throw new Error(
        "Connected wallet does not match this vault's authenticated owner"
      );
    }
    return wallet;
  }

  async function checkBalance() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const wallet = await connectForDeposit();
      const value = await inspectDeposit({ wallet, snapshot, sessionOwner });
      setSourceAccount(value.source);
      setBalance(value.balanceBaseUnits);
    } catch (cause) {
      setBalance(null);
      setSourceAccount(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to verify funding wallet"
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitDeposit() {
    if (!confirmed)
      return setError("Acknowledge the transfer before continuing");
    setBusy(true);
    setError(null);
    setNotice(null);
    setSignature(null);
    try {
      const wallet = await connectForDeposit();
      const result = await depositToTreasury({
        wallet,
        snapshot,
        sessionOwner,
        amount: amount.trim(),
      });
      setSignature(result.signature);
      setNotice(
        `Confirmed transfer of ${formatDepositAmount(
          result.amountBaseUnits,
          snapshot.decimals
        )} tokens. Verifying updated treasury balance…`
      );
      setAmount("");
      setConfirmed(false);
      setBalance(null);
      setSourceAccount(null);
      try {
        await onConfirmed();
        setNotice("Deposit confirmed on Devnet and treasury data refreshed.");
      } catch {
        setNotice(
          "Deposit confirmed, but the dashboard did not refresh. Use Refresh to reload verified treasury data."
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Deposit could not be verified"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="av-deposit-shell"
      aria-label="Deposit SPL tokens into selected treasury"
    >
      <div className="av-deposit-head">
        <span className="av-deposit-icon">
          <ArrowDownToLine size={25} />
        </span>
        <div>
          <span className="av-console-overline">FUND YOUR VAULT</span>
          <h2>Deposit SPL tokens</h2>
          <p>
            Move tokens you already hold into this vault's verified treasury
            account.
          </p>
        </div>
      </div>
      <div className="av-deposit-columns">
        <div className="av-deposit-main">
          <div className="av-deposit-step">
            01 <span>Source and destination</span>
          </div>
          <div className="av-deposit-destination">
            <div>
              <span>From</span>
              <strong>Authenticated owner wallet</strong>
              <code title={sessionOwner}>{compact(sessionOwner)}</code>
            </div>
            <ArrowDownToLine size={20} aria-hidden="true" />
            <div>
              <span>To</span>
              <strong>AgentVault treasury</strong>
              <code title={snapshot.treasury}>
                {compact(snapshot.treasury)}
              </code>
            </div>
          </div>
          <div className="av-deposit-token-row">
            <div>
              <span>Vault token mint</span>
              <code title={snapshot.tokenMint}>
                {compact(snapshot.tokenMint)}
              </code>
            </div>
            <div>
              <span>Network</span>
              <strong>Solana Devnet</strong>
            </div>
          </div>
          <div className="av-deposit-step">
            02 <span>Check wallet balance</span>
          </div>
          <div className="av-deposit-balance">
            <div>
              <span>Available in your wallet's token account</span>
              <strong>
                {balance === null
                  ? "Not checked"
                  : formatDepositAmount(balance, snapshot.decimals)}
              </strong>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void checkBalance()}
            >
              <RefreshCw size={16} /> {busy ? "Checking…" : "Check balance"}
            </button>
          </div>
          {sourceAccount && (
            <p className="av-deposit-source" title={sourceAccount}>
              Source token account: {compact(sourceAccount)}
            </p>
          )}
          <div className="av-deposit-step">
            03 <span>Enter amount</span>
          </div>
          <label className="av-deposit-label" htmlFor="av-deposit-amount">
            Deposit amount (token units)
          </label>
          <div className="av-deposit-amount-wrap">
            <Coins size={18} />
            <input
              id="av-deposit-amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. 10.5"
              value={amount}
              disabled={busy}
              onChange={(event) => {
                setAmount(event.target.value);
                setError(null);
              }}
            />
            {balance !== null && balance > 0n && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  setAmount(formatDepositAmount(balance, snapshot.decimals))
                }
              >
                MAX
              </button>
            )}
          </div>
          <p className="av-deposit-helper">
            The selected vault accepts only its configured legacy SPL token.
            Deposits do not change spending approvals.
          </p>
          <label className="av-deposit-consent">
            <input
              type="checkbox"
              disabled={busy}
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              I have checked the mint and treasury. I understand this sends a
              real Devnet token transfer and costs Devnet SOL.
            </span>
          </label>
          <button
            type="button"
            className="av-deposit-submit"
            disabled={busy || !amount.trim() || !confirmed}
            onClick={() => void submitDeposit()}
          >
            <Wallet size={18} />{" "}
            {busy ? "Verifying / awaiting Phantom…" : "Deposit with Phantom"}{" "}
            <ArrowDownToLine size={18} />
          </button>
          {error && (
            <div className="av-deposit-alert" role="alert">
              <CircleAlert size={17} />
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div className="av-deposit-success" role="status">
              <CheckCircle2 size={17} />
              <span>{notice}</span>
            </div>
          )}
          {signature && (
            <a
              className="av-deposit-explorer"
              href={`https://explorer.solana.com/tx/${encodeURIComponent(
                signature
              )}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View confirmed transfer on Solana Explorer{" "}
              <ExternalLink size={15} />
            </a>
          )}
        </div>
        <aside className="av-deposit-explain">
          <span className="av-deposit-explain-icon">
            <ShieldCheck size={22} />
          </span>
          <h3>Your treasury stays in control</h3>
          <p>
            Depositing funds does not authorize an agent to spend. Agent
            payments still require valid on-chain task permissions.
          </p>
          <div className="av-deposit-explain-divider" />
          <strong>Before you deposit</strong>
          <p>
            Ensure the connected owner wallet holds this mint's tokens in its
            associated token account, plus some Devnet SOL for transaction fees.
          </p>
          {snapshot.paused && (
            <p className="av-deposit-paused">
              This vault is paused. Depositing tokens does not resume task
              execution or unpause the vault.
            </p>
          )}
          <div className="av-deposit-explain-divider" />
          <span>Current treasury balance</span>
          <strong className="av-deposit-current">
            {formatDepositAmount(
              BigInt(snapshot.availableBaseUnits),
              snapshot.decimals
            )}{" "}
            <small>available token units</small>
          </strong>
          <p>
            After confirmation, your dashboard will read the updated balance
            from its authenticated vault API.
          </p>
        </aside>
      </div>
    </section>
  );
}
