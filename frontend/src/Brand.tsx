import { ArrowUpRight, ShieldCheck, ArrowLeft, LayoutGrid } from "lucide-react";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`av-mark${compact ? " av-mark--compact" : ""}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M20 3.6 34.3 11.8v16.4L20 36.4 5.7 28.2V11.8L20 3.6Z"
          stroke="currentColor"
          strokeWidth="2.4"
        />
        <path
          d="m20 11.3 8.3 4.8v8L20 28.9l-8.3-4.8v-8l8.3-4.8Z"
          fill="currentColor"
          fillOpacity=".18"
          stroke="currentColor"
          strokeWidth="1.9"
        />
        <path d="m20 16.1 3.4 2v4l-3.4 2-3.4-2v-4l3.4-2Z" fill="currentColor" />
      </svg>
    </span>
  );
}

export function BrandLockup({ subtitle = false }: { subtitle?: boolean }) {
  return (
    <span className="av-brand-lockup">
      <BrandMark />
      <span className="av-brand-copy">
        <strong>
          AgentVault<span className="av-brand-period">.</span>
        </strong>
        {subtitle && <small>CONTROL PLANE FOR AGENT PAYMENTS</small>}
      </span>
    </span>
  );
}

/** Group product controls together instead of displaying a lone text link. */
export function ProductNavigation({
  section,
}: {
  section?: "onboarding" | "vault";
}) {
  return (
    <header className="av-product-header">
      <div className="av-product-header-inner">
        <a href="/" className="av-brand-anchor" aria-label="AgentVault home">
          <BrandLockup />
        </a>
        <div className="av-product-header-right">
          <span className="av-env-chip">
            <span className="av-live-dot" /> SOLANA DEVNET
          </span>
          {section === "vault" && (
            <a className="av-nav-vaults" href="/onboarding">
              <ArrowLeft size={16} /> <span>All vaults</span>
            </a>
          )}
          {section === "onboarding" && (
            <span className="av-nav-workspace" aria-label="Current section">
              <LayoutGrid size={15} /> Owner workspace
            </span>
          )}
          <a
            className="av-product-home"
            href="/"
            aria-label="Back to AgentVault website"
          >
            <span>Website</span>
            <ArrowUpRight size={16} />
          </a>
        </div>
      </div>
    </header>
  );
}

export function ReadOnlyNote() {
  return (
    <span className="av-readonly-note">
      <ShieldCheck size={15} /> Read-only overview
    </span>
  );
}
