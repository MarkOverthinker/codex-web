import { api } from "./api";

const REPORT_DEDUPE_MS = 5 * 60_000;
const MAX_REPORT_MESSAGE_LENGTH = 2000;
const MAX_REPORT_STACK_LENGTH = 8000;
// React reports this notice through `reportError` after it successfully
// recovers from a concurrent render error by re-rendering synchronously.
// It is not an application failure, so it must not pollute error reporting.
const REACT_RECOVERY_NOTICE = /There was an error during concurrent rendering but React was able to recover|Minified React error #520/;

type ClientErrorReport = {
  message: string;
  stack?: string;
  source: string;
  href: string;
};

let lastReportKey = "";
let lastReportAt = 0;

function reportError(error: unknown, source: string): void {
  const normalized = error instanceof Error ? error : new Error(
    typeof error === "string" ? error : (() => {
      try { return JSON.stringify(error); } catch { return String(error); }
    })(),
  );
  if (REACT_RECOVERY_NOTICE.test(normalized.message) || (normalized.stack ?? "").includes("#520")) return;
  const stack = normalized.stack ?? "";
  const key = `${source}\u0000${normalized.message}\u0000${stack}`;
  const now = Date.now();
  if (key === lastReportKey && now - lastReportAt < REPORT_DEDUPE_MS) return;
  lastReportKey = key;
  lastReportAt = now;

  const report: ClientErrorReport = {
    message: normalized.message.slice(0, MAX_REPORT_MESSAGE_LENGTH),
    stack: stack.slice(0, MAX_REPORT_STACK_LENGTH),
    source,
    href: window.location.href,
  };
  // Fire-and-forget; a failed report must never affect the running app.
  void api.reportClientError(report).catch(() => undefined);
}

/** Captures otherwise-unhandled browser errors so crashes can be diagnosed. */
export function installClientErrorReporting(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (event) => {
    reportError(event.error ?? event.message, "window-error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportError(event.reason, "unhandled-rejection");
  });
}

/** Reports a render error captured by the error boundary. */
export function reportBoundaryError(error: Error): void {
  reportError(error, "error-boundary");
}
