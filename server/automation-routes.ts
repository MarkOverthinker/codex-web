import type { Router, RequestHandler } from "express";
import { AutomationError, type Automations } from "./automations.js";

export function registerAutomationRoutes(api: Router, automations: Automations): void {
  const route = (handler: RequestHandler): RequestHandler => (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try { return handler(req, res, next); }
    catch (error) {
      if (error instanceof AutomationError) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };
  api.get("/automations", route((_req, res) => res.json({ automations: automations.list(res.locals.session.user_id) })));
  api.post("/automations", route((req, res) => res.status(201).json({ automation: automations.save(res.locals.session.user_id, req.body) })));
  api.put("/automations/:id", route((req, res) => res.json({ automation: automations.save(res.locals.session.user_id, req.body, String(req.params.id)) })));
  api.patch("/automations/:id", route((req, res) => {
    if (typeof req.body?.enabled !== "boolean" || Object.keys(req.body).length !== 1) throw new AutomationError("请指定是否启用任务。");
    return res.json({ automation: automations.setEnabled(res.locals.session.user_id, String(req.params.id), req.body.enabled) });
  }));
  api.delete("/automations/:id", route((req, res) => {
    automations.remove(res.locals.session.user_id, String(req.params.id));
    return res.status(204).end();
  }));
  api.post("/automations/:id/run", route((req, res) => res.status(202).json({ runId: automations.run(res.locals.session.user_id, String(req.params.id)) })));
  api.get("/automation-runs", route((req, res) => {
    if (Object.keys(req.query).some((key) => key !== "automationId" && key !== "offset")) throw new AutomationError("运行记录查询参数无效。");
    if (req.query.automationId !== undefined && typeof req.query.automationId !== "string") throw new AutomationError("任务编号无效。");
    const offset = req.query.offset === undefined ? 0 : typeof req.query.offset === "string" && /^\d+$/.test(req.query.offset) ? Number(req.query.offset) : NaN;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AutomationError("分页参数无效。");
    return res.json({ runs: automations.runs(res.locals.session.user_id, req.query.automationId, offset) });
  }));
}
