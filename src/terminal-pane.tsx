import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { api } from "./api.js";

export function TerminalPane({ conversationId, active }: { conversationId: string; active: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const terminalId = useRef<string | null>(null);
  const activeRef = useRef(active);
  const sendInput = useRef<(data: string) => void>(() => {});
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("未连接");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => {
    if (!attempt || !container.current) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | undefined;
    let instance: Terminal | undefined;
    let writable = false;
    let queue = Promise.resolve();
    let input = "";
    let cursor = 0;
    const controller = new AbortController();
    terminalId.current = null;
    setReady(false); setError(""); setStatus("正在连接…");
    const fail = (reason: unknown) => {
      if (disposed) return;
      writable = false; setReady(false); setStatus("连接中断");
      setError(reason instanceof Error ? reason.message : "终端连接失败");
    };
    const enqueue = (command: { action: "write"; data: string } | { action: "resize"; cols: number; rows: number }) => {
      queue = queue.then(async () => {
        if (disposed || !writable || !terminalId.current) return;
        await api.terminalUpdate(conversationId, terminalId.current, command, controller.signal);
      }).catch(fail);
    };
    const flush = () => {
      inputTimer = undefined;
      while (input) { const chunk = input.slice(0, 4096); input = input.slice(4096); enqueue({ action: "write", data: chunk }); }
    };
    const write = (data: string) => {
      if (!writable || disposed) return;
      if (input.length + data.length > 32768) { setError("单次粘贴内容过长，请分段输入。"); return; }
      input += data;
      inputTimer ??= setTimeout(flush, 20);
    };
    sendInput.current = write;
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !container.current) return;
      instance = new XTerm({ cursorBlink: true, fontSize: 13, scrollback: 5000, screenReaderMode: true, theme: { background: "#15171c", foreground: "#e5e7eb", cursor: "#d4d9e3" } });
      const fit = new FitAddon();
      instance.loadAddon(fit); instance.open(container.current); terminal.current = instance;
      const dimensions = () => ({ cols: Math.max(20, Math.min(300, instance!.cols)), rows: Math.max(5, Math.min(100, instance!.rows)) });
      if (container.current.clientWidth && container.current.clientHeight) fit.fit();
      const opened = await api.terminalOpen(conversationId, dimensions());
      if (disposed) return;
      terminalId.current = opened.terminalId; writable = true; setReady(true); setStatus("已连接");
      instance.onData(write);
      instance.onResize(() => { if (writable) enqueue({ action: "resize", ...dimensions() }); });
      enqueue({ action: "resize", ...dimensions() });
      observer = new ResizeObserver(() => { if (container.current?.clientWidth && container.current.clientHeight) fit.fit(); });
      observer.observe(container.current!);
      if (activeRef.current) instance.focus();
      const poll = async () => {
        if (disposed) return;
        if (!activeRef.current || document.hidden) { timer = setTimeout(() => void poll(), 1000); return; }
        try {
          const result = await api.terminalRead(conversationId, opened.terminalId, cursor, controller.signal);
          if (disposed) return;
          if (result.truncated) instance!.reset();
          if (result.data) await new Promise<void>((resolve) => instance!.write(result.data, resolve));
          if (disposed) return;
          cursor = result.cursor;
          if (result.exited && !result.data) { writable = false; setReady(false); setStatus(`已退出（${result.exitCode ?? "未知"}）`); return; }
          timer = setTimeout(() => void poll(), result.data ? 100 : 1000);
        } catch (reason) { fail(reason); }
      };
      void poll();
    })().catch(fail);
    return () => {
      disposed = true; writable = false; controller.abort(); clearTimeout(timer); clearTimeout(inputTimer);
      observer?.disconnect(); instance?.dispose(); terminal.current = null; sendInput.current = () => {};
    };
  }, [conversationId, attempt]);
  const close = async () => {
    if (!terminalId.current || closing) return;
    setClosing(true);
    try {
      await api.terminalClose(conversationId, terminalId.current);
      terminalId.current = null; setAttempt(0); setReady(false); setError(""); setStatus("已关闭");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "关闭失败"); }
    finally { setClosing(false); }
  };
  return <section className="terminal-pane" aria-label="任务终端" onKeyDown={(event) => event.stopPropagation()}>
    <div className="terminal-toolbar"><span role="status">{status}</span><div>
      {!ready && <button type="button" disabled={closing || status === "正在连接…"} onClick={() => setAttempt((value) => value + 1)}>{attempt ? "重新连接" : "启动终端"}</button>}
      <button type="button" disabled={!ready || closing} onClick={() => { sendInput.current("\u0003"); terminal.current?.focus(); }}>Ctrl+C</button>
      <button type="button" disabled={!ready || closing} onClick={() => { sendInput.current("\t"); terminal.current?.focus(); }}>Tab</button>
      <button type="button" disabled={!attempt} onClick={() => terminal.current?.clear()}>清屏</button>
      <button type="button" disabled={!terminalId.current || closing} onClick={() => void close()}>{closing ? "正在关闭…" : "关闭终端"}</button>
    </div></div>
    <p className="terminal-notice">命令直接使用系统账户权限执行，不经过 Codex 审批。收起面板不会停止进程；30 分钟无连接后回收，服务重启不保留。</p>
    {error && <p className="terminal-error" role="alert">{error}</p>}
    <div ref={container} className="terminal-screen" aria-label="终端输入与输出" />
  </section>;
}
