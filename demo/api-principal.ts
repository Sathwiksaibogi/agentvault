export type ApiRole = "owner" | "developer";

export type ApiScope =
  | "treasury:read"
  | "agents:read"
  | "workflows:read"
  | "activity:read";

export type ApiPrincipal = {
  principalId: string;
  role: ApiRole;
  vaults: readonly string[];
  scopes: readonly ApiScope[];
};

export function createLegacyPrincipal(
  role: ApiRole,
  runtimeVault: string,
  developerVault: string
): ApiPrincipal {
  if (role === "owner") {
    return {
      principalId: "legacy-owner",
      role,
      vaults: [runtimeVault],
      scopes: [
        "treasury:read",
        "agents:read",
        "workflows:read",
        "activity:read",
      ],
    };
  }

  return {
    principalId: "legacy-developer",
    role,
    vaults: [developerVault],
    scopes: ["activity:read"],
  };
}

export function hasApiScope(
  principal: ApiPrincipal,
  scope: ApiScope
): boolean {
  return principal.scopes.includes(scope);
}

export function hasVaultAccess(
  principal: ApiPrincipal,
  vault: string
): boolean {
  return principal.vaults.includes(vault);
}

export function isPrincipalRouteAllowed(
  principal: ApiPrincipal,
  pathname: string
): boolean {
  const routeScopes: Record<string, ApiScope> = {
    "/api/treasury": "treasury:read",
    "/api/agents": "agents:read",
    "/api/workflows": "workflows:read",
    "/api/activity": "activity:read",
  };

  if (
    /^\/api\/workflows\/[a-zA-Z0-9_-]{8,64}$/.test(pathname)
  ) {
    return (
      principal.role === "owner" &&
      hasApiScope(principal, "workflows:read")
    );
  }

  const requiredScope = routeScopes[pathname];

  if (!requiredScope) {
    return false;
  }

  // Preserve the existing developer API contract.
  if (
    principal.role === "developer" &&
    pathname !== "/api/activity"
  ) {
    return false;
  }

  return hasApiScope(principal, requiredScope);
}