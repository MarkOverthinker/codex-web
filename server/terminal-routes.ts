import type { Router } from "express";
import type { TerminalContext, TerminalCommand, TerminalResult } from "../src/terminal-protocol.js";
import { terminalCommand } from "../src/terminal-protocol.js";
import { TerminalError } from "./terminal-manager.js";

type Dependencies = {
  context(userId: string, conversationId: string, command: TerminalCommand): TerminalContext;
  exists(userId: string, conversationId: string): boolean;
  execute(context: TerminalContext, command: TerminalCommand): Promise<TerminalResult>;
  shuttingDown(): boolean;
};
export function registerTerminalRoutes(api: Router, dependencies: Dependencies): void {
  const endpoint = "/conversations/:id/terminal";
  api.all([endpoint, `${endpoint}/:terminalId`], async (req, res, next) => {
    if (!["GET", "POST", "DELETE"].includes(req.method)) return next();
    res.setHeader("Cache-Control", "no-store");
    const userId = res.locals.session.user_id as string;
    const conversationId = String(req.params.id);
    if (!dependencies.exists(userId, conversationId)) return res.status(404).json({ error: "会话不存在。" });
    if (dependencies.shuttingDown()) return res.status(503).json({ error: "服务正在重启，终端已停止。" });
    const terminalId = req.params.terminalId;
    const raw = req.method === "GET"
      ? { action: "read", terminalId, after: typeof req.query.after === "string" && /^\d+$/.test(req.query.after) ? Number(req.query.after) : NaN }
      : req.method === "DELETE" ? { action: "close", terminalId }
        : terminalId ? { ...req.body, terminalId } : { ...req.body, action: "open" };
    const parsed = terminalCommand.safeParse(raw);
    if (!parsed.success || (req.method === "POST" && terminalId && !["write", "resize"].includes(parsed.data.action))) return res.status(400).json({ error: "无效的终端参数。" });
    try {
      const context = dependencies.context(userId, conversationId, parsed.data);
      const result = await dependencies.execute(context, parsed.data);
      return res.json(result);
    } catch (error) {
      return res.status(error instanceof TerminalError ? error.status : 503).json({ error: error instanceof Error ? error.message : "终端不可用。" });
    }
  });
}
