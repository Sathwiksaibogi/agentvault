import { useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  CircleDot,
  Code2,
  Fingerprint,
  Layers3,
  LockKeyhole,
  Menu,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { BrandLockup } from "./Brand";

const features = [
  {
    index: "01",
    icon: <LockKeyhole size={21} strokeWidth={1.7} />,
    name: "Policy-bound spending",
    description:
      "Set task budgets, recipients and expiry windows. On-chain rules keep agent spending within its authorized scope.",
  },
  {
    index: "02",
    icon: <Bot size={21} strokeWidth={1.7} />,
    name: "One treasury. Multiple agents.",
    description:
      "Give each agent a distinct identity and task permissions while managing funds through a shared vault.",
  },
  {
    index: "03",
    icon: <Fingerprint size={21} strokeWidth={1.7} />,
    name: "Owner-first authorization",
    description:
      "Choose pre-authorized tasks or per-payment approvals. Agent instructions alone are not owner authorization.",
  },
  {
    index: "04",
    icon: <Activity size={21} strokeWidth={1.7} />,
    name: "An auditable workflow",
    description:
      "Inspect spending limits, request states and available Devnet activity without conflating intent with payment finality.",
  },
];

const steps = [
  {
    number: "01",
    title: "Create your vault",
    copy: "Connect your owner wallet and initialize a treasury on Solana Devnet.",
    icon: <Wallet size={21} />,
  },
  {
    number: "02",
    title: "Define the boundaries",
    copy: "Register agents and give each task its own recipient, budget and time window.",
    icon: <Layers3 size={21} />,
  },
  {
    number: "03",
    title: "Keep the final say",
    copy: "Track authorized activity and retain control over vault and agent policies.",
    icon: <ShieldCheck size={21} />,
  },
];

function FlowIllustration() {
  return (
    <div
      className="av-orbit-scene"
      aria-label="Illustration of an owner-controlled treasury and multiple agent paths"
      role="img"
    >
      <div className="av-orbit-halo" />
      <svg
        className="av-orbit-lines"
        viewBox="0 0 820 720"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id="avStreamA"
            x1="60"
            y1="560"
            x2="780"
            y2="140"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#77339e" stopOpacity="0" />
            <stop offset=".29" stopColor="#a850c2" stopOpacity=".4" />
            <stop offset=".62" stopColor="#f36548" />
            <stop offset="1" stopColor="#ffbe76" stopOpacity=".12" />
          </linearGradient>
          <linearGradient
            id="avStreamB"
            x1="60"
            y1="200"
            x2="780"
            y2="690"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#7847c7" stopOpacity="0" />
            <stop offset=".5" stopColor="#a14fc3" stopOpacity=".6" />
            <stop offset=".85" stopColor="#ff7a4a" />
            <stop offset="1" stopColor="#ff7a4a" stopOpacity="0" />
          </linearGradient>
          <filter id="avGlow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="8" />
          </filter>
        </defs>
        <g transform="rotate(-26 430 360)">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
            <ellipse
              key={n}
              cx="445"
              cy="351"
              rx={245 + n * 18}
              ry={91 + n * 16}
              stroke={n % 2 ? "url(#avStreamB)" : "url(#avStreamA)"}
              strokeWidth={n === 2 ? 2.8 : 1.4}
              opacity={0.9 - n * 0.055}
            />
          ))}
          <ellipse
            cx="445"
            cy="351"
            rx="278"
            ry="122"
            stroke="url(#avStreamA)"
            strokeWidth="12"
            filter="url(#avGlow)"
            opacity=".8"
          />
        </g>
        <path
          d="M84 591C211 511 249 453 399 413c142-38 236-102 354-255"
          stroke="url(#avStreamA)"
          strokeWidth="3"
          opacity=".75"
        />
        <path
          d="M55 610c160-70 210-108 335-159s254-84 380-259"
          stroke="url(#avStreamB)"
          strokeWidth="1.7"
          opacity=".7"
        />
      </svg>
      <div className="av-orbit-center">
        <span className="av-center-icon">
          <LockKeyhole size={25} />
        </span>
        <small>OWNER CONTROLLED</small>
        <strong>Shared Vault</strong>
        <span>On-chain policy</span>
      </div>
      <div className="av-orbit-label av-orbit-label-one">
        <span className="av-orbit-icon">
          <Bot size={16} />
        </span>
        <div>
          <strong>Agent 01</strong>
          <small>Budget scoped</small>
        </div>
        <span className="av-orbit-pulse" />
      </div>
      <div className="av-orbit-label av-orbit-label-two">
        <span className="av-orbit-icon">
          <Bot size={16} />
        </span>
        <div>
          <strong>Agent 02</strong>
          <small>Recipient scoped</small>
        </div>
        <span className="av-orbit-pulse" />
      </div>
      <div className="av-orbit-label av-orbit-label-three">
        <span className="av-orbit-icon">
          <Check size={16} />
        </span>
        <div>
          <strong>Owner policy</strong>
          <small>Enforced on-chain</small>
        </div>
        <span className="av-orbit-pulse" />
      </div>
      <div className="av-orbit-coordinate">CONTROL LAYER / SOLANA DEVNET</div>
    </div>
  );
}

export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="av-landing">
      <div className="av-announcement">
        <CircleDot size={13} />
        <span>
          DEVNET PREVIEW · EXPERIMENTAL SOFTWARE · NOT AUDITED FOR CUSTOMER
          FUNDS
        </span>
        <a href="#platform">
          Explore the platform <ArrowUpRight size={13} />
        </a>
      </div>
      <header className="av-landing-header">
        <a href="/" className="av-brand-anchor" aria-label="AgentVault home">
          <BrandLockup />
        </a>
        <nav
          className={`av-landing-nav${menuOpen ? " is-open" : ""}`}
          aria-label="Main navigation"
        >
          <a href="#platform" onClick={() => setMenuOpen(false)}>
            Platform
          </a>
          <a href="#how-it-works" onClick={() => setMenuOpen(false)}>
            How it works
          </a>
          <a href="#developers" onClick={() => setMenuOpen(false)}>
            Developers
          </a>
          <a
            className="av-mobile-nav-link"
            href="/onboarding"
            onClick={() => setMenuOpen(false)}
          >
            Launch app
          </a>
        </nav>
        <div className="av-landing-header-actions">
          <span className="av-env-chip">
            <span className="av-live-dot" /> DEVNET
          </span>
          <a href="/onboarding" className="av-header-cta">
            Launch app <ArrowUpRight size={15} />
          </a>
        </div>
        <button
          type="button"
          className="av-menu-toggle"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </header>

      <main>
        <section className="av-landing-hero" aria-labelledby="av-main-heading">
          <div className="av-hero-ambient" />
          <FlowIllustration />
          <div className="av-hero-inner">
            <div className="av-hero-content">
              <span className="av-hero-kicker">
                <span className="av-kicker-line" /> THE CONTROL PLANE FOR AGENT
                PAYMENTS
              </span>
              <h1 id="av-main-heading">
                Give agents
                <br />
                the power to spend.
                <br />
                <em>Keep the control.</em>
              </h1>
              <p>
                AI agents need to transact. Your treasury needs boundaries.
                AgentVault brings programmable spending policies, owner
                authorization, and multi-agent treasury management to Solana.
              </p>
              <div className="av-hero-actions">
                <a href="/onboarding" className="av-button-primary">
                  Explore on Devnet <ArrowRight size={19} />
                </a>
                <a href="#how-it-works" className="av-button-text">
                  See how it works <ArrowUpRight size={17} />
                </a>
              </div>
              <div className="av-hero-trust">
                <span>
                  <span className="av-live-dot" /> Solana Devnet
                </span>
                <span className="av-trust-separator" />
                <span>
                  <ShieldCheck size={14} /> Owner-signed policies
                </span>
                <span className="av-trust-separator" />
                <span>
                  <Code2 size={14} /> Developer API &amp; SDK
                </span>
              </div>
            </div>
          </div>
          <div className="av-hero-bottom">
            <span>BUILT FOR A WORLD OF AUTONOMOUS SOFTWARE</span>
            <a href="#platform">
              SCROLL TO EXPLORE <span>↓</span>
            </a>
          </div>
        </section>

        <section
          id="platform"
          className="av-landing-section av-platform-section"
        >
          <div className="av-section-heading av-split-heading">
            <div>
              <span className="av-section-kicker">01 / THE PLATFORM</span>
              <h2>
                Autonomy needs
                <br />
                <span>accountability.</span>
              </h2>
            </div>
            <p>
              Give AI agents freedom to act inside precise boundaries. Make your
              spending rules explicit, visible, and enforced by the underlying
              program—not by prompts.
            </p>
          </div>
          <div className="av-features-grid">
            {features.map((feature) => (
              <article className="av-feature-card" key={feature.index}>
                <div className="av-feature-top">
                  <span className="av-feature-icon">{feature.icon}</span>
                  <span className="av-feature-number">
                    {feature.index} / 04
                  </span>
                </div>
                <h3>{feature.name}</h3>
                <p>{feature.description}</p>
                <span className="av-feature-edge" />
              </article>
            ))}
          </div>
        </section>

        <section
          id="how-it-works"
          className="av-landing-section av-work-section"
        >
          <div className="av-section-heading">
            <span className="av-section-kicker">02 / HOW IT WORKS</span>
            <h2>
              Powerful controls.
              <br />
              <span>Simple mental model.</span>
            </h2>
          </div>
          <div className="av-step-grid">
            {steps.map((step) => (
              <div key={step.number} className="av-step">
                <div className="av-step-top">
                  <span>{step.number}</span>
                  <span className="av-step-icon">{step.icon}</span>
                </div>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="developers" className="av-developer-section">
          <div className="av-dev-glow" />
          <div className="av-dev-copy">
            <span className="av-section-kicker">03 / FOR BUILDERS</span>
            <h2>
              Infrastructure built
              <br />
              for agent-native apps.
            </h2>
            <p>
              Integrate controlled payment requests with the developer API and
              SDK. Inspect Devnet workflows while keeping financial
              authorization separate from AI decisions.
            </p>
            <a className="av-button-primary" href="/onboarding">
              Explore Devnet app <ArrowRight size={18} />
            </a>
          </div>
          <div
            className="av-code-preview"
            aria-label="Illustrative developer workflow"
          >
            <div className="av-code-header">
              <span className="av-code-dots">
                <i />
                <i />
                <i />
              </span>
              <span>PAYMENT REQUEST FLOW</span>
            </div>
            <div className="av-code-lines">
              <p>
                <span>01</span>
                <b>Developer API</b> <em>→</em> <strong>receive intent</strong>
              </p>
              <p>
                <span>02</span>
                <b>Policy checks</b> <em>→</em> <strong>verify scope</strong>
              </p>
              <p>
                <span>03</span>
                <b>Agent inbox</b> <em>→</em> <strong>discover request</strong>
              </p>
              <p>
                <span>04</span>
                <b>Owner controls</b> <em>→</em> <strong>bound spending</strong>
              </p>
            </div>
            <div className="av-code-footer">
              <span className="av-live-dot" /> ILLUSTRATIVE FLOW · NOT A PAYMENT
              CONFIRMATION
            </div>
          </div>
        </section>
      </main>
      <footer className="av-landing-footer">
        <a href="/" className="av-brand-anchor">
          <BrandLockup />
        </a>
        <span>Built on Solana · Devnet preview · Not production ready</span>
        <nav aria-label="Footer navigation">
          <a href="/onboarding">Get started</a>
          <a href="/onboarding">Your vaults</a>
          <a href="#platform">Platform</a>
        </nav>
      </footer>
    </div>
  );
}
