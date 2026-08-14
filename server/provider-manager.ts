import fs from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import modelCatalogTemplateLibraryJson from "./model-catalog-templates.json" with { type: "json" };
import type { AppConfig } from "./config.js";
import type { AppDatabase, ProviderModelRow, ProviderRow } from "./db.js";
import { newId } from "./paths.js";
import type { AgentModelOption, ModelReasoningEffort } from "./model-options.js";

const MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{1,80}$/i;
const DEFAULT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const DEFAULT_REASONING_DESCRIPTIONS: Record<string, string> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balanced reasoning depth for everyday tasks",
  high: "Deeper reasoning for complex tasks",
  xhigh: "Extra-high reasoning depth for difficult tasks",
  max: "Maximum reasoning depth for the hardest tasks",
  ultra: "Ultra reasoning depth for exceptional tasks",
};
const CODEX_SHELL_TYPES = new Set(["default", "local", "unified_exec", "disabled", "shell_command"]);
const CODEX_TRUNCATION_MODES = new Set(["bytes", "tokens"]);

type TemplateCatalogEntry = Record<string, unknown> & {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  priority?: unknown;
  visibility?: unknown;
  input_modalities?: unknown;
  supported_reasoning_levels?: unknown;
};

type ModelCatalogTemplateLibrary = {
  schema_version: number;
  codex_version: string;
  fallback: TemplateCatalogEntry;
  models: TemplateCatalogEntry[];
};

const MODEL_CATALOG_TEMPLATE_LIBRARY = modelCatalogTemplateLibraryJson as unknown as ModelCatalogTemplateLibrary;

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

export function nextProviderId(db: AppDatabase, userId: string, name: string): string {
  const base = normalizeSlugPart(name);
  const existing = new Set(db.listProviders(userId).map((provider) => provider.id));
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

function orderedProviders(db: AppDatabase, userId: string): ProviderRow[] {
  return db.listProviders(userId).sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}

function orderedProviderModels(db: AppDatabase, userId: string): Array<ProviderModelRow & { provider_created_at: string; provider_name: string }> {
  const providers = new Map(orderedProviders(db, userId).map((provider) => [provider.id, provider]));
  return db.listProviderModels(userId)
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
 * The web selection persists this alias, then resolves it back to model_id at
 * the execution boundary before calling the selected provider.
 */
export function reassignProviderModelSlugs(db: AppDatabase, userId: string): void {
  const taken = new Set<string>();
  const updates: Array<{ id: string; slug: string }> = [];
  for (const model of orderedProviderModels(db, userId)) {
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
  if (updates.length > 0) db.updateProviderModelSlugs(userId, updates);
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

export function listProvidersPublic(db: AppDatabase, userId: string): ProviderPublic[] {
  return db.listProviders(userId).map(publicProvider);
}

export function listProviderModelsPublic(db: AppDatabase, userId: string, providerId?: string): ProviderModelPublic[] {
  return db.listProviderModels(userId, providerId).map(publicModel);
}

export function providerManaged(db: AppDatabase, userId: string): boolean {
  return db.listProviders(userId).length > 0;
}

export function assertOfficialOAuthLimit(db: AppDatabase, userId: string, next: { id?: string; requiresOpenaiAuth?: boolean; enabled?: boolean }): void {
  if (!next.requiresOpenaiAuth && !next.enabled) return;
  const enabledOfficial = db.listEnabledProviders(userId).filter((provider) =>
    Boolean(provider.requires_openai_auth) && provider.id !== next.id);
  const wouldEnable = next.enabled !== false && next.requiresOpenaiAuth !== false;
  if (wouldEnable && enabledOfficial.length > 0) {
    throw new Error("同一时间只能启用一个使用官方 OAuth 登录的源，请先禁用现有官方源或为该源改用 API Key。");
  }
}

function readCatalogFile(codexHome: string, fileName: string): TemplateCatalogEntry[] {
  if (fileName && !safeCatalogFileName(fileName)) return [];
  if (!fileName) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(codexHome, fileName), "utf8")) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return [];
    return parsed.models.filter((entry): entry is TemplateCatalogEntry =>
      entry && typeof entry === "object" && !Array.isArray(entry));
  } catch {
    return [];
  }
}

function safeCatalogFileName(value: string): boolean {
  return Boolean(value.trim()) && !value.includes("/") && !value.includes("\\") && !value.startsWith(".");
}

function cloneTemplateFields(template: TemplateCatalogEntry | undefined): Record<string, unknown> {
  if (!template) return {};
  const { slug: _slug, display_name: _displayName, description: _description, priority: _priority, visibility: _visibility, input_modalities: _modalities, supported_reasoning_levels: _levels, ...extra } = template;
  return extra;
}

function catalogTemplateForModel(modelId: string): TemplateCatalogEntry {
  const normalized = modelId.trim().toLowerCase();
  const suffix = normalized.includes("/") ? normalized.slice(normalized.indexOf("/") + 1) : normalized;
  let matched: TemplateCatalogEntry | undefined;
  let matchedLength = -1;
  for (const template of MODEL_CATALOG_TEMPLATE_LIBRARY.models) {
    const slug = typeof template.slug === "string" ? template.slug.trim().toLowerCase() : "";
    if (!slug) continue;
    if (normalized !== slug && !normalized.startsWith(slug) && suffix !== slug && !suffix.startsWith(slug)) continue;
    if (slug.length > matchedLength) {
      matched = template;
      matchedLength = slug.length;
    }
  }
  return matched ?? MODEL_CATALOG_TEMPLATE_LIBRARY.fallback;
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
  return efforts.map((effort) => {
    const templateLevel = templateByEffort.get(effort);
    const templateDescription = typeof templateLevel?.description === "string"
      ? templateLevel.description.trim()
      : "";
    return {
      ...templateLevel,
      effort,
      description: templateDescription || DEFAULT_REASONING_DESCRIPTIONS[effort] || `${effort} reasoning effort`,
    };
  });
}

function buildCatalogEntry(model: ProviderModelRow, template: TemplateCatalogEntry | undefined): Record<string, unknown> {
  const displayName = String(model.display_name || model.model_id);
  const description = String(model.description || `${model.provider_id} 提供的模型`);
  return {
    ...cloneTemplateFields(template),
    slug: model.slug,
    display_name: displayName,
    description,
    visibility: "list",
    priority: model.priority,
    input_modalities: parseStringArray(model.input_modalities, ["text", "image"]),
    supported_reasoning_levels: reasoningLevels(model, template),
  };
}

/**
 * Codex's model catalog parser requires every entry to carry these fields.
 * Fail loudly here instead of writing a cache file the CLI cannot load.
 */
function assertCatalogEntries(models: Array<Record<string, unknown>>): void {
  for (const entry of models) {
    for (const field of ["slug", "display_name", "description"] as const) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        throw new Error(`Generated model catalog entry is missing required field "${field}"`);
      }
    }
    if (!Array.isArray(entry.supported_reasoning_levels)) {
      throw new Error("Generated model catalog entry is missing required field \"supported_reasoning_levels\"");
    }
    if (typeof entry.shell_type !== "string" || !CODEX_SHELL_TYPES.has(entry.shell_type)) {
      throw new Error("Generated model catalog entry has invalid required field \"shell_type\"");
    }
    for (const field of ["supported_in_api", "support_verbosity", "supports_parallel_tool_calls"] as const) {
      if (typeof entry[field] !== "boolean") {
        throw new Error(`Generated model catalog entry is missing required field "${field}"`);
      }
    }
    if (typeof entry.base_instructions !== "string") {
      throw new Error("Generated model catalog entry is missing required field \"base_instructions\"");
    }
    if (!Array.isArray(entry.experimental_supported_tools)
      || entry.experimental_supported_tools.some((tool) => typeof tool !== "string")) {
      throw new Error("Generated model catalog entry has invalid required field \"experimental_supported_tools\"");
    }
    const truncationPolicy = entry.truncation_policy;
    if (!truncationPolicy || typeof truncationPolicy !== "object" || Array.isArray(truncationPolicy)) {
      throw new Error("Generated model catalog entry is missing required field \"truncation_policy\"");
    }
    const truncationRecord = truncationPolicy as Record<string, unknown>;
    if (typeof truncationRecord.mode !== "string"
      || !CODEX_TRUNCATION_MODES.has(truncationRecord.mode)
      || !Number.isSafeInteger(truncationRecord.limit)
      || Number(truncationRecord.limit) <= 0) {
      throw new Error("Generated model catalog entry has invalid required field \"truncation_policy\"");
    }
    for (const [index, level] of entry.supported_reasoning_levels.entries()) {
      if (!level || typeof level !== "object" || Array.isArray(level)) {
        throw new Error(`Generated model catalog reasoning level ${index} is invalid`);
      }
      const record = level as Record<string, unknown>;
      for (const field of ["effort", "description"] as const) {
        if (typeof record[field] !== "string" || !record[field].trim()) {
          throw new Error(`Generated model catalog reasoning level ${index} is missing required field "${field}"`);
        }
      }
    }
  }
}

/**
 * Build the model picker options from the provider SSOT. The aggregated
 * catalog is derived from this same ordering, so the web menu and Codex's
 * models_cache.json always agree.
 */
export function listCatalogModelOptions(db: AppDatabase, userId: string): AgentModelOption[] {
  if (!providerManaged(db, userId)) return [];
  reassignProviderModelSlugs(db, userId);
  const providers = new Map(orderedProviders(db, userId).map((provider) => [provider.id, provider]));
  const options: AgentModelOption[] = [];
  for (const model of orderedProviderModels(db, userId)) {
    const provider = providers.get(model.provider_id);
    if (!provider || !provider.enabled || !model.visible) continue;
    const reasoningEfforts = parseStringArray(model.reasoning_efforts, DEFAULT_REASONING_EFFORTS);
    if (reasoningEfforts.length === 0) continue;
    options.push({
      id: model.slug,
      label: model.display_name || model.model_id,
      description: model.description || `${provider.name} 提供的模型`,
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

/**
 * Keep the host user's Codex home traversable after the root web service has
 * written managed files. The CLI is started after dropping to the tenant UID,
 * so fixing only the files is insufficient when an earlier run made the
 * directory root-owned or removed its execute bit.
 */
export function repairCodexHomeOwnership(
  codexHome: string,
  owner: { uid: number; gid: number } | undefined,
): void {
  if (!owner) return;
  // Only the root host-mode service can repair another identity's Codex home.
  // A rootless process must not turn a read-only or user-managed home into a
  // startup warning; its normal file modes are already sufficient.
  if (process.getuid?.() !== 0) return;
  try {
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    // A Codex home contains credentials; do not leave it world-readable or
    // writable as a side effect of a previous `chmod 777` workaround.
    fs.chmodSync(codexHome, 0o700);
  } catch (error) {
    console.warn(`Failed to prepare Codex home ${codexHome}:`, error);
  }
  try {
    fs.chownSync(codexHome, owner.uid, owner.gid);
  } catch (error) {
    console.warn(`Failed to set ownership on ${codexHome}:`, error);
  }
}

function applyCodexHomeOwnership(
  files: Array<{ file: string; mode: number }>,
  owner: { uid: number; gid: number } | undefined,
): void {
  if (!owner || process.getuid?.() !== 0) return;
  for (const { file, mode } of files) {
    try {
      fs.chmodSync(file, mode);
      fs.chownSync(file, owner.uid, owner.gid);
    } catch (error) {
      console.warn(`Failed to set ownership or permissions on ${file}:`, error);
    }
  }
}

export function writeProviderConfig(codexHome: string, db: AppDatabase, userId: string, owner?: { uid: number; gid: number }): void {
  repairCodexHomeOwnership(codexHome, owner);
  reassignProviderModelSlugs(db, userId);
  const config = readConfigToml(codexHome);
  const rawProviders = config.model_providers;
  const managedProviders: Record<string, unknown> = rawProviders && typeof rawProviders === "object" && !Array.isArray(rawProviders)
    ? rawProviders as Record<string, unknown>
    : {};
  for (const provider of db.listProviders(userId)) delete managedProviders[provider.id];
  const enabled = db.listEnabledProviders(userId);
  const configTomlPath = path.join(codexHome, "config.toml");
  if (providerManaged(db, userId)) {
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
      if (provider.models_file && safeCatalogFileName(provider.models_file)) definition.models_file = provider.models_file;
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
  const models: Array<Record<string, unknown>> = [];
  for (const model of orderedProviderModels(db, userId)) {
    const provider = db.getProvider(userId, model.provider_id);
    if (!provider?.enabled || !model.visible) continue;
    const template = catalogTemplateForModel(model.model_id);
    models.push(buildCatalogEntry(model, template));
  }
  assertCatalogEntries(models);
  const catalogPath = path.join(codexHome, "models_cache.json");

  // Validate the complete catalog before replacing either file. A failed
  // generation must not leave config.toml pointing at an older, malformed
  // cache after the provider settings have already been updated.
  atomicWrite(configTomlPath, `${stringifyToml(config)}\n`, 0o600);
  atomicWrite(catalogPath, `${JSON.stringify({ models }, null, 2)}\n`, 0o644);
  applyCodexHomeOwnership([
    { file: configTomlPath, mode: 0o600 },
    { file: catalogPath, mode: 0o644 },
  ], owner);
}

export function importProvidersFromConfig(codexHome: string, db: AppDatabase, userId: string): ProviderPublic[] {
  const config = readConfigToml(codexHome);
  const rawProviders = config.model_providers;
  if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) return listProvidersPublic(db, userId);
  const existingNames = new Set(db.listProviders(userId).map((provider) => provider.name.toLowerCase()));
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
      userId,
      id: nextProviderId(db, userId, name),
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
  return listProvidersPublic(db, userId);
}

export function importCatalogModels(providerId: string, codexHome: string, db: AppDatabase, userId: string): ProviderModelPublic[] {
  const provider = db.getProvider(userId, providerId);
  if (!provider) return [];
  if (provider.models_file && !fs.existsSync(path.join(codexHome, provider.models_file))) {
    throw new Error(`模型目录文件 ${provider.models_file} 不存在，请先为这个源生成模型目录。`);
  }
  const existing = new Set(db.listProviderModels(userId, providerId).map((model) => model.model_id.toLowerCase()));
  const templates = readCatalogFile(codexHome, provider.models_file ?? "");
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
      userId,
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
  reassignProviderModelSlugs(db, userId);
  return listProviderModelsPublic(db, userId, providerId);
}

export function ensureProviderConfig(config: AppConfig, codexHome: string, db: AppDatabase, userId: string, owner?: { uid: number; gid: number }): void {
  repairCodexHomeOwnership(codexHome, owner);
  if (!providerManaged(db, userId)) return;
  try {
    writeProviderConfig(codexHome, db, userId, owner);
  } catch (error) {
    // Configuration generation must never prevent the service from starting;
    // the management API surfaces the failure on the next write.
    console.warn(`Provider config write failed for ${codexHome}:`, error);
  }
}
