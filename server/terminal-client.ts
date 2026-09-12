import crypto from "node:crypto";
import type { TerminalCommand, TerminalResult } from "../src/terminal-protocol.js";
import type { SupervisorToWebMessage, WebToSupervisorMessage } from "./tenant-worker-protocol.js";
import { TerminalError } from "./terminal-manager.js";

export class TerminalClient {
  private readonly pending = new Map<string, { resolve(result: TerminalResult): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor() { process.on("message", this.receive); process.on("disconnect", this.disconnect); }
  execute(userId: string, conversationId: string, command: TerminalCommand): Promise<TerminalResult> {
    if (!process.send || !process.connected) return Promise.reject(new TerminalError("租户隔离服务不可用。", 503));
    if (this.pending.size >= 128) return Promise.reject(new TerminalError("终端服务繁忙。", 429));
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new TerminalError("终端服务响应超时。", 503)); }, 15_000);
      this.pending.set(requestId, { resolve, reject, timer });
      const message: WebToSupervisorMessage = { kind: "terminal", requestId, userId, conversationId, command };
      process.send!(message, (error) => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(requestId); reject(new TerminalError("终端服务连接失败。", 503));
      });
    });
  }
  dispose(): void { process.off("message", this.receive); process.off("disconnect", this.disconnect); this.disconnect(); }
  private readonly disconnect = () => {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new TerminalError("终端服务已断开。", 503)); }
    this.pending.clear();
  };
  private readonly receive = (message: SupervisorToWebMessage) => {
    if (!message || message.kind !== "terminal_result") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(message.requestId);
    if (message.error || !message.result) pending.reject(new TerminalError(message.error ?? "终端返回空结果。", message.status ?? 503));
    else pending.resolve(message.result);
  };
}
