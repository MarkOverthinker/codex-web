import type { JobEvent } from "./api";

export type Subagent = { id: string; name?: string; prompt?: string; status: string; detail?: string };

export function collectSubagents(events: JobEvent[], active: boolean): Subagent[] {
  const agents = new Map<string, Subagent>();
  for (const event of events) {
    if (event.kind !== "subagent") continue;
    const ids = new Set([...(event.agentThreadIds ?? []), ...Object.keys(event.agentStates ?? {}), ...(event.agentThreadId ? [event.agentThreadId] : [])]);
    for (const id of ids) {
      const agent = agents.get(id) ?? { id, status: "unknown" };
      const explicit = event.agentStates?.[id];
      if (explicit) agent.status = explicit;
      else if (event.subagentActivity) {
        const activity = event.subagentActivity;
        if (["started", "interacted"].includes(activity)) agent.status = "running";
        else if (["completed", "interrupted", "errored", "shutdown"].includes(activity)) agent.status = activity;
      } else if (event.subagentStatus === "completed") {
        if (["spawnAgent", "resumeAgent", "sendInput", "followupTask"].includes(event.subagentTool ?? "")) agent.status = "running";
        if (event.subagentTool === "closeAgent") agent.status = "shutdown";
        if (event.subagentTool === "interruptAgent") agent.status = "interrupted";
      } else if (event.subagentTool === "spawnAgent" && event.subagentStatus === "inProgress") agent.status = "pendingInit";
      if (event.agentPath) agent.name = event.agentPath;
      if (event.agentPrompt) agent.prompt = event.agentPrompt;
      if (event.detail) agent.detail = event.detail;
      agents.set(id, agent);
    }
  }
  return [...agents.values()].map((agent) => !active && ["running", "pendingInit"].includes(agent.status)
    ? { ...agent, status: "unconfirmed" } : agent);
}
