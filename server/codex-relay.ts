import fs from "node:fs";
import { spawn } from "node:child_process";

export type CodexRelayLaunchOptions = {
  executablePath: string;
  upstreamBaseUrl: string;
  apiKey: string | null;
  historyDir: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  startupTimeoutMs?: number;
};

export type CodexRelayExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type CodexRelayHandle = {
  baseUrl: string;
  exited: Promise<CodexRelayExit>;
  stop(): Promise<void>;
};

const LISTEN_PATTERN = /codex-relay listening on 127\.0\.0\.1:(\d+)/;

function abortError(): Error {
  const error = new Error("任务已停止");
  error.name = "AbortError";
  return error;
}

function validateUpstreamBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Chat Completions 源的 Base URL 无效");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Chat Completions 源只支持 HTTP 或 HTTPS Base URL");
  }
  return value.replace(/\/+$/, "");
}

function sanitizedStartupError(stderr: string, apiKey: string | null, upstreamBaseUrl: string): string {
  const withoutUpstream = stderr.replaceAll(upstreamBaseUrl, "[UPSTREAM]");
  const redacted = apiKey ? withoutUpstream.replaceAll(apiKey, "[REDACTED]") : withoutUpstream;
  const detail = redacted.trim().split(/\r?\n/).slice(-3).join("\n");
  return detail ? `codex-relay 启动失败：${detail}` : "codex-relay 启动失败";
}

export async function startCodexRelay(options: CodexRelayLaunchOptions): Promise<CodexRelayHandle> {
  if (options.signal.aborted) throw abortError();
  const upstreamBaseUrl = validateUpstreamBaseUrl(options.upstreamBaseUrl);
  fs.mkdirSync(options.historyDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(options.historyDir, 0o700); } catch {}

  const child = spawn(options.executablePath, [], {
    cwd: options.historyDir,
    env: {
      ...options.env,
      CODEX_RELAY_BIND: "127.0.0.1",
      CODEX_RELAY_PORT: "0",
      CODEX_RELAY_UPSTREAM: upstreamBaseUrl,
      CODEX_RELAY_API_KEY: options.apiKey ?? "",
      CODEX_RELAY_HISTORY_STORE: "disk",
      CODEX_RELAY_HISTORY_DIR: options.historyDir,
      CODEX_RELAY_MAX_SESSIONS: "64",
      CODEX_RELAY_MAX_SESSION_MEMORY_MB: "256",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stopping = false;
  let settled = false;
  let output = "";
  let resolveReady!: (baseUrl: string) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveExited!: (exit: CodexRelayExit) => void;
  const exited = new Promise<CodexRelayExit>((resolve) => { resolveExited = resolve; });

  const inspectOutput = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-16_000);
    const match = LISTEN_PATTERN.exec(output);
    if (!settled && match) {
      settled = true;
      resolveReady(`http://127.0.0.1:${match[1]}/v1`);
    }
  };
  child.stdout?.on("data", inspectOutput);
  child.stderr?.on("data", inspectOutput);
  child.once("error", (error) => {
    if (!settled) {
      settled = true;
      rejectReady((error as NodeJS.ErrnoException).code === "ENOENT"
        ? new Error(`未找到 codex-relay 可执行文件：${options.executablePath}`)
        : error);
    }
  });
  child.once("exit", (code, signal) => {
    resolveExited({ code, signal });
    if (!settled) {
      settled = true;
      rejectReady(options.signal.aborted ? abortError() : new Error(sanitizedStartupError(output, options.apiKey, upstreamBaseUrl)));
    }
  });

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectReady(new Error("codex-relay 启动超时"));
  }, options.startupTimeoutMs ?? 10_000);
  timeout.unref();

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    options.signal.removeEventListener("abort", onAbort);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000);
        timer.unref();
      }),
    ]);
    if (!stopped && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };

  const onAbort = () => {
    if (!settled) {
      settled = true;
      rejectReady(abortError());
    }
    void stop();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const baseUrl = await ready;
    return { baseUrl, exited, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function relayExitError(exit: CodexRelayExit): Error {
  return new Error(`codex-relay 意外退出（${exit.signal ?? exit.code ?? "unknown"}）`);
}
