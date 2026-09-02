import crypto from "node:crypto";
import type { ApiUsageRow, AppDatabase, PricingRuleRow, ProviderModelRow, ProviderRow } from "./db.js";

export const BUILTIN_PROVIDER_ID = "__builtin__";

export type TokenUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

type BillingAmount = { amount: number | null; currency: string; priced: boolean };

export type BillingState = {
  rangeDays: number;
  from: string;
  summary: {
    calls: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    cacheHitRate: number;
    estimatedCost: number | null;
    currency: string;
    unpricedCalls: number;
  };
  byProvider: Array<{
    providerId: string;
    providerName: string;
    calls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    cacheHitRate: number;
    estimatedCost: number | null;
    currency: string;
  }>;
  byModel: Array<{
    providerId: string;
    providerName: string;
    modelId: string;
    calls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    cacheHitRate: number;
    estimatedCost: number | null;
    currency: string;
  }>;
  rules: PricingRuleRow[];
  models: Array<{ providerId: string; providerName: string; modelId: string; displayName: string }>;
};

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
  return null;
}

function sumUsage(rows: ApiUsageRow[]): TokenUsage & { calls: number } {
  return rows.reduce((total, row) => ({
    calls: total.calls + 1,
    input_tokens: total.input_tokens + row.input_tokens,
    cached_input_tokens: total.cached_input_tokens + row.cached_input_tokens,
    cache_write_input_tokens: total.cache_write_input_tokens + row.cache_write_input_tokens,
    output_tokens: total.output_tokens + row.output_tokens,
    reasoning_output_tokens: total.reasoning_output_tokens + row.reasoning_output_tokens,
  }), { calls: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
}

function localPeakTime(createdAt: string, timezone: string): { weekday: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(createdAt));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[values.get("weekday") as "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun"];
    const hour = Number(values.get("hour"));
    const minute = Number(values.get("minute"));
    if (!weekday || !Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { weekday, minute: hour * 60 + minute };
  } catch {
    return null;
  }
}

function isPeakPeriod(row: ApiUsageRow, rule: PricingRuleRow): boolean {
  if (!rule.peak_enabled || rule.peak_start_minute === null || rule.peak_end_minute === null || rule.peak_start_minute === rule.peak_end_minute) return false;
  const local = localPeakTime(row.created_at, rule.timezone);
  if (!local) return false;
  const weekdays = new Set(rule.peak_weekdays.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 1 && value <= 7));
  if (weekdays.size === 0) return false;
  const start = rule.peak_start_minute;
  const end = rule.peak_end_minute;
  if (start < end) return weekdays.has(local.weekday) && local.minute >= start && local.minute < end;
  const previousWeekday = local.weekday === 1 ? 7 : local.weekday - 1;
  return (local.minute >= start && weekdays.has(local.weekday)) || (local.minute < end && weekdays.has(previousWeekday));
}

function uncachedInputTokens(row: ApiUsageRow): number {
  return Math.max(0, row.input_tokens - row.cached_input_tokens - row.cache_write_input_tokens);
}

function calculateCost(row: ApiUsageRow, rule: PricingRuleRow | undefined): BillingAmount {
  if (!rule) return { amount: null, currency: "USD", priced: false };
  const peakRates = isPeakPeriod(row, rule)
    && rule.peak_input_per_million !== null
    && rule.peak_cached_input_per_million !== null
    && rule.peak_cache_write_per_million !== null
    && rule.peak_output_per_million !== null
    ? { input: rule.peak_input_per_million, cacheRead: rule.peak_cached_input_per_million, cacheWrite: rule.peak_cache_write_per_million, output: rule.peak_output_per_million }
    : null;
  const rates = peakRates ?? { input: rule.input_per_million, cacheRead: rule.cached_input_per_million, cacheWrite: rule.cache_write_per_million, output: rule.output_per_million };
  const amount = (
    uncachedInputTokens(row) * rates.input
    + row.output_tokens * rates.output
    + row.cache_write_input_tokens * rates.cacheWrite
    + row.cached_input_tokens * rates.cacheRead
  ) / 1_000_000;
  return { amount, currency: rule.currency, priced: true };
}

function cacheHitRate(usage: TokenUsage): number {
  return usage.input_tokens > 0 ? usage.cached_input_tokens / usage.input_tokens : 0;
}

function providerName(providerId: string, providers: ProviderRow[]): string {
  return providerId === BUILTIN_PROVIDER_ID ? "Codex 内置源" : providers.find((provider) => provider.id === providerId)?.name ?? providerId;
}

function modelDisplayName(providerId: string, modelId: string, models: ProviderModelRow[]): string {
  return models.find((model) => model.provider_id === providerId && (model.model_id === modelId || model.slug === modelId))?.display_name ?? modelId;
}

export function buildBillingState(db: AppDatabase, userId: string, rangeDays = 30): BillingState {
  const days = Math.min(3650, Math.max(1, Math.trunc(rangeDays) || 30));
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db.listApiUsage(userId, from);
  const providers = db.listProviders(userId);
  const models = db.listProviderModels(userId);
  const rules = db.listPricingRules(userId);
  const ruleMap = new Map(rules.map((rule) => [`${rule.provider_id}:${rule.model_id}`, rule]));
  const costs = rows.map((row) => calculateCost(row, ruleMap.get(`${row.provider_id}:${row.model_id}`)));
  const total = sumUsage(rows);
  const pricedCosts = costs.filter((cost) => cost.priced);
  const currencies = new Set(pricedCosts.map((cost) => cost.currency));
  const currency = currencies.size === 1 ? [...currencies][0] : "USD";
  const groups = (key: (row: ApiUsageRow) => string) => {
    const grouped = new Map<string, ApiUsageRow[]>();
    for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
    return grouped;
  };
  const byProvider = [...groups((row) => row.provider_id)].map(([providerId, group]) => {
    const usage = sumUsage(group);
    const groupCosts = group.map((row) => calculateCost(row, ruleMap.get(`${row.provider_id}:${row.model_id}`)));
    return {
      providerId, providerName: providerName(providerId, providers), calls: usage.calls,
      inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens,
      cacheHitRate: cacheHitRate(usage), estimatedCost: groupCosts.every((cost) => cost.priced) ? groupCosts.reduce((sum, cost) => sum + (cost.amount ?? 0), 0) : null,
      currency: groupCosts.find((cost) => cost.priced)?.currency ?? "USD",
    };
  }).sort((left, right) => right.calls - left.calls);
  const byModel = [...groups((row) => `${row.provider_id}:${row.model_id}`)].map(([key, group]) => {
    const [providerId, modelId] = key.split(":");
    const usage = sumUsage(group);
    const groupCosts = group.map((row) => calculateCost(row, ruleMap.get(`${row.provider_id}:${row.model_id}`)));
    return {
      providerId, providerName: providerName(providerId, providers), modelId,
      calls: usage.calls, inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens,
      cacheHitRate: cacheHitRate(usage),
      estimatedCost: groupCosts.every((cost) => cost.priced) ? groupCosts.reduce((sum, cost) => sum + (cost.amount ?? 0), 0) : null,
      currency: groupCosts.find((cost) => cost.priced)?.currency ?? "USD",
    };
  }).sort((left, right) => right.calls - left.calls);
  const knownModels = new Map<string, { providerId: string; providerName: string; modelId: string; displayName: string }>();
  for (const model of models) knownModels.set(`${model.provider_id}:${model.model_id}`, { providerId: model.provider_id, providerName: providerName(model.provider_id, providers), modelId: model.model_id, displayName: model.display_name });
  for (const row of rows) {
    const key = `${row.provider_id}:${row.model_id}`;
    if (!knownModels.has(key)) knownModels.set(key, { providerId: row.provider_id, providerName: providerName(row.provider_id, providers), modelId: row.model_id, displayName: modelDisplayName(row.provider_id, row.model_id, models) });
  }
  return {
    rangeDays: days, from,
    summary: {
      calls: total.calls, inputTokens: total.input_tokens, cachedInputTokens: total.cached_input_tokens,
      cacheWriteInputTokens: total.cache_write_input_tokens, outputTokens: total.output_tokens, reasoningOutputTokens: total.reasoning_output_tokens,
      cacheHitRate: cacheHitRate(total), estimatedCost: currencies.size <= 1 ? pricedCosts.reduce((sum, cost) => sum + (cost.amount ?? 0), 0) : null, currency,
      unpricedCalls: costs.filter((cost) => !cost.priced).length,
    },
    byProvider, byModel, rules, models: [...knownModels.values()].sort((left, right) => `${left.providerName}:${left.modelId}`.localeCompare(`${right.providerName}:${right.modelId}`)),
  };
}

function pricingNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function pricingModel(record: Record<string, unknown>): string | null {
  for (const key of ["model", "model_id", "modelId", "model_name", "modelName", "name", "slug"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return null;
}

function ratioConfigEntries(payload: Record<string, unknown>): Record<string, unknown>[] {
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const config = data as Record<string, unknown>;
  const modelRatios = config.model_ratio;
  if (!modelRatios || typeof modelRatios !== "object" || Array.isArray(modelRatios)) return [];
  const ratioMaps = {
    completion_ratio: config.completion_ratio,
    cache_ratio: config.cache_ratio,
    create_cache_ratio: config.create_cache_ratio,
  } as const;
  return Object.entries(modelRatios as Record<string, unknown>).map(([model, ratio]) => {
    const entry: Record<string, unknown> = { model, model_ratio: ratio };
    for (const [key, values] of Object.entries(ratioMaps)) {
      if (values && typeof values === "object" && !Array.isArray(values) && model in values) {
        entry[key] = (values as Record<string, unknown>)[model];
      }
    }
    return entry;
  });
}

function pricingEntries(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const ratioEntries = ratioConfigEntries(record);
  if (ratioEntries.length > 0) return ratioEntries;
  for (const key of ["data", "prices", "pricing", "models", "items", "list"]) {
    if (Array.isArray(record[key])) return pricingEntries(record[key]);
  }
  return Object.entries(record).flatMap(([model, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return [{ model, ...(value as Record<string, unknown>) }];
  });
}

function pricingCandidates(base: URL, providerBaseUrl: string, requestedUrl?: string): string[] {
  if (!requestedUrl) return [
    `${base.origin}/api/pricing`,
    `${base.origin}/api/ratio_config`,
    `${base.origin}/api/prices`,
    `${providerBaseUrl.replace(/\/+$/, "")}/pricing`,
  ];
  try {
    const requested = new URL(requestedUrl);
    if (requested.pathname.replace(/\/+$/, "") === "/pricing") {
      return [requestedUrl, `${requested.origin}/api/ratio_config`, `${requested.origin}/api/pricing`];
    }
  } catch {
  }
  return [requestedUrl];
}

export async function syncProviderPricing(
  db: AppDatabase,
  userId: string,
  provider: ProviderRow,
  pricingUrl?: string,
): Promise<{ imported: number; url: string }> {
  const base = new URL(provider.base_url);
  const requestedUrl = pricingUrl?.trim();
  const candidates = pricingCandidates(base, provider.base_url, requestedUrl);
  let lastError = "无法读取计费标准";
  for (const candidate of candidates) {
    let url: URL;
    try { url = new URL(candidate); } catch { lastError = "计费标准 URL 无效"; continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") { lastError = "计费标准 URL 只支持 HTTP 或 HTTPS"; continue; }
    if (url.origin !== base.origin) { lastError = "计费标准 URL 必须与 API 源使用相同的 origin"; continue; }
    try {
      const response = await fetch(url, { headers: { Accept: "application/json", ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}) } });
      if (!response.ok) { lastError = `计费标准接口返回 HTTP ${response.status}`; continue; }
      const responseText = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        lastError = "计费标准地址返回的不是 JSON；请使用 JSON 接口，例如 /api/ratio_config，而不是 /pricing 网页";
        continue;
      }
      const entries = pricingEntries(payload);
      let imported = 0;
      for (const entry of entries) {
        const modelId = pricingModel(entry);
        const newApiRatio = pricingNumber(entry, ["model_ratio"]);
        const newApiCompletionRatio = pricingNumber(entry, ["completion_ratio"]);
        const newApiCacheRatio = pricingNumber(entry, ["cache_ratio"]);
        const newApiCreateCacheRatio = pricingNumber(entry, ["create_cache_ratio"]);
        const isPerRequest = Number(entry.quota_type) === 1;
        const input = newApiRatio !== null && !isPerRequest
          ? newApiRatio * 2
          : pricingNumber(entry, ["input_per_million", "inputPricePerMillion", "input_price", "prompt_price", "input"]);
        const cacheRead = newApiRatio !== null && !isPerRequest && newApiCacheRatio !== null
          ? newApiRatio * newApiCacheRatio * 2
          : pricingNumber(entry, ["cached_input_per_million", "cache_read_per_million", "cache_read_price", "cached_input_price", "cached_input"]);
        const cacheWrite = newApiRatio !== null && !isPerRequest && newApiCreateCacheRatio !== null
          ? newApiRatio * newApiCreateCacheRatio * 2
          : pricingNumber(entry, ["cache_write_per_million", "cache_write_price", "cache_write"]);
        const output = newApiRatio !== null && !isPerRequest
          ? newApiRatio * (newApiCompletionRatio ?? 1) * 2
          : pricingNumber(entry, ["output_per_million", "outputPricePerMillion", "output_price", "completion_price", "output"]);
        if (!modelId || input === null || output === null) continue;
        const currency = typeof entry.currency === "string" && entry.currency.trim() ? entry.currency.trim().toUpperCase() : "USD";
        db.upsertPricingRule({ user_id: userId, provider_id: provider.id, model_id: modelId, input_per_million: input, cached_input_per_million: cacheRead ?? input, cache_write_per_million: cacheWrite ?? 0, output_per_million: output, currency, source: "remote", pricing_url: url.toString() });
        imported += 1;
      }
      if (imported === 0) { lastError = "接口返回的数据中没有识别到模型的 input/output token 价格"; continue; }
      return { imported, url: url.toString() };
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
  }
  throw new Error(lastError);
}

export function recordTokenUsage(db: AppDatabase, input: { userId: string; jobId: string; conversationId: string; providerId?: string | null; modelId: string; usage: TokenUsage }): void {
  const values = Object.fromEntries(Object.entries(input.usage).map(([key, value]) => [key, Math.max(0, Math.trunc(Number(value) || 0))])) as TokenUsage;
  db.addApiUsage({ id: crypto.randomUUID(), user_id: input.userId, job_id: input.jobId, conversation_id: input.conversationId, provider_id: input.providerId || BUILTIN_PROVIDER_ID, model_id: input.modelId, ...values });
}
