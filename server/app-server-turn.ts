import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import readline from "node:readline";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { describeUpstreamError, isRetryableUpstreamError } from "./retry-policy.js";
import { buildOptionalCapabilityConfig, type OptionalAgentCapabilities } from "./optional-capabilities.js";
import { buildReasoningSteps } from "./reasoning-parts.js";
import type { SandboxMode } from "./model-options.js";

type JsonObject = Record<string, unknown>;

export type RuntimeModelProvider = {
  id: string;
  name: string;
  baseUrl: string;
  envKey: string;
};

type AppServerCallbacks = {
  signal: AbortSignal;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
};

export type AppServerTurnOptions = {
  executablePath?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  threadId: string | null;
  prompt: string;
  imagePaths: string[];
  outputSchema?: Record<string, unknown>;
  model: string;
  reasoningEffort: string;
  modelProvider?: string | null;
  runtimeModelProvider?: RuntimeModelProvider;
  sandboxMode: SandboxMode;
  library: string;
  shellEnvironment: Record<string, string>;
  networkAccessEnabled: boolean;
  webSearchMode: "cached" | "live";
  runtimeWorkspaceRoots?: string[];
  optionalCapabilities: OptionalAgentCapabilities;
  uid?: number;
  gid?: number;
};

export type AppServerTurnExecution = {
  result: Promise<string>;
  steer(prompt: string, imagePaths?: string[]): Promise<string>;
  interrupt(): void;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type RpcId = string | number;
type RpcResponse = { id: number; result?: unknown; error?: { message?: string; data?: unknown } };
type RpcServerRequest = { id: RpcId; method: string; params?: JsonObject };
type RpcNotification = { method: string; params?: JsonObject };

const APPROVAL_POLICY = "on-request";
const APPROVALS_REVIEWER = "auto_review";
const APPROVAL_REJECTION = "自动审核未接管此请求，Codex Web 已按安全默认值拒绝。";

let setprivProbeResult: boolean | undefined;

/**
 * setpriv from util-linux is required to rebuild a task user's supplementary
 * groups after dropping privileges (spawn's uid/gid options never call
 * initgroups()). Probe once per process and fall back to the old behavior on
 * systems without it.
 */
function setprivAvailable(): boolean {
  if (setprivProbeResult === undefined) {
    try {
      execFileSync("setpriv", ["--help"], { stdio: "ignore", timeout: 5_000 });
      setprivProbeResult = true;
    } catch {
      setprivProbeResult = false;
    }
  }
  return setprivProbeResult;
}

class AppServerTurnClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private finalResponse = "";
  private terminal = false;
  private reconnectNotices = 0;
  private reconnectWarningSent = false;
  private stderr = "";
  private readonly completion: Promise<string>;
  private resolveCompletion!: (value: string) => void;
  private rejectCompletion!: (error: Error) => void;

  constructor(private readonly options: AppServerTurnOptions, private readonly callbacks: AppServerCallbacks) {
    this.completion = new Promise<string>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    const dropPrivileges = options.uid !== undefined && options.gid !== undefined && process.getuid?.() === 0;
    const executablePath = options.executablePath || process.env.CODEX_RUNTIME_PATH || "codex";
    const appServerArgs = [
      "app-server",
      "--listen", "stdio://",
      "-c", `approval_policy="${APPROVAL_POLICY}"`,
      "-c", `approvals_reviewer="${APPROVALS_REVIEWER}"`,
      "-c", `sandbox_mode="${options.sandboxMode}"`,
    ];
    if (options.runtimeModelProvider) {
      const provider = options.runtimeModelProvider;
      if (provider.id !== options.modelProvider || !/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(provider.id)) {
        throw new Error("Invalid runtime model provider");
      }
      appServerArgs.push(
        "-c", `model_providers.${provider.id}.name=${JSON.stringify(provider.name)}`,
        "-c", `model_providers.${provider.id}.base_url=${JSON.stringify(provider.baseUrl)}`,
        "-c", `model_providers.${provider.id}.wire_api="responses"`,
        "-c", `model_providers.${provider.id}.env_key=${JSON.stringify(provider.envKey)}`,
        "-c", `model_providers.${provider.id}.requires_openai_auth=false`,
        "-c", `model_providers.${provider.id}.supports_websockets=false`,
      );
    }
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    };
    let command = executablePath;
    let args = appServerArgs;
    if (dropPrivileges) {
      if (setprivAvailable()) {
        // setpriv --init-groups rebuilds the user's supplementary groups from
        // /etc/group (it resolves the user from --reuid); spawn's uid/gid
        // options only set the primary uid/gid and inherit an empty group set.
        command = "setpriv";
        args = [
          "--reuid", String(options.uid),
          "--regid", String(options.gid),
          "--init-groups",
          "--",
          executablePath,
          ...appServerArgs,
        ];
      } else {
        spawnOptions.uid = options.uid;
        spawnOptions.gid = options.gid;
      }
    }
    this.child = spawn(command, args, spawnOptions);
    const output = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    output.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      output.close();
      if (!this.terminal) this.fail(new Error(this.stderr.trim() || `Codex app server exited before completion (${signal ?? code ?? "unknown"})`));
      for (const request of this.pending.values()) request.reject(new Error("Codex app server disconnected"));
      this.pending.clear();
    });
    callbacks.signal.addEventListener("abort", () => this.interrupt(), { once: true });
  }

  run(): Promise<string> {
    void this.start();
    return this.completion.finally(() => this.dispose());
  }

  async steer(prompt: string, imagePaths: string[] = []): Promise<string> {
    if (this.terminal || !this.threadId || !this.activeTurnId) throw new Error("当前任务已结束，无法引导");
    const result = await this.request("turn/steer", {
      threadId: this.threadId,
      input: makeUserInput(prompt, imagePaths),
      expectedTurnId: this.activeTurnId,
    }) as { turnId?: string };
    if (!result?.turnId) throw new Error("引导未被正在运行的任务接受");
    this.activeTurnId = result.turnId;
    return result.turnId;
  }

  interrupt(): void {
    if (this.terminal) return;
    const threadId = this.threadId;
    const turnId = this.activeTurnId;
    if (threadId && turnId && this.child.stdin.writable) {
      void this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    }
  }

  private async start(): Promise<void> {
    try {
      await this.request("initialize", {
        clientInfo: { name: "codex-web", title: "Codex Web", version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notify("initialized");
      const runtimeWorkspaceRoots = [...new Set(this.options.runtimeWorkspaceRoots ?? [this.options.cwd, this.options.library])];
      const common = {
        model: this.options.model,
        ...(this.options.modelProvider ? { modelProvider: this.options.modelProvider } : {}),
        cwd: this.options.cwd,
        runtimeWorkspaceRoots,
        approvalPolicy: APPROVAL_POLICY,
        approvalsReviewer: APPROVALS_REVIEWER,
        sandbox: this.options.sandboxMode,
        config: {
          ...(this.options.sandboxMode === "workspace-write" ? {
            sandbox_workspace_write: {
              writable_roots: runtimeWorkspaceRoots,
              network_access: this.options.networkAccessEnabled,
            },
          } : {}),
          shell_environment_policy: { inherit: "core", set: this.options.shellEnvironment },
          model_reasoning_summary: "auto",
          hide_agent_reasoning: false,
          show_raw_agent_reasoning: true,
          web_search: this.options.webSearchMode,
          ...buildOptionalCapabilityConfig(this.options.optionalCapabilities),
        },
      };
      const threadResult = this.options.threadId
        ? await this.request("thread/resume", { threadId: this.options.threadId, ...common, excludeTurns: true })
        : await this.request("thread/start", common);
      const thread = (threadResult as { thread?: { id?: string } })?.thread;
      if (!thread?.id) throw new Error("Codex app server did not return a thread id");
      this.threadId = thread.id;
      this.callbacks.onThreadStarted(thread.id);
      const turnResult = await this.request("turn/start", {
        threadId: thread.id,
        input: makeUserInput(this.options.prompt, this.options.imagePaths),
        model: this.options.model,
        effort: this.options.reasoningEffort,
        approvalPolicy: APPROVAL_POLICY,
        approvalsReviewer: APPROVALS_REVIEWER,
        ...(this.options.outputSchema ? { outputSchema: this.options.outputSchema } : {}),
      }) as { turn?: { id?: string } };
      if (!turnResult?.turn?.id) throw new Error("Codex app server did not return a turn id");
      this.activeTurnId = turnResult.turn.id;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (!this.child.stdin.writable) return Promise.reject(new Error("Codex app server is unavailable"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcResponse | RpcServerRequest | RpcNotification;
    try { message = JSON.parse(line) as RpcResponse | RpcServerRequest | RpcNotification; }
    catch { return; }
    if ("method" in message && "id" in message) {
      this.handleServerRequest(message);
      return;
    }
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex app server request failed"));
      else pending.resolve(message.result);
      return;
    }
    this.handleNotification(message);
  }

  private handleServerRequest(message: RpcServerRequest): void {
    const params = message.params ?? {};
    const progress = summarizeUnhandledApprovalRequest(message.method, message.id, params);
    if (progress) this.callbacks.onProgress(progress);
    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
      this.respond(message.id, { decision: "decline" });
      return;
    }
    if (message.method === "item/permissions/requestApproval") {
      this.respond(message.id, { permissions: {}, scope: "turn" });
      return;
    }
    if (message.method === "execCommandApproval" || message.method === "applyPatchApproval") {
      this.respond(message.id, { decision: { denied: { rejection: APPROVAL_REJECTION } } });
      return;
    }
    this.respondError(message.id, -32601, `Unsupported app-server request: ${message.method}`);
  }

  private respond(id: RpcId, result: unknown): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: RpcId, code: number, message: string): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
  }

  private handleNotification(message: RpcNotification): void {
    const params = message.params ?? {};
    if (message.method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id) this.activeTurnId = turn.id;
      this.callbacks.onProgress({ kind: "status", label: "已开始分析" });
      return;
    }
    if (message.method === "error") {
      const error = params.error as { message?: string } | undefined;
      const detail = error?.message || "上游处理发生错误";
      if (isRetryableUpstreamError(detail)) {
        this.callbacks.onProgress({ kind: "status", status: "retrying", label: "上游连接短暂中断，正在自动重试" });
        return;
      }
      if (/reconnecting/i.test(detail)) {
        this.reconnectNotices += 1;
        if (this.reconnectNotices >= 3 && !this.reconnectWarningSent) {
          this.reconnectWarningSent = true;
          this.callbacks.onProgress({
            kind: "status",
            status: "retrying",
            label: "上游连续多次连接失败，请检查该源的 API Key 与 base_url；若是临时网络抖动将自动恢复",
          });
        }
        this.callbacks.onProgress({ kind: "status", status: "retrying", label: "上游连接不稳定，正在自动重连" });
        return;
      }
      this.callbacks.onProgress({ kind: "error", label: describeUpstreamError(redactBrand(detail)) });
      return;
    }
    if (message.method === "item/autoApprovalReview/started" || message.method === "item/autoApprovalReview/completed") {
      const progress = summarizeAutoApprovalReview(params, message.method.endsWith("/completed"));
      if (progress) this.callbacks.onProgress(progress);
      return;
    }
    if (message.method === "guardianWarning") {
      const detail = redactBrand(String(params.message ?? "自动审核发生异常"));
      this.callbacks.onProgress({ kind: "approval", label: "自动审核警告", detail, reviewStatus: "warning" });
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = params.item as JsonObject | undefined;
      if (!item) return;
      if (item.type === "agentMessage" && message.method === "item/completed") {
        this.finalResponse = typeof item.text === "string" ? item.text : this.finalResponse;
        if (this.options.outputSchema) return;
      }
      const progress = summarizeAppServerItem(item, message.method === "item/completed");
      if (progress) this.callbacks.onProgress(progress);
      return;
    }
    if (message.method !== "turn/completed") return;
    const turn = params.turn as { id?: string; status?: string; error?: { message?: string } | null } | undefined;
    if (turn?.id && this.activeTurnId && turn.id !== this.activeTurnId) return;
    this.terminal = true;
    this.activeTurnId = null;
    if (turn?.status === "completed") {
      this.callbacks.onProgress({ kind: "status", label: "工作已完成，正在整理结果" });
      this.resolveCompletion(this.finalResponse);
      return;
    }
    const error = new Error(turn?.error?.message || (turn?.status === "interrupted" ? "任务已停止" : "Agent 任务失败"));
    if (turn?.status === "interrupted" || this.callbacks.signal.aborted) error.name = "AbortError";
    this.rejectCompletion(error);
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.rejectCompletion(error);
  }

  private dispose(): void {
    if (this.child.stdin.writable) this.child.stdin.end();
    if (!this.child.killed) this.child.kill("SIGTERM");
  }
}

export function startAppServerTurn(options: AppServerTurnOptions, callbacks: AppServerCallbacks): AppServerTurnExecution {
  const client = new AppServerTurnClient(options, callbacks);
  return {
    result: client.run(),
    steer: (prompt, imagePaths) => client.steer(prompt, imagePaths),
    interrupt: () => client.interrupt(),
  };
}

function makeUserInput(prompt: string, imagePaths: string[]): JsonObject[] {
  const input: JsonObject[] = [{ type: "text", text: prompt, text_elements: [] }];
  for (const imagePath of imagePaths) input.push({ type: "localImage", path: imagePath });
  return input;
}

export function summarizeAppServerItem(item: JsonObject, completed: boolean): unknown | null {
  if (item.type === "reasoning") {
    const summaries = asStringArray(item.summary)
      .map((part) => redactBrand(sanitizeAgentMarkdown(part)).trim())
      .filter(Boolean);
    const contents = asStringArray(item.content)
      .map((part) => redactBrand(sanitizeAgentMarkdown(part)).trim())
      .filter(Boolean);
    if (summaries.length === 0 && contents.length === 0) return null;
    return {
      kind: "reasoning",
      label: "思考过程",
      detail: summaries.join("\n\n") || contents.join("\n\n"),
      steps: buildReasoningSteps(summaries, contents),
    };
  }
  if (item.type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : "";
    const status = typeof item.status === "string" ? item.status : completed ? "completed" : "inProgress";
    return { kind: "command", label: status === "failed" ? "本机步骤执行失败，正在调整" : status === "inProgress" ? "正在执行本机处理步骤" : "本机处理步骤完成", detail: redactBrand(command) };
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes as JsonObject[] : [];
    return { kind: "file", label: "已更新文件", files: changes.map((change) => String(change.path ?? change.file_path ?? "")).filter(Boolean) };
  }
  if (item.type === "webSearch") return { kind: "search", label: "正在搜索资料" };
  if (item.type === "mcpToolCall") return { kind: "tool", label: `正在使用 ${redactBrand(String(item.server ?? "工具"))}`, detail: redactBrand(String(item.tool ?? "")) };
  if (item.type === "collabAgentToolCall") return summarizeCollabAgentToolCall(item, completed);
  if (item.type === "subAgentActivity") return summarizeSubAgentActivity(item);
  if (item.type === "plan") return { kind: "update", label: "任务计划已更新", detail: String(item.text ?? "") };
  if (item.type === "agentMessage" && completed) {
    const detail = redactBrand(sanitizeAgentMarkdown(String(item.text ?? ""))).trim();
    return detail ? { kind: "update", label: "阶段反馈", detail } : null;
  }
  return null;
}

function summarizeCollabAgentToolCall(item: JsonObject, completed: boolean): unknown {
  const tool = typeof item.tool === "string" ? item.tool : "";
  const status = typeof item.status === "string" ? item.status : completed ? "completed" : "inProgress";
  const label = collabAgentToolLabel(tool, status);
  const detailParts: string[] = [];
  if (typeof item.prompt === "string" && item.prompt.trim()) {
    detailParts.push(`任务：${redactBrand(item.prompt.replace(/\s+/g, " ").trim())}`);
  }
  if (typeof item.model === "string" && item.model.trim()) detailParts.push(`模型：${redactBrand(item.model)}`);
  if (typeof item.reasoningEffort === "string" && item.reasoningEffort.trim()) detailParts.push(`推理：${item.reasoningEffort}`);
  const receiverThreadIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String).filter(Boolean) : [];
  if (receiverThreadIds.length > 0) detailParts.push(`子代理线程：${receiverThreadIds.join("、")}`);
  const agentsStates = asObject(item.agentsStates);
  if (agentsStates) {
    const states = Object.entries(agentsStates)
      .map(([threadId, state]) => {
        const statusValue = asObject(state)?.status;
        return `${threadId}：${typeof statusValue === "string" ? subAgentStatusLabel(statusValue) : "状态未知"}`;
      });
    if (states.length > 0) detailParts.push(`状态：${states.join("；")}`);
  }
  return {
    kind: "subagent",
    label,
    detail: detailParts.join("\n"),
    subagentTool: tool,
    subagentStatus: status,
    agentThreadIds: receiverThreadIds,
  };
}

function summarizeSubAgentActivity(item: JsonObject): unknown {
  const activity = typeof item.kind === "string" ? item.kind : "interacted";
  const agentPath = typeof item.agentPath === "string" ? item.agentPath : "";
  const agentThreadId = typeof item.agentThreadId === "string" ? item.agentThreadId : "";
  const detailParts = [
    agentPath ? `代理：${redactBrand(agentPath)}` : "",
    agentThreadId ? `线程：${agentThreadId}` : "",
  ].filter(Boolean);
  return {
    kind: "subagent",
    label: subAgentActivityLabel(activity),
    detail: detailParts.join("\n"),
    subagentActivity: activity,
    agentPath: agentPath || undefined,
    agentThreadId: agentThreadId || undefined,
  };
}

function collabAgentToolLabel(tool: string, status: string): string {
  if (status === "failed") return "子代理操作失败";
  if (status === "interrupted") return "子代理操作已中断";
  if (status === "completed") {
    return ({
      spawnAgent: "子代理已启动",
      sendInput: "已向子代理发送任务",
      resumeAgent: "子代理已恢复",
      wait: "已取得子代理结果",
      closeAgent: "子代理已关闭",
      sendMessage: "已传递子代理消息",
      followupTask: "已追加子代理任务",
      interruptAgent: "子代理已中断",
      listAgents: "已查看子代理状态",
    } as Record<string, string>)[tool] ?? "子代理操作完成";
  }
  return ({
    spawnAgent: "正在启动子代理",
    sendInput: "正在向子代理发送任务",
    resumeAgent: "正在恢复子代理",
    wait: "正在等待子代理结果",
    closeAgent: "正在关闭子代理",
    sendMessage: "正在传递子代理消息",
    followupTask: "正在追加子代理任务",
    interruptAgent: "正在中断子代理",
    listAgents: "正在查看子代理状态",
  } as Record<string, string>)[tool] ?? "正在处理子代理操作";
}

function subAgentActivityLabel(activity: string): string {
  return ({
    started: "子代理已开始工作",
    interacted: "子代理正在工作",
    interrupted: "子代理已中断",
    completed: "子代理已完成工作",
  } as Record<string, string>)[activity] ?? "子代理状态已更新";
}

function subAgentStatusLabel(status: string): string {
  return ({
    pendingInit: "等待启动",
    running: "运行中",
    interrupted: "已中断",
    completed: "已完成",
    errored: "出错",
    shutdown: "已关闭",
    notFound: "未找到",
  } as Record<string, string>)[status] ?? status;
}

function summarizeAutoApprovalReview(params: JsonObject, completed: boolean): unknown | null {
  const reviewId = typeof params.reviewId === "string" ? params.reviewId : "";
  const review = asObject(params.review);
  const action = asObject(params.action);
  if (!reviewId || !review || !action) return null;
  const reviewStatus = typeof review.status === "string" ? review.status : completed ? "aborted" : "inProgress";
  const actionLabel = approvalActionLabel(action);
  const actionDetail = approvalActionDetail(action);
  const detailParts = [
    `**审核对象**：${actionDetail}`,
    `**审核结果**：${approvalStatusLabel(reviewStatus)}`,
  ];
  if (typeof review.riskLevel === "string") detailParts.push(`**风险等级**：${approvalRiskLabel(review.riskLevel)}`);
  if (typeof review.userAuthorization === "string") detailParts.push(`**用户授权**：${approvalAuthorizationLabel(review.userAuthorization)}`);
  if (typeof review.rationale === "string" && review.rationale.trim()) {
    detailParts.push(`**审核依据**：${redactBrand(sanitizeAgentMarkdown(review.rationale)).trim()}`);
  }
  const detail = detailParts.join("\n\n");
  return {
    kind: "approval",
    label: approvalProgressLabel(reviewStatus),
    detail,
    reviewId,
    reviewStatus,
    riskLevel: typeof review.riskLevel === "string" ? review.riskLevel : undefined,
    userAuthorization: typeof review.userAuthorization === "string" ? review.userAuthorization : undefined,
    steps: [{ id: `approval:${reviewId}`, title: `请求审核：${actionLabel}`, detail }],
  };
}

function summarizeUnhandledApprovalRequest(method: string, id: RpcId, params: JsonObject): unknown | null {
  const approvalMethods = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "execCommandApproval",
    "applyPatchApproval",
  ];
  if (!approvalMethods.includes(method)) return null;
  const action = fallbackApprovalAction(method, params);
  const detail = `**审核对象**：${action.detail}\n\n**审核结果**：未进入自动审核，已拒绝\n\n**原因**：${APPROVAL_REJECTION}`;
  return {
    kind: "approval",
    label: "请求未进入自动审核，已拒绝",
    detail,
    reviewId: `fallback:${String(id)}`,
    reviewStatus: "denied",
    steps: [{ id: `approval:fallback:${String(id)}`, title: `请求审核：${action.label}`, detail }],
  };
}

function fallbackApprovalAction(method: string, params: JsonObject): { label: string; detail: string } {
  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "未提供命令内容";
    return { label: "执行命令", detail: redactBrand(command) };
  }
  if (method === "execCommandApproval") {
    const command = Array.isArray(params.command) ? params.command.map(String).join(" ") : "未提供命令内容";
    return { label: "执行命令", detail: redactBrand(command) };
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const root = typeof params.grantRoot === "string" ? params.grantRoot : "工作区外文件写入";
    return { label: "修改文件", detail: redactBrand(root) };
  }
  const reason = typeof params.reason === "string" ? params.reason : "请求额外权限";
  return { label: "扩展权限", detail: redactBrand(reason) };
}

function approvalActionLabel(action: JsonObject): string {
  if (action.type === "command" || action.type === "execve") return "执行命令";
  if (action.type === "applyPatch") return "修改文件";
  if (action.type === "networkAccess") return "访问网络";
  if (action.type === "mcpToolCall") return "调用工具";
  if (action.type === "requestPermissions") return "扩展权限";
  return "敏感操作";
}

function approvalActionDetail(action: JsonObject): string {
  if (action.type === "command") return redactBrand(String(action.command ?? "未提供命令内容"));
  if (action.type === "execve") {
    const argv = Array.isArray(action.argv) ? action.argv.map(String) : [];
    return redactBrand([String(action.program ?? ""), ...argv].filter(Boolean).join(" ") || "未提供命令内容");
  }
  if (action.type === "applyPatch") {
    const files = Array.isArray(action.files) ? action.files.map(String).filter(Boolean) : [];
    return files.length > 0 ? files.map(redactBrand).join("、") : "工作区外文件写入";
  }
  if (action.type === "networkAccess") {
    const protocol = String(action.protocol ?? "network");
    const host = String(action.host ?? action.target ?? "未知地址");
    const port = typeof action.port === "number" ? `:${action.port}` : "";
    return redactBrand(`${protocol}://${host}${port}`);
  }
  if (action.type === "mcpToolCall") {
    return redactBrand(`${String(action.server ?? "工具")}.${String(action.toolName ?? "调用")}`);
  }
  if (action.type === "requestPermissions") return redactBrand(String(action.reason ?? "请求额外权限"));
  return "未提供操作详情";
}

function approvalProgressLabel(status: string): string {
  if (status === "inProgress") return "正在自动审核请求";
  if (status === "approved") return "自动审核已批准请求";
  if (status === "denied") return "自动审核已拒绝请求";
  if (status === "timedOut") return "自动审核超时，未执行请求";
  return "自动审核已中止，未执行请求";
}

function approvalStatusLabel(status: string): string {
  if (status === "inProgress") return "审核中";
  if (status === "approved") return "已批准";
  if (status === "denied") return "已拒绝";
  if (status === "timedOut") return "已超时，未执行";
  return "已中止，未执行";
}

function approvalRiskLabel(risk: string): string {
  return ({ low: "低", medium: "中", high: "高", critical: "严重" } as Record<string, string>)[risk] ?? risk;
}

function approvalAuthorizationLabel(authorization: string): string {
  return ({ unknown: "未知", low: "低", medium: "中", high: "高" } as Record<string, string>)[authorization] ?? authorization;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function redactBrand(value: string): string {
  return value.replace(/chatgpt|codex/gi, "Codex Web");
}
