import crypto from "node:crypto";
import { z } from "zod";
import type { Automation, AutomationInput, AutomationRun } from "../src/automation-types.js";
import type { AppDatabase } from "./db.js";
import type { AgentSelection } from "./model-options.js";

export const automationInput = z.object({
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(100_000),
  workingDir: z.string().trim().min(1).max(4096).nullable(),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().trim().min(1).max(80).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
  }, "时区无效，请使用 IANA 时区名称。"),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.string().trim().min(1).max(20),
  sandbox: z.enum(["workspace-write", "danger-full-access"]),
  enabled: z.boolean(),
}).strict();

function clock(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}

function localParts(formatter: Intl.DateTimeFormat, date: Date): { day: string; time: string } {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function nextDailyRun(after: Date, time: string, timeZone: string, excludeDay?: string): string {
  const formatter = clock(timeZone);
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset < 3 * 24 * 60; offset++) {
    const candidate = new Date(start + offset * 60_000);
    const parts = localParts(formatter, candidate);
    if (parts.time === time && parts.day !== excludeDay) return candidate.toISOString();
  }
  throw new Error("无法计算下一次运行时间。");
}

type StoredAutomation = {
  id: string; user_id: string; config: string; enabled: number; next_run_at: string; created_at: string; updated_at: string;
};
type StoredRun = {
  id: string; automation_id: string; name: string; trigger: "scheduled" | "manual"; scheduled_at: string; created_at: string;
  conversation_id: string | null; job_id: string | null; status: string; error: string | null; snapshot: string;
};
type Dependencies = {
  validate(userId: string, input: AutomationInput): { input: AutomationInput; selection: AgentSelection };
  prepare(userId: string): void;
  blocked(): boolean;
  dispatch(): void;
  onError(error: unknown): void;
};

export class AutomationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export class Automations {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly db: AppDatabase, private readonly dependencies: Dependencies) {
    db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), config TEXT NOT NULL,
        enabled INTEGER NOT NULL, next_run_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS automations_due ON automations(enabled,next_run_at) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS automations_user ON automations(user_id,created_at);
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id), slot TEXT NOT NULL,
        name TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_at TEXT NOT NULL, created_at TEXT NOT NULL,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        status TEXT NOT NULL, error TEXT, snapshot TEXT NOT NULL,
        UNIQUE(automation_id,slot)
      );
      CREATE INDEX IF NOT EXISTS automation_runs_task ON automation_runs(automation_id,created_at);
    `);
  }

  private row(userId: string, id: string): StoredAutomation | undefined {
    return this.db.sqlite.prepare("SELECT * FROM automations WHERE id=? AND user_id=? AND deleted_at IS NULL").get(id, userId) as StoredAutomation | undefined;
  }

  private present(row: StoredAutomation): Automation {
    return { ...JSON.parse(row.config) as AutomationInput, enabled: Boolean(row.enabled), id: row.id,
      nextRunAt: row.next_run_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  get(userId: string, id: string): Automation {
    const row = this.row(userId, id);
    if (!row) throw new AutomationError("自动任务不存在。", 404);
    return this.present(row);
  }

  list(userId: string): Automation[] {
    return (this.db.sqlite.prepare("SELECT * FROM automations WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC")
      .all(userId) as StoredAutomation[]).map((row) => this.present(row));
  }

  save(userId: string, raw: unknown, id?: string, now = new Date()): Automation {
    const previous = id ? this.get(userId, id) : undefined;
    const parsed = automationInput.safeParse(raw);
    if (!parsed.success) throw new AutomationError(`自动任务参数无效：${parsed.error.issues[0]?.message ?? "请检查输入。"}`);
    const { input } = this.dependencies.validate(userId, parsed.data);
    const next = previous && previous.time === input.time && previous.timeZone === input.timeZone && previous.enabled === input.enabled
      ? previous.nextRunAt : nextDailyRun(now, input.time, input.timeZone);
    const taskId = id ?? crypto.randomUUID();
    if (previous) {
      this.db.sqlite.prepare("UPDATE automations SET config=?,enabled=?,next_run_at=?,updated_at=? WHERE id=? AND user_id=?")
        .run(JSON.stringify(input), Number(input.enabled), next, now.toISOString(), taskId, userId);
    } else {
      this.db.sqlite.prepare("INSERT INTO automations(id,user_id,config,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(taskId, userId, JSON.stringify(input), Number(input.enabled), next, now.toISOString(), now.toISOString());
    }
    return this.get(userId, taskId);
  }

  setEnabled(userId: string, id: string, enabled: boolean, now = new Date()): Automation {
    const task = this.get(userId, id);
    const next = enabled && !task.enabled ? nextDailyRun(now, task.time, task.timeZone) : task.nextRunAt;
    this.db.sqlite.prepare("UPDATE automations SET enabled=?,next_run_at=?,updated_at=? WHERE id=? AND user_id=?")
      .run(Number(enabled), next, now.toISOString(), id, userId);
    return this.get(userId, id);
  }

  remove(userId: string, id: string): void {
    this.get(userId, id);
    this.db.sqlite.prepare("UPDATE automations SET enabled=0,deleted_at=? WHERE id=? AND user_id=?").run(new Date().toISOString(), id, userId);
  }

  runs(userId: string, automationId?: string, offset = 0): AutomationRun[] {
    const rows = this.db.sqlite.prepare(`
      SELECT run.*, CASE WHEN conversation.deleted_at IS NULL THEN run.conversation_id ELSE NULL END AS conversation_id,
        COALESCE(job.status, CASE WHEN run.status='queued' THEN 'unavailable' ELSE run.status END) AS status,
        COALESCE(run.error,job.error) AS error
      FROM automation_runs run JOIN automations task ON task.id=run.automation_id
      LEFT JOIN conversations conversation ON conversation.id=run.conversation_id
      LEFT JOIN jobs job ON job.id=run.job_id
      WHERE task.user_id=? AND (? IS NULL OR task.id=?)
      ORDER BY run.created_at DESC,run.rowid DESC LIMIT 50 OFFSET ?
    `).all(userId, automationId ?? null, automationId ?? null, offset) as StoredRun[];
    return rows.map((row) => ({ id: row.id, automationId: row.automation_id, name: row.name, trigger: row.trigger,
      scheduledAt: row.scheduled_at, createdAt: row.created_at, conversationId: row.conversation_id, jobId: row.job_id,
      status: row.status, error: row.error, snapshot: JSON.parse(row.snapshot) as AutomationInput }));
  }

  run(userId: string, id: string, trigger: "manual" | "scheduled" = "manual", now = new Date()): string | null {
    if (this.dependencies.blocked()) throw new AutomationError("服务正在维护或停止，请稍后再运行。", 503);
    const sqlite = this.db.sqlite;
    let runId: string | null = null;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const task = this.get(userId, id);
      if (this.db.getUser(userId)?.status !== "active") throw new AutomationError("用户已停用。", 403);
      if (trigger === "scheduled" && (!task.enabled || task.nextRunAt > now.toISOString())) {
        sqlite.exec("COMMIT");
        return null;
      }
      const scheduledAt = trigger === "scheduled" ? task.nextRunAt : now.toISOString();
      const day = localParts(clock(task.timeZone), new Date(scheduledAt)).day;
      const slot = trigger === "scheduled" ? day : crypto.randomUUID();
      if (trigger === "scheduled") {
        const next = nextDailyRun(now, task.time, task.timeZone, day);
        sqlite.prepare("UPDATE automations SET next_run_at=? WHERE id=?").run(next, id);
      }
      const duplicate = sqlite.prepare("SELECT id FROM automation_runs WHERE automation_id=? AND slot=?").get(id, slot);
      if (duplicate) { sqlite.exec("COMMIT"); return null; }
      runId = crypto.randomUUID();
      let status = "queued";
      let error: string | null = null;
      let conversationId: string | null = null;
      let jobId: string | null = null;
      const active = sqlite.prepare(`SELECT 1 FROM automation_runs run JOIN jobs job ON job.id=run.job_id
        WHERE run.automation_id=? AND job.status IN ('queued','running') LIMIT 1`).get(id);
      if (active) {
        status = "skipped";
        error = "上一次运行仍在排队或执行，本次已跳过。";
      } else {
        sqlite.exec("SAVEPOINT automation_execution");
        try {
          this.dependencies.prepare(userId);
          const { input, selection } = this.dependencies.validate(userId, task);
          conversationId = crypto.randomUUID();
          jobId = crypto.randomUUID();
          const messageId = crypto.randomUUID();
          this.db.createConversation(conversationId, `${input.name} · ${day}`, selection, userId, input.workingDir);
          this.db.updateConversation(conversationId, { title: `${input.name} · ${day}`, titleSource: "manual" });
          this.db.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: input.prompt, created_at: now.toISOString() });
          this.db.createJob(jobId, conversationId, messageId, selection);
          sqlite.exec("RELEASE automation_execution");
        } catch (failure) {
          sqlite.exec("ROLLBACK TO automation_execution; RELEASE automation_execution");
          conversationId = null;
          jobId = null;
          status = "failed";
          error = failure instanceof Error ? failure.message : "自动任务创建失败。";
        }
      }
      const { id: _id, nextRunAt: _next, createdAt: _created, updatedAt: _updated, ...snapshot } = task;
      sqlite.prepare(`INSERT INTO automation_runs(id,automation_id,slot,name,trigger,scheduled_at,created_at,conversation_id,job_id,status,error,snapshot)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, id, slot, task.name, trigger, scheduledAt, now.toISOString(), conversationId, jobId, status, error, JSON.stringify(snapshot));
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
    this.dependencies.dispatch();
    return runId;
  }

  tick(now = new Date()): void {
    if (this.dependencies.blocked()) return;
    const due = this.db.sqlite.prepare(`SELECT task.* FROM automations task JOIN users ON users.id=task.user_id
      WHERE task.enabled=1 AND task.deleted_at IS NULL AND task.next_run_at<=? AND users.status='active'
      ORDER BY task.next_run_at LIMIT 100`).all(now.toISOString()) as StoredAutomation[];
    for (const task of due) {
      try { this.run(task.user_id, task.id, "scheduled", now); }
      catch (error) { this.dependencies.onError(error); }
    }
  }

  start(): void {
    if (this.timer) return;
    const tick = () => { try { this.tick(); } catch (error) { this.dependencies.onError(error); } };
    this.timer = setInterval(tick, 15_000);
    this.timer.unref();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
