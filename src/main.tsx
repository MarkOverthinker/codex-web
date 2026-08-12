import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./error-boundary";
import { installClientErrorReporting } from "./client-errors";
import { applyThemePreference, readStoredThemePreference } from "./theme";
import "./styles.css";

installClientErrorReporting();

function renderBootstrapFallback(message: string): void {
  const host = document.body ?? document.documentElement;
  if (!host) return;
  const fallback = document.createElement("main");
  fallback.setAttribute("role", "alert");
  fallback.style.cssText = [
    "box-sizing:border-box",
    "min-height:100vh",
    "display:grid",
    "place-content:center",
    "padding:32px",
    "font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif",
    "color:#1c1e26",
    "background:#f7f8f6",
    "text-align:center",
  ].join(";");
  const heading = document.createElement("h1");
  heading.textContent = "页面初始化失败";
  heading.style.margin = "0 0 10px";
  const detail = document.createElement("p");
  detail.textContent = message;
  detail.style.margin = "0";
  fallback.append(heading, detail);
  host.replaceChildren(fallback);
}

// Theme/storage setup must not prevent React from mounting.  In particular,
// localStorage can throw while being read in privacy-restricted contexts.
try {
  applyThemePreference(readStoredThemePreference());
} catch {
  // Keep the stylesheet defaults and continue to the application mount.
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  // This is outside React's error boundary, so provide a self-contained
  // fallback instead of dereferencing null in createRoot().
  renderBootstrapFallback("找不到页面挂载节点，请刷新页面重试。");
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>,
  );
}
