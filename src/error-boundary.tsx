import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportBoundaryError } from "./client-errors";

type ErrorBoundaryState = {
  error: Error | null;
  componentStack: string;
};

/**
 * Catches render/lifecycle errors so a single bad render cannot unmount the
 * whole app into a blank page. The fallback stays fully self-contained with
 * inline styles because the app's CSS may itself be in an inconsistent state.
 * Recovery actions are explicit so a deterministic render failure cannot
 * repeatedly unmount and remount the application or trigger a reload loop.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? "" });
    reportBoundaryError(error, info.componentStack ?? undefined);
  }

  private readonly retry = (): void => {
    this.setState({ error: null, componentStack: "" });
  };

  private readonly reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const { error, componentStack } = this.state;
    return (
      <div
        role="alert"
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          background: "#f7f8f6",
          color: "#1c1e26",
          boxSizing: "border-box",
        }}
      >
        <div style={{ maxWidth: 640, width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span style={{
              display: "inline-flex",
              width: 34,
              height: 34,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              background: "#d64545",
              color: "#fff",
              fontWeight: 700,
              fontSize: 16,
            }}>!</span>
            <h1 style={{ margin: 0, fontSize: 22 }}>页面遇到问题</h1>
          </div>
          <p style={{ margin: "0 0 14px", lineHeight: 1.6 }}>
            界面渲染时发生异常，任务与消息数据不会丢失。请刷新页面恢复；
            如果问题反复出现，可保留此页面并查看下方的错误详情。
          </p>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <button
              type="button"
              onClick={this.reload}
              style={{
                padding: "9px 18px",
                border: 0,
                borderRadius: 8,
                background: "#4b5794",
                color: "#fff",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              刷新页面
            </button>
            <button
              type="button"
              onClick={this.retry}
              style={{
                padding: "9px 18px",
                border: "1px solid #c4c8d4",
                borderRadius: 8,
                background: "#fff",
                color: "#1c1e26",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              重新渲染
            </button>
          </div>
          <details style={{ border: "1px solid #d8dbe4", borderRadius: 8, background: "#fff", padding: "8px 12px" }}>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "#4a4f63" }}>错误详情（用于排查）</summary>
            <pre style={{
              margin: "10px 0 0",
              padding: 10,
              maxHeight: 220,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#f2f3f7",
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.5,
            }}>{error.message}
{error.stack}
{componentStack}</pre>
          </details>
        </div>
      </div>
    );
  }
}
