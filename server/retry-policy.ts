export const TRANSIENT_RETRY_DELAYS_MS = [15_000, 45_000, 120_000] as const;

export function upstreamErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
}

export function isRetryableUpstreamError(error: unknown): boolean {
  const message = searchableUpstreamError(error).toLowerCase();
  return [
    /stream disconnected before completion/,
    /websocket closed by server before response\.completed/,
    /falling back from websockets? to https transport/,
    /connection reset by peer/,
    /socket hang up/,
    /\beconnreset\b/,
    /\betimedout\b/,
    /request timed out/,
    /server[- ]overload/,
    /model (?:is )?at capacity/,
    /\b(?:http(?:\/\d+(?:\.\d+)?)?|status(?:[_ ]?code)?|response(?:[._ ]?status)?)\b[\s"'`]*(?:[:=]\s*)?(?:429|502|503|504)\b/,
    /(?:too many requests|rate[-_ ]limit(?:ed|ing)?|rate_limit_exceeded|请求过于频繁|频率限制)/,
  ].some((pattern) => pattern.test(message));
}

function searchableUpstreamError(error: unknown): string {
  const message = upstreamErrorMessage(error);
  if (!error || typeof error !== "object") return message;
  const record = error as Record<string, unknown>;
  const details = [
    ["status", record.status],
    ["statusCode", record.statusCode],
    ["status_code", record.status_code],
    ["responseStatus", record.responseStatus],
    ["response_status", record.response_status],
    ["response", record.response],
    ["cause", record.cause],
    ["error", record.error],
    ["details", record.details],
  ].map(([key, value]) => {
    const detail = stringifyErrorDetail(value);
    return detail ? `${key}:${detail}` : "";
  }).filter(Boolean);
  return [message, ...details].join(" ");
}

function stringifyErrorDetail(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return ""; }
}

/**
 * Translate common upstream failures into an actionable message for the web
 * UI. Non-matching errors pass through unchanged so real diagnostics are never
 * hidden. The upstream detail is kept in parentheses for troubleshooting.
 */
export function describeUpstreamError(error: unknown): string {
  const message = upstreamErrorMessage(error).trim();
  const lower = message.toLowerCase();
  const detail = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  if (/\b401\b|authentication fails|authentication_error|unauthorized|api key[^\n]*(?:invalid|expired)|invalid(?: or expired)? api key|invalid_api_key/.test(lower)) {
    return `上游认证失败：该源的 API Key 无效或已过期，请检查密钥与 base_url 是否匹配（上游返回：${detail}）。`;
  }
  if (/\b403\b|forbidden|permission denied/.test(lower)) {
    return `上游拒绝访问：该源的 API Key 可能缺少权限或 base_url 配置有误（上游返回：${detail}）。`;
  }
  if (/模型配置不存在|model[^\n]*(?:not found|不存在)|model_provider[^\n]*not found/.test(lower)) {
    return `上游不识别所选模型：请检查该源的模型 ID 是否为上游真实支持的模型名（上游返回：${detail}）。`;
  }
  if (/failed to load configuration/.test(lower)) {
    return `Codex 配置加载失败：请检查 ~/.codex/config.toml 与 models_cache.json 是否完整有效（上游返回：${detail}）。`;
  }
  return message;
}

type RetryNotice = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  message: string;
};

export async function runWithTransientRetries<T>(
  operation: (retryAttempt: number) => Promise<T>,
  options: {
    signal: AbortSignal;
    delaysMs?: readonly number[];
    onRetry?: (notice: RetryNotice) => void;
  },
): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  for (let retryAttempt = 0; ; retryAttempt += 1) {
    try {
      return await operation(retryAttempt);
    } catch (error) {
      if (options.signal.aborted) throw abortError();
      if (retryAttempt >= delays.length || !isRetryableUpstreamError(error)) throw error;
      const delayMs = delays[retryAttempt];
      options.onRetry?.({
        attempt: retryAttempt + 1,
        maxAttempts: delays.length,
        delayMs,
        message: upstreamErrorMessage(error),
      });
      await abortableDelay(delayMs, options.signal);
    }
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", cancelled, { once: true });
    function done() { signal.removeEventListener("abort", cancelled); resolve(); }
    function cancelled() { clearTimeout(timer); reject(abortError()); }
  });
}

function abortError(): Error {
  const error = new Error("任务已停止");
  error.name = "AbortError";
  return error;
}
