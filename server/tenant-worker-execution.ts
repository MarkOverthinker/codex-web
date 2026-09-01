import crypto from "node:crypto";
import path from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { startAppServerTurn, type AppServerTurnExecution, type ContextUsage } from "./app-server-turn.js";
import { buildCodexEnvironment, buildShellEnvironment, resolvePythonRuntime } from "./python-runtime.js";
import { summarizeEvent } from "./codex-events.js";
import type { TenantWorkerRunRequest } from "./tenant-worker-protocol.js";
import { isOptionalAgentCapabilities } from "./optional-capabilities.js";
import { startCodexRelay } from "./codex-relay.js";
import type { TokenUsage } from "./billing.js";

type ExecutionCallbacks = {
  signal: AbortSignal;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
  onUsage(usage: TokenUsage): void;
  onContextUsage?(usage: ContextUsage): void;
};

export async function executeTenantTurn(request: TenantWorkerRunRequest, callbacks: ExecutionCallbacks): Promise<string> {
  return startTenantTurn(request, callbacks).result;
}

export function startTenantTurn(request: TenantWorkerRunRequest, callbacks: ExecutionCallbacks): AppServerTurnExecution {
  const pythonRuntime = resolvePythonRuntime({
    projectRoot: request.projectRoot,
    pythonRuntimeRoot: request.pythonRuntimeRoot,
  });
  const codexEnvironment = buildCodexEnvironment(pythonRuntime, request.runtimeRoot);
  const hostMode = Boolean(request.hostMode);
  codexEnvironment.HOME = hostMode && request.home ? request.home : request.tenantRoot;
  codexEnvironment.CODEX_HOME = request.codexHome;
  if (process.platform === "win32") {
    codexEnvironment.CODEX_WINDOWS_SANDBOX = request.codexWindowsSandbox;
  }
  const baseOptions = {
    executablePath: process.env.CODEX_RUNTIME_PATH || undefined,
    modelContextWindow: request.selection.modelContextWindow,
    autoCompactTokenLimit: request.selection.autoCompactTokenLimit,
    cwd: request.workingDir ?? request.workspace,
    env: codexEnvironment,
    threadId: request.codexThreadId,
    prompt: request.effectivePrompt,
    imagePaths: request.imagePaths,
    outputSchema: request.outputSchema,
    model: request.selection.model,
    reasoningEffort: request.selection.reasoningEffort,
    modelProvider: request.modelProvider,
    sandboxMode: request.sandboxMode,
    library: request.library,
    shellEnvironment: buildShellEnvironment(pythonRuntime, request.runtimeRoot, hostMode ? request.home : undefined),
    networkAccessEnabled: request.networkAccessEnabled,
    webSearchMode: request.webSearchMode,
    optionalCapabilities: request.optionalCapabilities,
    runtimeWorkspaceRoots: hostMode ? [request.workingDir ?? request.workspace, request.workspace, request.library] : undefined,
    uid: hostMode ? request.uid : undefined,
    gid: hostMode ? request.gid : undefined,
  };
  if (!request.modelAdapter) return startAppServerTurn(baseOptions, callbacks);
  const modelAdapter = request.modelAdapter;

  let activeTurn: AppServerTurnExecution | undefined;
  let stopRelay: (() => Promise<void>) | undefined;
  const ready = (async () => {
    callbacks.onProgress({ kind: "status", label: "正在启动 Chat Completions 兼容代理" });
    const historyDir = path.join(request.workspace, ".runtime", "codex-relay", modelAdapter.providerId);
    const relay = await startCodexRelay({
      executablePath: modelAdapter.executablePath,
      upstreamBaseUrl: modelAdapter.upstreamBaseUrl,
      apiKey: modelAdapter.apiKey,
      historyDir,
      env: codexEnvironment,
      signal: callbacks.signal,
    });
    stopRelay = relay.stop;
    const authEnvKey = "CODEX_WEB_RELAY_TOKEN";
    const appServerEnvironment = {
      ...codexEnvironment,
      [authEnvKey]: crypto.randomBytes(32).toString("hex"),
    };
    activeTurn = startAppServerTurn({
      ...baseOptions,
      env: appServerEnvironment,
      runtimeModelProvider: {
        id: modelAdapter.providerId,
        name: modelAdapter.providerName,
        baseUrl: relay.baseUrl,
        envKey: authEnvKey,
      },
    }, callbacks);
    return activeTurn;
  })();

  const result = (async () => {
    try {
      return await (await ready).result;
    } finally {
      await stopRelay?.();
    }
  })();

  return {
    result,
    steer: async (prompt, imagePaths) => (await ready).steer(prompt, imagePaths),
    interrupt: () => {
      activeTurn?.interrupt();
      void stopRelay?.();
    },
  };
}

export async function consumeTenantTurnEvents(
  events: AsyncIterable<ThreadEvent>,
  callbacks: Pick<ExecutionCallbacks, "onThreadStarted" | "onProgress"> & { onUsage?: ExecutionCallbacks["onUsage"] },
): Promise<string> {
  let finalResponse = "";
  let turnCompleted = false;
  let lastStreamError = "";
  for await (const event of events) {
    if (event.type === "thread.started") callbacks.onThreadStarted(event.thread_id);
    const publicEvent = summarizeEvent(event);
    if (publicEvent) callbacks.onProgress(publicEvent);
    if ((event.type === "item.updated" || event.type === "item.completed") && event.item.type === "agent_message") {
      finalResponse = event.item.text;
    }
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "turn.completed") callbacks.onUsage?.(event.usage);
    // A top-level error event is not necessarily terminal. The CLI may emit it
    // while reconnecting, then fall back from WebSockets to HTTPS and complete
    // the same turn. Only fail if the stream ends without turn.completed.
    if (event.type === "error") lastStreamError = event.message;
    if (event.type === "turn.completed") turnCompleted = true;
  }
  if (!turnCompleted) throw new Error(lastStreamError || "Upstream stream ended before response.completed");
  return finalResponse;
}

export function validateTenantWorkerRequest(request: TenantWorkerRunRequest, expectedUserId: string, expectedTenantRoot: string): void {
  if (request.userId !== expectedUserId) throw new Error("Worker user mismatch");
  if (!/^[0-9a-f-]{36}$/i.test(request.jobId) || !/^[0-9a-f-]{36}$/i.test(request.conversationId)) {
    throw new Error("Invalid worker identifiers");
  }
  if (!isOptionalAgentCapabilities(request.optionalCapabilities)) throw new Error("Invalid optional capabilities");
  if (request.sandboxMode !== "workspace-write" && request.sandboxMode !== "danger-full-access") throw new Error("Invalid worker sandbox mode");
  if (request.modelProvider !== undefined && request.modelProvider !== null && !/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(request.modelProvider)) {
    throw new Error("Invalid worker model provider");
  }
  if (request.modelAdapter) {
    if (request.modelAdapter.kind !== "codex-relay") throw new Error("Invalid worker model adapter");
    if (request.modelAdapter.providerId !== request.modelProvider) throw new Error("Worker model adapter provider mismatch");
    if (!request.modelAdapter.executablePath.trim() || !request.modelAdapter.providerName.trim()) throw new Error("Invalid worker model adapter configuration");
    let upstream: URL;
    try { upstream = new URL(request.modelAdapter.upstreamBaseUrl); }
    catch { throw new Error("Invalid worker model adapter upstream URL"); }
    if (upstream.protocol !== "http:" && upstream.protocol !== "https:") throw new Error("Invalid worker model adapter upstream protocol");
  }
  const tenantRoot = path.resolve(expectedTenantRoot);
  const expectedWorkspace = path.join(tenantRoot, "conversations", request.conversationId);
  const expectedRuntime = path.join(expectedWorkspace, ".runtime", "jobs", request.jobId);
  const exactPaths: Array<[string, string]> = [
    [request.tenantRoot, tenantRoot],
    [request.workspace, expectedWorkspace],
    [request.runtimeRoot, expectedRuntime],
    [request.codexHome, path.join(tenantRoot, "codex-home")],
    [request.library, path.join(tenantRoot, "library")],
  ];
  for (const [actual, expected] of exactPaths) {
    if (path.resolve(actual) !== path.resolve(expected)) throw new Error("Worker path mismatch");
  }
  if (request.workingDir !== undefined) {
    if (!request.hostMode) throw new Error("Worker working dir requires host mode");
    if (!request.workingDir || !path.isAbsolute(request.workingDir)) throw new Error("Invalid worker working dir");
    const workingDir = path.resolve(request.workingDir);
    if (workingDir === tenantRoot || workingDir.startsWith(`${tenantRoot}${path.sep}`)) {
      throw new Error("Worker working dir escapes tenant boundary");
    }
  }
  for (const imagePath of request.imagePaths) {
    const resolved = path.resolve(imagePath);
    if (!resolved.startsWith(`${path.resolve(expectedWorkspace)}${path.sep}`)) throw new Error("Worker image path escapes workspace");
  }
}
