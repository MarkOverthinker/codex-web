import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import { SquareTerminal, X } from "lucide-react";
import { api } from "./api.js";
import { TerminalInputQueue } from "./terminal-input.js";

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function visible(signal: AbortSignal): Promise<void> {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { document.removeEventListener("visibilitychange", changed); signal.removeEventListener("abort", abort); };
    const changed = () => { if (!document.hidden) { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(signal.reason); };
    document.addEventListener("visibilitychange", changed);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function TerminalWindow({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const window = dialog.current!;
    window.showModal();
    return () => { window.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="terminal-window" role="dialog" aria-modal="true" aria-label="任务终端" onCancel={(event) => event.preventDefault()}>
    <header className="terminal-window-header"><span title="命令以系统账户权限直接执行，不经过 Codex 审批；关闭窗口保留进程。"><SquareTerminal size={16} />终端</span><button type="button" className="icon-button" aria-label="关闭终端窗口" title="关闭窗口，保留终端会话" onClick={onClose}><X size={18} /></button></header>
    <TerminalPane conversationId={conversationId} />
  </dialog>, document.body);
}

export function TerminalPane({ conversationId }: { conversationId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("正在连接…");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  useEffect(() => {
    const lifetime = new AbortController();
    let observer: ResizeObserver | undefined;
    let instance: Terminal | undefined;
    let input: TerminalInputQueue | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let resize: (() => void) | undefined;
    let terminalId = "";
    let cursor = 0;
    let failures = 0;
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (lifetime.signal.aborted || !container.current) return;
      instance = new XTerm({ cursorBlink: true, fontSize: 14, scrollback: 5000, screenReaderMode: true, theme: { background: "#15171c", foreground: "#e5e7eb", cursor: "#d4d9e3" } });
      const fit = new FitAddon();
      instance.loadAddon(fit); instance.open(container.current);
      const dimensions = () => ({ cols: Math.max(20, Math.min(300, instance!.cols)), rows: Math.max(5, Math.min(100, instance!.rows)) });
      if (container.current.clientWidth && container.current.clientHeight) fit.fit();
      instance.onData((data) => { if (input && !input.write(data)) setWarning("输入积压过多，请等待发送完成或分段粘贴。"); });
      instance.onResize(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => resize?.(), 40); });
      observer = new ResizeObserver(() => { if (container.current?.clientWidth && container.current.clientHeight) fit.fit(); });
      observer.observe(container.current);
      while (!lifetime.signal.aborted) {
        const connection = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, connection.signal]);
        try {
          const opened = await api.terminalOpen(conversationId, dimensions(), AbortSignal.any([signal, AbortSignal.timeout(20000)]));
          signal.throwIfAborted();
          if (opened.terminalId !== terminalId) { instance.reset(); terminalId = opened.terminalId; cursor = 0; }
          input = new TerminalInputQueue((data) => api.terminalUpdate(conversationId, terminalId, { action: "write", data }, AbortSignal.any([signal, AbortSignal.timeout(15000)])), (reason) => {
            setWarning("输入发送失败，未自动重发；请核对终端中的实际执行结果。");
            connection.abort(reason);
          });
          resize = () => { void api.terminalUpdate(conversationId, terminalId, { action: "resize", ...dimensions() }, signal).catch((reason) => connection.abort(reason)); };
          resize();
          instance.options.disableStdin = false; instance.focus();
          setStatus("已连接"); setError("");
          while (!signal.aborted) {
            await visible(signal);
            const result = await api.terminalRead(conversationId, terminalId, cursor, AbortSignal.any([signal, AbortSignal.timeout(20000)]));
            signal.throwIfAborted();
            failures = 0;
            if (result.truncated) instance.reset();
            if (result.data) await new Promise<void>((resolve) => instance!.write(result.data, resolve));
            signal.throwIfAborted();
            cursor = result.cursor;
            if (result.exited && !result.data) { setStatus(`已退出（${result.exitCode ?? "未知"}），重新打开窗口可启动新终端`); return; }
          }
          signal.throwIfAborted();
        } catch (reason) {
          if (lifetime.signal.aborted) return;
          failures++;
          setError(reason instanceof Error ? reason.message : "终端连接失败");
          setStatus(failures > 3 ? "连接失败，请关闭窗口后重试" : "连接中断，正在自动重连…");
          if (failures > 3) return;
        } finally {
          input?.dispose(); input = undefined; resize = undefined; connection.abort();
          instance.options.disableStdin = true;
        }
        await delay(Math.min(250 * 2 ** (failures - 1), 2000), lifetime.signal);
      }
    })().catch((reason) => { if (!lifetime.signal.aborted) { setStatus("连接失败，请关闭窗口后重试"); setError(reason instanceof Error ? reason.message : "终端加载失败"); } });
    return () => { lifetime.abort(); input?.dispose(); clearTimeout(resizeTimer); observer?.disconnect(); instance?.dispose(); };
  }, [conversationId]);
  return <section className="terminal-pane" aria-label="终端会话" onKeyDown={(event) => event.stopPropagation()}>
    <div className="terminal-status" role="status">{status}</div>
    {(error || warning) && <p className="terminal-error" role="alert">{error || warning}</p>}
    <div ref={container} className="terminal-screen" aria-label="终端输入与输出" />
  </section>;
}
