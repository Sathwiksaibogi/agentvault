import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./landing.css";
import "./product.css";
import "./onboarding.css";
import LandingPage from "./LandingPage";
import FreshOwnerOnboarding from "./FreshOwnerOnboarding";
import SelectedVaultDashboard from "./SelectedVaultDashboard";
import { ProductNavigation } from "./Brand";

// Keep existing authentication / transaction components unchanged.
// The public landing page is intentionally independent of the owner session.
const requestedPath = window.location.pathname.replace(/\/+$/, "") || "/";
// The previous demo URL is retired. Keep old bookmarks from hitting a dead endpoint.
if (requestedPath === "/dashboard") {
  window.history.replaceState(null, "", "/onboarding");
}
const pathname = requestedPath === "/dashboard" ? "/onboarding" : requestedPath;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {pathname === "/" ? (
      <LandingPage />
    ) : pathname === "/onboarding" ? (
      <>
        <ProductNavigation section="onboarding" />
        <FreshOwnerOnboarding />
      </>
    ) : pathname === "/vault" ? (
      <>
        <ProductNavigation section="vault" />
        <SelectedVaultDashboard />
      </>
    ) : (
      <LandingPage />
    )}
  </StrictMode>
);
