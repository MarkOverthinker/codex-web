import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./error-boundary";
import { installClientErrorReporting } from "./client-errors";
import { applyThemePreference, readStoredThemePreference } from "./theme";
import "./styles.css";

applyThemePreference(readStoredThemePreference());
installClientErrorReporting();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
