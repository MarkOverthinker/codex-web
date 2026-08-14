import fs from "node:fs";
import path from "node:path";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import type { AppConfig } from "./config.js";
import { LEGACY_USER_ID, type AppDatabase } from "./db.js";
import { listCatalogModelOptions, providerManaged } from "./provider-manager.js";

export type { ModelReasoningEffort } from "@openai/codex-sdk";

export type AgentModelOption = {
  id: string;
  label: string;
  description: string;
  reasoningEfforts: ModelReasoningEffort[];
  provider?: string;
  providerName?: string;
  upstreamModel?: string;
  displayName?: string;
};

export type AgentOptions = {
  models: AgentModelOption[];
  reasoningEfforts: Array<{ id: ModelReasoningEffort; label: string }>;
  defaults: { model: string; reasoningEffort: ModelReasoningEffort; provider?: string | null };
};

export type AgentSelection = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  provider?: string | null;
};

type CatalogModel = {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  priority?: unknown;
  visibility?: unknown;
  input_modalities?: unknown;
  supported_reasoning_levels?: unknown;
};

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_LABELS: Record<string, string> = {
  none: "无",
  minimal: "最低",
  low: "较低",
  medium: "中等",
  high: "高",
  xhigh: "极高",
  max: "最大",
};
const DEFAULT_REASONING_EFFORT = "xhigh" as ModelReasoningEffort;

const FALLBACK_MODELS: AgentModelOption[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "最新旗舰 Agent 模型",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    description: "速度与能力均衡",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6-Luna",
    description: "更快、更节省",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
];

function reasoningEfforts(value: unknown): ModelReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const efforts = value.flatMap((item): ModelReasoningEffort[] => {
    const effort = typeof item === "string"
      ? item
      : item && typeof item === "object" && "effort" in item ? String(item.effort) : "";
    return /^[a-z][a-z0-9_-]{0,31}$/i.test(effort) ? [effort as ModelReasoningEffort] : [];
  });
  return orderedEfforts(efforts);
}

function orderedEfforts(efforts: ModelReasoningEffort[]): ModelReasoningEffort[] {
  const unique = [...new Set(efforts)];
  const known = EFFORT_ORDER.filter((effort) => unique.includes(effort as ModelReasoningEffort)) as ModelReasoningEffort[];
  return [...known, ...unique.filter((effort) => !(EFFORT_ORDER as readonly string[]).includes(effort))];
}

function catalogModels(config: AppConfig, codexHome = config.codexHome): AgentModelOption[] {
  const candidates = ["models_cache.json", "models.json"];
  for (const name of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(codexHome, name), "utf8")) as { models?: CatalogModel[] };
      if (!Array.isArray(parsed.models)) continue;
      return parsed.models
        .filter((model) => model.visibility === "list")
        .filter((model) => Array.isArray(model.input_modalities) && model.input_modalities.some((modality) => modality === "text" || modality === "image"))
        .map((model) => ({
          id: typeof model.slug === "string" ? model.slug : "",
          label: typeof model.display_name === "string" ? model.display_name : String(model.slug ?? ""),
          description: typeof model.description === "string" ? model.description : "",
          reasoningEfforts: reasoningEfforts(model.supported_reasoning_levels),
          priority: typeof model.priority === "number" ? model.priority : Number.MAX_SAFE_INTEGER,
        }))
        .filter((model) => /^[a-z0-9][a-z0-9._-]{1,80}$/i.test(model.id) && model.reasoningEfforts.length > 0)
        .sort((left, right) => left.priority - right.priority)
        .map(({ priority: _priority, ...model }) => model);
    } catch {
      // Try the next catalog candidate; fall back to built-in models when none parse.
    }
  }
  return [];
}

function strongestModel(models: AgentModelOption[]): string {
  const versionOf = (id: string) => {
    const match = /^gpt-(\d+)\.(\d+)/i.exec(id);
    return match ? { major: Number(match[1]), minor: Number(match[2]) } : { major: 0, minor: 0 };
  };
  const future = models
    .map((model, index) => ({ model, index, ...versionOf(model.id) }))
    .filter((entry) => entry.major > 5 || (entry.major === 5 && entry.minor > 6))
    .sort((left, right) => right.major - left.major || right.minor - left.minor || left.index - right.index);
  if (future.length > 0) return future[0].model.id;
  const preferred = ["gpt-5.6-sol", "gpt-5.6", "gpt-5.5", "gpt-5.4"];
  return preferred.find((id) => models.some((model) => model.id === id)) ?? models[0].id;
}

export function loadAgentOptions(config: AppConfig, codexHome = config.codexHome, db?: AppDatabase, userId = LEGACY_USER_ID): AgentOptions {
  const models = db && providerManaged(db, userId)
    ? listCatalogModelOptions(db, userId)
    : catalogModels(config, codexHome);
  const available = models.length > 0 ? models : FALLBACK_MODELS;
  const defaultModel = strongestModel(available);
  const defaultOption = available.find((model) => model.id === defaultModel)!;
  const defaultReasoning = defaultOption.reasoningEfforts.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : defaultOption.reasoningEfforts.at(-1)!;
  const offeredEfforts = orderedEfforts(available.flatMap((model) => model.reasoningEfforts));
  const defaults: AgentOptions["defaults"] = { model: defaultModel, reasoningEffort: defaultReasoning };
  if (defaultOption.provider) defaults.provider = defaultOption.provider;
  return {
    models: available,
    reasoningEfforts: offeredEfforts.map((id) => ({ id, label: EFFORT_LABELS[id] ?? id })),
    defaults,
  };
}

export function resolveAgentSelection(options: AgentOptions, rawModel: unknown, rawEffort: unknown, rawProvider?: unknown): AgentSelection {
  const requestedModel = typeof rawModel === "string" ? rawModel.trim() : "";
  const modelId = requestedModel || options.defaults.model;
  const model = options.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error("所选模型当前不可用，请刷新页面后重试。");

  const requestedEffort = typeof rawEffort === "string" ? rawEffort.trim() : "";
  const effort = (requestedEffort || options.defaults.reasoningEffort) as ModelReasoningEffort;
  if (!model.reasoningEfforts.includes(effort)) {
    throw new Error("所选思考深度不受该模型支持，请重新选择。");
  }
  const provider = model.provider ?? null;
  if (rawProvider !== undefined && rawProvider !== null && rawProvider !== "") {
    const requestedProvider = String(rawProvider).trim();
    if (provider && requestedProvider !== provider) {
      throw new Error("所选模型与源不匹配，请刷新页面后重试。");
    }
  }
  return { model: model.id, reasoningEffort: effort, ...(provider ? { provider } : {}) };
}

export function repairAgentSelection(options: AgentOptions, rawModel: unknown, rawEffort: unknown): AgentSelection {
  const modelId = typeof rawModel === "string" ? rawModel.trim() : "";
  const model = options.models.find((candidate) => candidate.id === modelId);
  if (!model) return { ...options.defaults };
  const effort = typeof rawEffort === "string" ? rawEffort.trim() as ModelReasoningEffort : undefined;
  const selection: AgentSelection = {
    model: model.id,
    reasoningEffort: effort && model.reasoningEfforts.includes(effort)
      ? effort
      : model.reasoningEfforts.at(-1)!,
  };
  if (model.provider) selection.provider = model.provider;
  return selection;
}

export function resolveAgentExecutionSelection(options: AgentOptions, selection: AgentSelection): AgentSelection {
  const model = options.models.find((candidate) => candidate.id === selection.model);
  if (!model) throw new Error("所选模型当前不可用，请刷新页面后重试。");
  if (model.provider && selection.provider !== model.provider) {
    throw new Error("所选模型与源不匹配，请刷新页面后重试。");
  }
  return {
    ...selection,
    model: model.upstreamModel || model.id,
  };
}
