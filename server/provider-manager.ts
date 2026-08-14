import fs from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { AppConfig } from "./config.js";
import type { AppDatabase, ProviderModelRow, ProviderRow } from "./db.js";
import { newId } from "./paths.js";
import type { AgentModelOption, ModelReasoningEffort } from "./model-options.js";

const MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{1,80}$/i;
const DEFAULT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];

type TemplateCatalogEntry = Record<string, unknown> & {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  priority?: unknown;
  visibility?: unknown;
  input_modalities?: unknown;
  supported_reasoning_levels?: unknown;
};

export type ProviderPublic = {
  id: string;
  name: string;
  baseUrl: string;
  modelsFile: string | null;
  wireApi: ProviderRow["wire_api"];
  requiresOpenaiAuth: boolean;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyHint: string;
  extraConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ProviderModelPublic = {
  id: string;
  providerId: string;
  modelId: string;
  slug: string;
  displayName: string;
  description: string;
  reasoningEfforts: string[];
  inputModalities: string[];
  priority: number;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
};

function normalizeSlugPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+/g, "-");
  return normalized.slice(0, 40) || "provider";
}

export function nextProviderId(db: AppDatabase, name: string): string {
  const base = normalizeSlugPart(name);
  const existing = new Set(db.listProviders().map((provider) => provider.id));
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function sanitizeModelSlug(modelId: string): string {
  const normalized = modelId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[^a-z0-9]+/, "");
  const cleaned = normalized || "model";
  return cleaned.length > 81 ? cleaned.slice(0, 81) : cleaned;
}

function orderedProviders(db: AppDatabase): ProviderRow[] {
  return db.listProviders().sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}

function orderedProviderModels(db: AppDatabase): Array<ProviderModelRow & { provider_created_at: string; provider_name: string }> {
  const providers = new Map(orderedProviders(db).map((provider) => [provider.id, provider]));
  return db.listProviderModels()
    .map((model) => {
      const provider = providers.get(model.provider_id);
      return {
        ...model,
        provider_created_at: provider?.created_at ?? "",
        provider_name: provider?.name ?? "",
      };
    })
    .sort((left, right) =>
      left.provider_created_at.localeCompare(right.provider_created_at)
      || left.priority - right.priority
      || left.created_at.localeCompare(right.created_at)
      || left.id.localeCompare(right.id));
}

/**
 * Keep the aggregated catalog slug globally unique. The first model that can
 * use its upstream id keeps it; a later collision gets a source-prefixed alias.
 * Aliased entries pass the alias to the upstream on native Responses endpoints,
 * so the management UI marks them for attention.
 */
export function reassignProviderModelSlugs(db: AppDatabase): void {
  const taken = new Set<string>();
  const updates: Array<{ id: string; slug: string }> = [];
  for (const model of orderedProviderModels(db)) {
    const raw = sanitizeModelSlug(model.model_id);
    let slug = raw;
    if (taken.has(slug)) {
      const prefix = normalizeSlugPart(model.provider_name);
      const prefixed = `${prefix}-${raw}`.slice(0, 81);
      slug = taken.has(prefixed) ? `${prefix}-${model.provider_id.slice(0, 8)}-${raw}`.slice(0, 81) : prefixed;
    }
    if (!MODEL_SLUG_PATTERN.test(slug)) slug = `model-${model.provider_id.slice(0, 8)}`.slice(0, 81);
    taken.add(slug);
    if (slug !== model.slug) updates.push({ id: model.id, slug });
  }
  if (updates.length > 0) db.updateProviderModelSlugs(updates);
}

function parseStringArray(value: string | undefined, fallback: string[]): string[] {
  if (!value) return [...fallback];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [...fallback];
    const strings = parsed.filter((item): item is string => typeof item === "string");
    return strings.length > 0 ? [...new Set(strings)] : [...fallback];
  } catch {
    return [...fallback];
  }
}

function publicProvider(provider: ProviderRow): ProviderPublic {
  const key = provider.api_key ?? "";
  let extraConfig: Record<string, unknown> = {};
  try {
    const parsed = provider.extra_config ? JSON.parse(provider.extra_config) as unknown : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extraConfig = parsed as Record<string, unknown>;
  } catch {
    // Ignore malformed stored extra config.
  }
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.base_url,
    modelsFile: provider.models_file,
    wireApi: provider.wire_api,
    requiresOpenaiAuth: Boolean(provider.requires_openai_auth),
    enabled: Boolean(provider.enabled),
    hasApiKey: key.length > 0,
    apiKeyHint: key.length > 4 ? `••••${key.slice(-4)}` : "",
    extraConfig,
    createdAt: provider.created_at,
    updatedAt: provider.updated_at,
  };
}

function publicModel(model: ProviderModelRow): ProviderModelPublic {
  return {
    id: model.id,
    providerId: model.provider_id,
    modelId: model.model_id,
    slug: model.slug,
    displayName: model.display_name,
    description: model.description,
    reasoningEfforts: parseStringArray(model.reasoning_efforts, DEFAULT_REASONING_EFFORTS),
    inputModalities: parseStringArray(model.input_modalities, ["text", "image"]),
    priority: model.priority,
    visible: Boolean(model.visible),
    createdAt: model.created_at,
    updatedAt: model.updated_at,
  };
}

export function listProvidersPublic(db: AppDatabase): ProviderPublic[] {
  return db.listProviders().map(publicProvider);
}

export function listProviderModelsPublic(db: AppDatabase, providerId?: string): ProviderModelPublic[] {
  return db.listProviderModels(providerId).map(publicModel);
}

export function providerManaged(db: AppDatabase): boolean {
  return db.listProviders().length > 0;
}

export function assertOfficialOAuthLimit(db: AppDatabase, next: { id?: string; requiresOpenaiAuth?: boolean; enabled?: boolean }): void {
  if (!next.requiresOpenaiAuth && !next.enabled) return;
  const enabledOfficial = db.listEnabledProviders().filter((provider) =>
    Boolean(provider.requires_openai_auth) && provider.id !== next.id);
  const wouldEnable = next.enabled !== false && next.requiresOpenaiAuth !== false;
  if (wouldEnable && enabledOfficial.length > 0) {
    throw new Error("同一时间只能启用一个使用官方 OAuth 登录的源，请先禁用现有官方源或为该源改用 API Key。");
  }
}

function readCatalogFile(codexHome: string, fileName: string): TemplateCatalogEntry[] {
  if (fileName && (fileName.includes("/") || fileName.includes("\\") || fileName.startsWith("."))) return [];
  const candidates = fileName ? [fileName] : ["models_cache.json", "models.json"];
  for (const name of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(codexHome, name), "utf8")) as { models?: unknown };
      if (!Array.isArray(parsed.models)) continue;
      const entries = parsed.models.filter((entry): entry is TemplateCatalogEntry =>
        entry && typeof entry === "object" && !Array.isArray(entry));
      if (entries.length > 0) return entries;
    } catch {
      // Try the next catalog candidate.
    }
  }
  return [];
}

function readTemplateCatalog(codexHome: string, fileName?: string | null): TemplateCatalogEntry[] {
  return readCatalogFile(codexHome, fileName ?? "");
}

function cloneTemplateFields(template: TemplateCatalogEntry | undefined): Record<string, unknown> {
  if (!template) return {};
  const { slug: _slug, display_name: _displayName, description: _description, priority: _priority, visibility: _visibility, input_modalities: _modalities, supported_reasoning_levels: _levels, ...extra } = template;
  return extra;
}

function reasoningLevels(model: ProviderModelRow, template: TemplateCatalogEntry | undefined): unknown[] {
  const efforts = parseStringArray(model.reasoning_efforts, DEFAULT_REASONING_EFFORTS);
  const templateLevels = Array.isArray(template?.supported_reasoning_levels) ? template.supported_reasoning_levels as unknown[] : [];
  const templateByEffort = new Map<string, Record<string, unknown>>();
  for (const level of templateLevels) {
    if (!level || typeof level !== "object") continue;
    const record = level as Record<string, unknown>;
    const effort = typeof record.effort === "string" ? record.effort : "";
    if (effort) templateByEffort.set(effort, record);
  }
  return efforts.map((effort) => templateByEffort.get(effort) ?? { effort });
}

function buildCatalogEntry(model: ProviderModelRow, template: TemplateCatalogEntry | undefined): Record<string, unknown> {
  const displayName = model.display_name || model.model_id;
  return {
    slug: model.slug,
    display_name: displayName,
    description: model.description || `${model.provider_id} 提供的模型`,
    visibility: "list",
    priority: model.priority,
    input_modalities: parseStringArray(model.input_modalities, ["text", "image"]),
    supported_reasoning_levels: reasoningLevels(model, template),
    ...cloneTemplateFields(template),
  };
}

/**
 * Build the model picker options from the provider SSOT. The aggregated
 * catalog is derived from this same ordering, so the web menu and Codex's
 * models_cache.json always agree.
 */
export function listCatalogModelOptions(db: AppDatabase): AgentModelOption[] {
  if (!providerManaged(db)) return [];
  reassignProviderModelSlugs(db);
  const providers = new Map(orderedProviders(db).map((provider) => [provider.id, provider]));
  const options: AgentModelOption[] = [];
  for (const model of orderedProviderModels(db)) {
    const provider = providers.get(model.provider_id);
    if (!provider || !provider.enabled || !model.visible) continue;
    const reasoningEfforts = parseStringArray(model.reasoning_efforts, DEFAULT_REASONING_EFFORTS);
    if (reasoningEfforts.length === 0) continue;
    options.push({
      id: model.slug,
      label: model.display_name || model.model_id,
      description: model.description || `${provider.name} 提供的模型${model.slug !== model.model_id ? `（目录别名 ${model.slug}，原生透传源可能不识别）` : ""}`,
      reasoningEfforts: reasoningEfforts as ModelReasoningEffort[],
      provider: provider.id,
      providerName: provider.name,
      upstreamModel: model.model_id,
      displayName: model.display_name || model.model_id,
    });
  }
  return options;
}

function readConfigToml(codexHome: string): Record<string, unknown> {
  const file = path.join(codexHome, "config.toml");
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = parseToml(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function atomicWrite(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
  fs.renameSync(temporary, file);
}

export function writeProviderConfig(codexHome: string, db: AppDatabase): void {
  reassignProviderModelSlugs(db);
  const config = readConfigToml(codexHome);
  const rawProviders = config.model_providers;
  const managedProviders: Record<string, unknown> = rawProviders && typeof rawProviders === "object" && !Array.isArray(rawProviders)
    ? rawProviders as Record<string, unknown>
    : {};
  for (const provider of db.listProviders()) delete managedProviders[provider.id];
  const enabled = db.listEnabledProviders();
  if (providerManaged(db)) {
    const catalogPath = path.join(codexHome, "models_cache.json");
    config.model_catalog_json = catalogPath;
  }
  if (enabled.length > 0) {
    const providerEntries = enabled.map((provider) => {
      const definition: Record<string, unknown> = {
        name: provider.name,
        base_url: provider.base_url,
        wire_api: provider.wire_api,
        requires_openai_auth: Boolean(provider.requires_openai_auth),
      };
      if (provider.api_key) definition.experimental_bearer_token = provider.api_key;
      let extraConfig: Record<string, unknown> = {};
      try {
        const parsed = provider.extra_config ? JSON.parse(provider.extra_config) as unknown : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extraConfig = parsed as Record<string, unknown>;
      } catch {
        // Ignore malformed stored extra config.
      }
      for (const [key, value] of Object.entries(extraConfig)) {
        if (!(key in definition)) definition[key] = value;
      }
      return [provider.id, definition];
    });
    for (const [key, value] of Object.entries(Object.fromEntries(providerEntries))) {
      managedProviders[key] = value;
    }
    config.model_providers = managedProviders;
  } else if (Object.keys(managedProviders).length === 0) {
    delete config.model_providers;
  } else {
    config.model_providers = managedProviders;
  }
  atomicWrite(path.join(codexHome, "config.toml"), `${stringifyToml(config)}\n`, 0o600);

  const templates = readTemplateCatalog(codexHome);
  const models: Array<Record<string, unknown>> = [];
  for (const model of orderedProviderModels(db)) {
    const provider = db.getProvider(model.provider_id);
    if (!provider?.enabled || !model.visible) continue;
    const template = templates.find((entry) => entry.slug === model.model_id) ?? templates[0];
    models.push(buildCatalogEntry(model, template));
  }
  atomicWrite(path.join(codexHome, "models_cache.json"), `${JSON.stringify({ models }, null, 2)}\n`, 0o644);
}

export function importProvidersFromConfig(codexHome: string, db: AppDatabase): ProviderPublic[] {
  const config = readConfigToml(codexHome);
  const rawProviders = config.model_providers;
  if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) return listProvidersPublic(db);
  const existingNames = new Set(db.listProviders().map((provider) => provider.name.toLowerCase()));
  for (const [key, raw] of Object.entries(rawProviders)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const name = String(record.name ?? key).trim() || key;
    if (existingNames.has(name.toLowerCase())) continue;
    const baseUrl = typeof record.base_url === "string" ? record.base_url.trim() : "";
    if (!baseUrl) continue;
    const token = typeof record.experimental_bearer_token === "string" ? record.experimental_bearer_token : null;
    const wireApi = record.wire_api === "chat" || record.wire_api === "anthropic" ? record.wire_api : "responses";
    const baseKeys = new Set(["name", "base_url", "experimental_bearer_token", "wire_api", "requires_openai_auth", "models_file"]);
    const extraConfig = Object.fromEntries(Object.entries(record).filter(([entryKey]) => !baseKeys.has(entryKey)));
    db.createProvider({
      id: nextProviderId(db, name),
      name,
      baseUrl,
      apiKey: token,
      modelsFile: typeof record.models_file === "string" ? record.models_file : null,
      extraConfig,
      wireApi,
      requiresOpenaiAuth: record.requires_openai_auth === true,
      enabled: true,
    });
    existingNames.add(name.toLowerCase());
  }
  return listProvidersPublic(db);
}

export function importCatalogModels(providerId: string, codexHome: string, db: AppDatabase): ProviderModelPublic[] {
  const provider = db.getProvider(providerId);
  if (!provider) return [];
  if (provider.models_file && !fs.existsSync(path.join(codexHome, provider.models_file))) {
    throw new Error(`模型目录文件 ${provider.models_file} 不存在，请先为这个源生成模型目录。`);
  }
  const existing = new Set(db.listProviderModels(providerId).map((model) => model.model_id.toLowerCase()));
  const templates = readTemplateCatalog(codexHome, provider.models_file);
  for (const template of templates) {
    if (typeof template.slug !== "string" || !template.slug.trim()) continue;
    const modelId = template.slug;
    if (existing.has(modelId.toLowerCase())) continue;
    const inputModalities = Array.isArray(template.input_modalities)
      ? template.input_modalities.filter((modality): modality is string => typeof modality === "string" && /^(text|image)$/.test(modality))
      : ["text", "image"];
    if (!inputModalities.includes("text")) continue;
    const reasoningEfforts = Array.isArray(template.supported_reasoning_levels)
      ? template.supported_reasoning_levels
        .map((level) => level && typeof level === "object" && !Array.isArray(level) && typeof (level as Record<string, unknown>).effort === "string"
          ? (level as Record<string, unknown>).effort as string
          : typeof level === "string" ? level : "")
        .filter((effort) => /^[a-z][a-z0-9_-]{0,31}$/i.test(effort))
      : [];
    db.createProviderModel({
      id: newId(),
      providerId,
      modelId,
      slug: sanitizeModelSlug(modelId),
      displayName: typeof template.display_name === "string" ? template.display_name : modelId,
      description: typeof template.description === "string" ? template.description : "",
      reasoningEfforts: reasoningEfforts.length > 0 ? reasoningEfforts : DEFAULT_REASONING_EFFORTS,
      inputModalities,
      priority: typeof template.priority === "number" ? template.priority : 0,
      visible: template.visibility !== "hidden",
    });
    existing.add(modelId.toLowerCase());
  }
  reassignProviderModelSlugs(db);
  return listProviderModelsPublic(db, providerId);
}

export function ensureProviderConfig(config: AppConfig, codexHome: string, db: AppDatabase): void {
  if (!providerManaged(db)) return;
  try {
    writeProviderConfig(codexHome, db);
  } catch (error) {
    // Configuration generation must never prevent the service from starting;
    // the management API surfaces the failure on the next write.
    console.warn(`Provider config write failed for ${codexHome}:`, error);
  }
}
