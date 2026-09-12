import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { terminalCommand, type TerminalCommand, type TerminalContext, type TerminalResult, type TerminalSnapshot } from "../src/terminal-protocol.js";

export class TerminalError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export class TerminalBuffer {
  private text = "";
  private cursor = 0;
  constructor(private readonly limit = 1024 * 1024) {}
  append(data: string): void { this.cursor += data.length; this.text = (this.text + data).slice(-this.limit); }
  read(after: number): Pick<TerminalSnapshot, "data" | "cursor" | "truncated"> {
    if (after > this.cursor) throw new TerminalError("无效的终端输出游标。");
    const start = this.cursor - this.text.length;
    const offset = Math.max(after, start);
    const end = Math.min(this.cursor, offset + 65536);
    return { data: this.text.slice(offset - start, end - start), cursor: end, truncated: after < start };
  }
}
type Session = {
  id: string; userId: string; conversationId: string; worker: ChildProcess;
  output: TerminalBuffer; touched: number; started: boolean; exited: boolean; exitCode: number | null; ready: Promise<void>; stopping?: Promise<void>;
};
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: NodeJS.Timeout;
  private disposed = false;
  constructor(private readonly idleMs = 30 * 60_000) {
    this.timer = setInterval(() => this.expire(), Math.min(idleMs, 60_000));
    this.timer.unref();
  }
  async execute(context: TerminalContext, rawCommand: TerminalCommand): Promise<TerminalResult> {
    if (this.disposed) throw new TerminalError("终端服务已停止。", 503);
    const parsed = terminalCommand.safeParse(rawCommand);
    if (!parsed.success) throw new TerminalError("无效的终端参数。");
    const command = parsed.data;
    this.expire();
    if (command.action === "open") return this.open(context, command);
    if (command.action === "close-task") {
      await Promise.all([...this.sessions.values()].filter((session) => session.userId === context.userId && session.conversationId === context.conversationId).map((session) => this.remove(session)));
      return { ok: true };
    }
    const session = this.sessions.get(command.terminalId);
    if (!session || session.userId !== context.userId || session.conversationId !== context.conversationId) throw new TerminalError("终端已关闭或不存在。", 404);
    session.touched = Date.now();
    if (command.action === "read") return { terminalId: session.id, ...session.output.read(command.after), exited: session.exited, exitCode: session.exitCode };
    if (command.action === "close") { await this.remove(session); return { ok: true }; }
    if (session.exited || !session.worker.stdin?.writable) throw new TerminalError("终端进程已退出。", 409);
    if (session.worker.stdin.writableLength > 65536) throw new TerminalError("终端输入过快，请稍后重试。", 429);
    session.worker.stdin.write(`${JSON.stringify(command)}\n`);
    return { ok: true };
  }
  dispose(): void { this.disposed = true; clearInterval(this.timer); for (const session of this.sessions.values()) this.remove(session); }
  private expire(): void { for (const session of this.sessions.values()) if (session.started && Date.now() - session.touched > this.idleMs) this.remove(session); }
  private remove(session: Session): Promise<void> {
    this.sessions.delete(session.id);
    if (session.stopping) return session.stopping;
    if (!session.worker.pid || session.worker.exitCode !== null || session.worker.signalCode !== null) return Promise.resolve();
    session.stopping = new Promise((resolve) => {
      const timer = setTimeout(() => session.worker.kill("SIGKILL"), 2000);
      timer.unref();
      session.worker.once("exit", () => { clearTimeout(timer); resolve(); });
      session.worker.kill("SIGTERM");
    });
    return session.stopping;
  }
  private async open(context: TerminalContext, size: { cols: number; rows: number }): Promise<{ terminalId: string }> {
    if (process.platform !== "linux" || !Number.isInteger(context.uid) || context.uid <= 0 || !Number.isInteger(context.gid) || context.gid <= 0) throw new TerminalError("终端需要 Linux 非 root 用户隔离环境。", 503);
    const existing = [...this.sessions.values()].find((session) => session.userId === context.userId && session.conversationId === context.conversationId && !session.exited);
    if (existing) { existing.touched = Date.now(); await existing.ready; return { terminalId: existing.id }; }
    for (const session of this.sessions.values()) if (session.userId === context.userId && session.conversationId === context.conversationId) this.remove(session);
    if ([...this.sessions.values()].filter((session) => session.userId === context.userId).length >= 3 || this.sessions.size >= 64) throw new TerminalError("终端数量达到上限，请先关闭其他终端。", 429);
    const sourceMode = import.meta.url.endsWith(".ts");
    const workerPath = fileURLToPath(new URL(sourceMode ? "./terminal-worker.ts" : "./terminal-worker.js", import.meta.url));
    const worker = spawn(process.execPath, [...(sourceMode ? ["--import", "tsx"] : []), workerPath], {
      uid: context.uid, gid: context.gid, stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: context.home, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", SHELL: "/bin/bash" },
    });
    const session: Session = { id: crypto.randomUUID(), userId: context.userId, conversationId: context.conversationId, worker, output: new TerminalBuffer(), touched: Date.now(), started: false, exited: false, exitCode: null, ready: Promise.resolve() };
    this.sessions.set(session.id, session);
    session.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new TerminalError("终端启动超时。", 503)); this.remove(session); }, 10_000);
      const output = readline.createInterface({ input: worker.stdout!, crlfDelay: Infinity });
      worker.stderr?.resume();
      worker.stdin?.on("error", () => {});
      output.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === "ready") { clearTimeout(timer); session.started = true; session.touched = Date.now(); resolve(); }
          if (event.type === "data" && typeof event.data === "string") session.output.append(event.data);
          if (event.type === "exit") { session.exited = true; session.exitCode = event.exitCode; }
          if (event.type === "error") { clearTimeout(timer); reject(new TerminalError(String(event.error), 503)); this.remove(session); }
        } catch {}
      });
      worker.once("error", () => { clearTimeout(timer); reject(new TerminalError("无法以目标用户启动终端。", 503)); this.remove(session); });
      worker.once("exit", (code) => { clearTimeout(timer); session.exited = true; session.exitCode ??= code; output.close(); reject(new TerminalError("终端启动失败。", 503)); });
      worker.stdin!.write(`${JSON.stringify({ ...context, cols: size.cols, rows: size.rows, action: "start" })}\n`);
    });
    try { await session.ready; return { terminalId: session.id }; }
    catch (error) { this.remove(session); throw error; }
  }
}
