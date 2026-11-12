import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { OwnerDashboardGate } from "./OwnerDashboardGate";
import FreshOwnerOnboarding from "./FreshOwnerOnboarding";
import SelectedVaultDashboard from "./SelectedVaultDashboard";

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname === "/onboarding" ? (
      <FreshOwnerOnboarding />
    ) : window.location.pathname === "/vault" ? (
      <SelectedVaultDashboard />
    ) : (
      <OwnerDashboardGate><App /></OwnerDashboardGate>
    )}
  </StrictMode>,
)
