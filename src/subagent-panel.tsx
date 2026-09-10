import { Bot, Check, CircleHelp, LoaderCircle, TriangleAlert } from "lucide-react";
import type { JobEvent } from "./api";
import { collectSubagents } from "./subagents";

const LABELS: Record<string, string> = {
  pendingInit: "等待启动", running: "运行中", completed: "已完成", interrupted: "已中断",
  errored: "出错", shutdown: "已关闭", notFound: "未找到", unknown: "状态未知", unconfirmed: "主任务已结束 · 状态未确认",
};

export function SubagentPanel({ events, active }: { events: JobEvent[]; active: boolean }) {
  const agents = collectSubagents(events, active);
  if (!agents.length) return null;
  const running = agents.filter((agent) => ["running", "pendingInit"].includes(agent.status)).length;
  const completed = agents.filter((agent) => agent.status === "completed").length;
  return <section className="subagent-panel" aria-label="子代理状态">
    <header><Bot size={16} /><strong>子代理</strong><span role="status">{agents.length} 个 · {running} 运行中 · {completed} 已完成</span></header>
    <ul>{agents.map((agent, index) => {
      const busy = ["running", "pendingInit"].includes(agent.status);
      const failed = ["errored", "interrupted", "notFound"].includes(agent.status);
      return <li key={agent.id}>
        <details><summary>
          {busy ? <LoaderCircle className="spin" size={14} /> : agent.status === "completed" ? <Check size={14} /> : failed ? <TriangleAlert size={14} /> : <CircleHelp size={14} />}
          <strong>{agent.name || `子代理 ${index + 1}`}</strong><span>{LABELS[agent.status] ?? "状态未知"}</span>
        </summary>{agent.prompt && <p>{agent.prompt}</p>}<small>线程：{agent.id}</small>{agent.detail && <p>{agent.detail}</p>}</details>
      </li>;
    })}</ul>
  </section>;
}
