#!/usr/bin/env python3
"""Apply safe edits to the EXISTING AgentVault API server and App.tsx.

Run from the AgentVault repo root after copying in api.ts and web-vault-readonly.ts.
Backups are saved outside the Git repository under ~/.config/agentvault.
Re-run refuses to reapply if already updated.
"""
from pathlib import Path
import re
import shutil
import sys
from datetime import datetime, timezone

root = Path.cwd()
server_path = root / "demo/api-server.ts"
app_path = root / "frontend/src/App.tsx"
css_path = root / "frontend/src/index.css"
api_path = root / "frontend/src/api.ts"
web_path = root / "demo/web-vault-readonly.ts"


def require(cond: bool, msg: str) -> None:
    if not cond:
        raise RuntimeError(msg)


def replace_once(source: str, old: str, new: str, label: str) -> str:
    n = source.count(old)
    require(n == 1, f"{label}: expected one match; found {n}. Aborting without writing.")
    return source.replace(old, new, 1)


require(server_path.is_file() and app_path.is_file() and css_path.is_file(), "Run in AgentVault root")
require(api_path.is_file() and web_path.is_file(), "Copy the two supplied TS files first")

server = server_path.read_text()
app = app_path.read_text()
css = css_path.read_text()
require('"/api/web/dashboard"' not in server, "Backend already has web route")
require('id="vault-switch"' not in app, "App already has Vault selector")

server = replace_once(
    server,
    'import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";',
    'import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";\nimport { getWebVaultDashboard } from "./web-vault-readonly";',
    "API server import",
)
server = replace_once(
    server,
    '  if (pathname === "/api/treasury") {',
    '''  // Vault 2 is read-only: never read Vault 1 journal or approvals here.
  if (pathname === "/api/web/dashboard") {
    if (NETWORK !== "devnet") {
      sendJson(response, 404, { error: "Web vault available on Devnet only" });
      return;
    }

    try {
      const result = await cachedRead(
        "web-dashboard",
        () => getWebVaultDashboard(connection, program, state.genesisHash),
        30_000,
      );
      sendJson(response, 200, result);
    } catch (error) {
      console.error(
        "Web vault read failed:",
        error instanceof Error ? error.message : error,
      );
      sendJson(response, 503, { error: "Web vault data temporarily unavailable" });
    }
    return;
  }

  if (pathname === "/api/treasury") {''',
    "API server web route",
)

app = replace_once(
    app,
    'import { useCallback, useEffect, useState } from "react";',
    'import { useCallback, useEffect, useRef, useState } from "react";',
    "React useRef import",
)
app = replace_once(
    app,
    'import { getPhantomProvider } from "./phantom";',
    'import { getPhantomProvider } from "./phantom";\nimport type { VaultSelection } from "./api";',
    "VaultSelection import",
)
app = replace_once(
    app,
    '  const [data, setData] = useState<DashboardView | null>(null);',
    '''  const [selectedVault, setSelectedVault] = useState<VaultSelection>("cli");
  const selectedVaultRef = useRef<VaultSelection>("cli");
  const [data, setData] = useState<DashboardView | null>(null);''',
    "React vault state",
)
app = replace_once(
    app,
    'const result = await loadDashboard();',
    '''const result = await loadDashboard(selectedVault);
      if (selectedVaultRef.current !== selectedVault) return;''',
    "Manual refresh",
)
# Preserve other useCallback declarations: change only the dependency list
# directly before the auto-load effect.
app, n = re.subn(
    r'(  const refresh = useCallback\(async \(\) => \{[\s\S]*?)  \}, \[\]\);\n\n  useEffect',
    r'\1  }, [selectedVault]);\n\n  useEffect',
    app,
    count=1,
)
require(n == 1, "Could not find refresh useCallback dependency list")
app = replace_once(
    app,
    'void loadDashboard()',
    'void loadDashboard(selectedVault)',
    "Auto-load selected vault",
)
require(app.count('if (cancelled) return;') == 2, "Expected two cancelled guards in initial data-load effect")
app = app.replace(
    'if (cancelled) return;',
    'if (cancelled || selectedVaultRef.current !== selectedVault) return;',
)
app, n = re.subn(
    r'(  useEffect\(\(\) => \{[\s\S]*?)  \}, \[\]\);',
    r'\1  }, [selectedVault]);',
    app,
    count=1,
)
require(n == 1, "Could not find initial data-load effect dependency list")
# Avoid stale errors when a prior manual refresh rejects after a selection change.
app = replace_once(
    app,
    '''    } catch (cause) {
      setError(
        cause instanceof Error''',
    '''    } catch (cause) {
      if (selectedVaultRef.current !== selectedVault) return;
      setError(
        cause instanceof Error''',
    "Manual refresh error guard",
)

app = replace_once(
    app,
    """    } finally {
      setLoading(false);
    }
  }, [selectedVault]);""",
    """    } finally {
      if (selectedVaultRef.current === selectedVault) setLoading(false);
    }
  }, [selectedVault]);""",
    "Manual refresh loading race guard",
)

app = replace_once(
    app,
    '        <div className="header-actions">\n',
    '''        <div className="header-actions">
          <div className="vault-picker">
            <label htmlFor="vault-switch">Viewing</label>
            <select
              id="vault-switch"
              className="vault-picker-select"
              value={selectedVault}
              onChange={(event) => {
                const next = event.target.value as VaultSelection;
                selectedVaultRef.current = next;
                setSelectedVault(next);
                setData(null);
                setUpdatedAt(null);
                setError(null);
                setLoading(true);
                setExpandedWorkflowId(null);
              }}
            >
              <option value="cli">Vault 1 · CLI Demo</option>
              <option value="web">Vault 2 · Phantom</option>
            </select>
          </div>
''',
    "Vault picker in header",
)

app = app.replace(
    '"Connected wallet is not vault owner"',
    '"Connected wallet is not selected vault owner"',
)
app = app.replace(
    '"Connected address matches vault owner"',
    '"Connected address matches selected vault owner"',
)

app = replace_once(
    app,
    '<div className="empty-row">No workflows found.</div>',
    '''<div className="empty-row">
                    {selectedVault === "web"
                      ? "No Vault 2 workflow approvals yet. Creating an on-chain task is not an owner-signed AI payment workflow."
                      : "No workflows found."}
                  </div>''',
    "Empty workflow explanation",
)

css_marker = "/* Milestone 10.7: multi-vault selection */"
require(css_marker not in css, "Vault picker CSS already installed")
css += '''

/* Milestone 10.7: multi-vault selection */
.vault-picker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.vault-picker label {
  font-size: 0.75rem;
  color: #a9b6cc;
}
.vault-picker-select {
  min-height: 2.6rem;
  max-width: 12rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid #38465d;
  border-radius: 0.75rem;
  color: #f1f5ff;
  background-color: #172239;
  font: inherit;
  font-size: 0.85rem;
}
.vault-picker-select:focus-visible {
  outline: 2px solid #a092ff;
  outline-offset: 2px;
}
@media (max-width: 900px) {
  .header-actions { flex-wrap: wrap; }
  .vault-picker { width: 100%; }
}
'''

# Save backups OUTSIDE Git, so they cannot be accidentally committed.
backup_tag = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
backup_dir = Path.home() / ".config" / "agentvault" / "patch-backups" / f"10.7_{backup_tag}"
backup_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
for p in (server_path, app_path, css_path):
    backup = backup_dir / p.relative_to(root)
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(p, backup)
    print("Backup:", backup)

server_path.write_text(server)
app_path.write_text(app)
css_path.write_text(css)
print("Milestone 10.7 changes applied to existing backend, App and CSS.")
print("Backups stored outside Git. Review the diff before committing.")
