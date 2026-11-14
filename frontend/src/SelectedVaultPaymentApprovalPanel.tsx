/**
 * Owner signs a single selected-vault Model A payment approval using Phantom.
 * This browser form only downloads the signed JSON; it NEVER executes a payment.
 */
import { useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { CheckCircle2, FileSignature, ShieldCheck } from "lucide-react";
import {
  AGENTVAULT_PROGRAM_ID,
  MAX_SELECTED_PAYMENT_BASE_UNITS,
  encodeSelectedVaultApproval,
  type SelectedVaultApproval,
} from "./selected-vault-approval";
import "./selected-vault-approval.css";

type AgentTask = {
  taskPda: string;
  taskId: string;
  recipient: string;
  remainingBaseUnits: string;
  expiresAtUnix: string;
  active: boolean;
};

type Agent = {
  agentPda: string;
  authority: string;
  active: boolean;
  tasks: AgentTask[];
};

type Treasury = {
  network: "devnet";
  vault: string;
  owner: string;
  tokenMint: string;
  paused: boolean;
};

type Wallet = {
  publicKey?: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  signMessage(
    data: Uint8Array,
    display?: "utf8"
  ): Promise<{ signature: Uint8Array }>;
};

function phantom(): Wallet | null {
  const browser = window as unknown as {
    phantom?: { solana?: Wallet };
    solana?: Wallet;
  };
  const wallet = browser.phantom?.solana ?? browser.solana;
  return wallet &&
    typeof wallet.connect === "function" &&
    typeof wallet.signMessage === "function"
    ? wallet
    : null;
}

async function authenticatedJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok)
    throw new Error(`Owner API ${path} HTTP ${response.status}`);
  return (await response.json()) as T;
}

function validateCanonical(value: string): string {
  const pubkey = new PublicKey(value);
  if (pubkey.toBase58() !== value) throw new Error("Noncanonical public key");
  return value;
}

export default function SelectedVaultPaymentApprovalPanel({
  snapshot,
  agents,
  sessionOwner,
}: {
  snapshot: Treasury;
  agents: Agent[];
  sessionOwner: string;
}) {
  const [taskPda, setTaskPda] = useState("");
  const [amountText, setAmountText] = useState("50000");
  const [category, setCategory] = useState<"procurement" | "operations">(
    "procurement"
  );
  const [description, setDescription] = useState(
    "Devnet procurement verification for AgentVault"
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedRequest, setSavedRequest] = useState<string | null>(null);

  const choices = useMemo(
    () =>
      agents
        .filter((agent) => agent.active)
        .flatMap((agent) =>
          agent.tasks
            .filter((task) => task.active)
            .map((task) => ({ agent, task }))
        ),
    [agents]
  );
  const selected = choices.find((entry) => entry.task.taskPda === taskPda);

  async function createApproval() {
    setBusy(true);
    setError(null);
    setSavedRequest(null);
    try {
      if (!selected) throw new Error("Select an active task first");
      if (!acknowledged)
        throw new Error("Confirm that this is a payment authorization");
      if (snapshot.network !== "devnet" || snapshot.paused)
        throw new Error("Only an active Devnet vault may authorize payments");
      if (!sessionOwner || snapshot.owner !== sessionOwner)
        throw new Error("Owner session scope mismatch");
      validateCanonical(snapshot.vault);
      validateCanonical(snapshot.owner);
      validateCanonical(snapshot.tokenMint);
      validateCanonical(selected.agent.authority);
      validateCanonical(selected.task.recipient);

      if (!/^[1-9]\d*$/.test(amountText))
        throw new Error("Enter an integer amount in token base units");
      const units = BigInt(amountText);
      if (units > BigInt(MAX_SELECTED_PAYMENT_BASE_UNITS))
        throw new Error(
          `Per-payment cap: ${MAX_SELECTED_PAYMENT_BASE_UNITS} base units`
        );
      if (units > BigInt(selected.task.remainingBaseUnits))
        throw new Error("Amount exceeds remaining task budget");
      const taskId = Number(selected.task.taskId);
      if (!Number.isSafeInteger(taskId) || taskId < 0)
        throw new Error("Task ID exceeds the v1 approval format");
      if (description.trim().length < 8 || description.length > 300)
        throw new Error("Description must be 8–300 characters");

      const wallet = phantom();
      if (!wallet)
        throw new Error("Phantom wallet with signMessage is required");
      const connected = await wallet.connect();
      const owner = (connected.publicKey ?? wallet.publicKey)?.toBase58();
      if (owner !== snapshot.owner)
        throw new Error(
          "Connected Phantom wallet is not the selected vault owner"
        );

      // Re-fetch the authenticated owner-scoped snapshot immediately before signing.
      const [liveTreasury, inventory] = await Promise.all([
        authenticatedJson<Treasury>("/owner-vault/api/treasury"),
        authenticatedJson<{
          network: "devnet";
          owner: string;
          vault: string;
          agents: Agent[];
        }>("/owner-vault/api/agents"),
      ]);
      if (
        liveTreasury.vault !== snapshot.vault ||
        liveTreasury.owner !== snapshot.owner ||
        liveTreasury.tokenMint !== snapshot.tokenMint ||
        liveTreasury.paused ||
        inventory.network !== "devnet" ||
        inventory.owner !== snapshot.owner ||
        inventory.vault !== snapshot.vault
      ) {
        throw new Error("Latest owner data does not match the selected vault");
      }
      const liveAgent = inventory.agents.find(
        (a) => a.agentPda === selected.agent.agentPda && a.active
      );
      const liveTask = liveAgent?.tasks.find(
        (t) => t.taskPda === selected.task.taskPda && t.active
      );
      if (
        !liveAgent ||
        !liveTask ||
        liveAgent.authority !== selected.agent.authority ||
        liveTask.taskId !== selected.task.taskId ||
        liveTask.recipient !== selected.task.recipient ||
        BigInt(liveTask.remainingBaseUnits) < units
      ) {
        throw new Error(
          "Agent or task changed; refresh the console before signing"
        );
      }

      const nowUnix = Math.floor(Date.now() / 1000);
      const maxExpiry = BigInt(liveTask.expiresAtUnix);
      const expiresAtUnix = Number(
        BigInt(nowUnix + 600) < maxExpiry ? BigInt(nowUnix + 600) : maxExpiry
      );
      if (!Number.isSafeInteger(expiresAtUnix) || expiresAtUnix <= nowUnix + 30)
        throw new Error("Task expires too soon for a new payment approval");

      const connection = new Connection(
        "https://api.devnet.solana.com",
        "confirmed"
      );
      const genesisHash = validateCanonical(await connection.getGenesisHash());
      const workflow: SelectedVaultApproval = {
        version: 1,
        network: "devnet",
        requestId: crypto.randomUUID(),
        genesisHash,
        programId: AGENTVAULT_PROGRAM_ID,
        vault: snapshot.vault,
        owner: snapshot.owner,
        mint: snapshot.tokenMint,
        assignedAgent: category === "procurement" ? "agent-a" : "agent-b",
        agentAuthority: liveAgent.authority,
        kind: category,
        taskId,
        recipient: liveTask.recipient,
        amountBaseUnits: Number(units),
        expiresAtUnix,
        description: description.trim(),
      };
      // Uses precisely the same v1 encoding as demo/signed-workflow.ts.
      const signedMessage = await wallet.signMessage(
        encodeSelectedVaultApproval(workflow),
        "utf8"
      );
      if (
        signedMessage.signature.length !== 64 ||
        wallet.publicKey?.toBase58() !== snapshot.owner
      )
        throw new Error("Wallet changed or returned an invalid signature");
      const signature = btoa(String.fromCharCode(...signedMessage.signature));
      const output = JSON.stringify({ workflow, signature }, null, 2) + "\n";
      const url = URL.createObjectURL(
        new Blob([output], { type: "application/json" })
      );
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `agentvault-approval-${workflow.requestId}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      setSavedRequest(workflow.requestId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Approval signing failed"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="av-approval-panel">
      <div className="av-approval-heading">
        <span className="av-approval-icon">
          <FileSignature size={25} />
        </span>
        <div>
          <p className="av-approval-eyebrow">
            MODEL A · EXACT PAYMENT APPROVAL
          </p>
          <h2>Authorize a test payment</h2>
          <p>
            Sign a vault-bound payment request in Phantom and download its
            approval JSON. No transfer occurs in this browser.
          </p>
        </div>
      </div>
      <div className="av-approval-grid">
        <label>
          <span>Active agent task</span>
          <select
            value={taskPda}
            onChange={(e) => setTaskPda(e.target.value)}
            disabled={busy}
          >
            <option value="">Select a task</option>
            {choices.map(({ agent, task }) => (
              <option key={task.taskPda} value={task.taskPda}>
                {agent.authority.slice(0, 7)}… · Task #{task.taskId}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Workflow category</span>
          <select
            value={category}
            disabled={busy}
            onChange={(e) =>
              setCategory(e.target.value as "procurement" | "operations")
            }
          >
            <option value="procurement">Procurement (agent-a)</option>
            <option value="operations">Operations (agent-b)</option>
          </select>
        </label>
        <label>
          <span>Amount (token base units, maximum 50,000)</span>
          <input
            inputMode="numeric"
            value={amountText}
            disabled={busy}
            onChange={(e) => setAmountText(e.target.value)}
          />
        </label>
        <label className="av-approval-wide">
          <span>Business reason for this exact payment</span>
          <textarea
            rows={3}
            maxLength={300}
            value={description}
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>
      {selected && (
        <div className="av-approval-summary">
          <span>
            Allowed recipient: <code>{selected.task.recipient}</code>
          </span>
          <span>
            Remaining task budget:{" "}
            <code>{selected.task.remainingBaseUnits} base units</code>
          </span>
          <span>Approval lifetime: up to 10 minutes</span>
        </div>
      )}
      <label className="av-approval-confirm">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        <span>
          I understand this signature authorizes the selected payment; it is not
          merely a wallet login. The separate CLI will only preview it for now.
        </span>
      </label>
      {error && (
        <div role="alert" className="av-approval-error">
          {error}
        </div>
      )}
      {savedRequest && (
        <div role="status" className="av-approval-success">
          <CheckCircle2 size={16} /> Signed approval downloaded. Request ID:{" "}
          <code>{savedRequest}</code>
        </div>
      )}
      <button
        className="av-approval-submit"
        type="button"
        disabled={busy || !selected || !acknowledged}
        onClick={() => void createApproval()}
      >
        <ShieldCheck size={17} />{" "}
        {busy ? "Verifying and signing…" : "Sign exact approval in Phantom"}
      </button>
      <p className="av-approval-foot">
        Devnet test only · No private agent key used · File is not a confirmed
        payment · Never use the old demo executor with this approval
      </p>
    </section>
  );
}
