import { z } from "zod";

export const terminalSize = z.object({ cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(100) });
export const terminalCommand = z.discriminatedUnion("action", [
  terminalSize.extend({ action: z.literal("open") }),
  z.object({ action: z.literal("close-task") }),
  z.object({ action: z.literal("read"), terminalId: z.string().uuid(), after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), waitMs: z.number().int().min(0).max(10000).optional() }),
  z.object({ action: z.literal("write"), terminalId: z.string().uuid(), data: z.string().min(1).max(8192) }),
  terminalSize.extend({ action: z.literal("resize"), terminalId: z.string().uuid() }),
  z.object({ action: z.literal("close"), terminalId: z.string().uuid() }),
]);
export type TerminalCommand = z.infer<typeof terminalCommand>;
export type TerminalSnapshot = { terminalId: string; data: string; cursor: number; truncated: boolean; exited: boolean; exitCode: number | null };
export type TerminalResult = { terminalId: string } | TerminalSnapshot | { ok: true };
export type TerminalContext = { userId: string; conversationId: string; cwd: string; home: string; uid: number; gid: number; restrictRoot?: string };
