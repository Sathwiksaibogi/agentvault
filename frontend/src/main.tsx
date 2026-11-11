import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { OwnerDashboardGate } from "./OwnerDashboardGate";
import FreshOwnerOnboarding from "./FreshOwnerOnboarding";

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname === "/onboarding" ? (
      <FreshOwnerOnboarding />
    ) : (
      <OwnerDashboardGate><App /></OwnerDashboardGate>
    )}
  </StrictMode>,
)
