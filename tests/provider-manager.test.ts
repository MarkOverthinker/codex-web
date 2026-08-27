import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import type { AppConfig } from "../server/config.js";
import { loadAgentOptions, resolveAgentExecutionSelection, resolveAgentSelection } from "../server/model-options.js";
import {
  assertOfficialOAuthLimit,
  importCatalogModels,
  importProvidersFromConfig,
  listCatalogModelOptions,
  listProviderModelsPublic,
  reassignProviderModelSlugs,
  writeProviderConfig,
} from "../server/provider-manager.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cww-provider-manager-"));
}

function testDb(root: string): AppDatabase {
  return new AppDatabase(root, { username: "owner", passwordHash: "$2b$10$invalid", displayName: "Owner" }, false);
}

test("legacy global providers are copied into isolated user scopes", () => {
  const root = tempRoot();
  const memberId = "11111111-1111-4111-8111-111111111111";
  const sqlite = new DatabaseSync(path.join(root, "codex-web.sqlite"));
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT,
      models_file TEXT,
      extra_config TEXT,
      wire_api TEXT NOT NULL DEFAULT 'responses',
      requires_openai_auth INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE provider_models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      reasoning_efforts TEXT NOT NULL DEFAULT '[]',
      input_modalities TEXT NOT NULL DEFAULT '["text","image"]',
      priority INTEGER NOT NULL DEFAULT 0,
      visible INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider_id, model_id)
    );
    INSERT INTO users VALUES
      ('${LEGACY_USER_ID}','owner','Owner','$2b$10$invalid','owner','active','2026-08-14T00:00:00.000Z','2026-08-14T00:00:00.000Z'),
      ('${memberId}','member','Member','$2b$10$invalid','member','active','2026-08-14T00:00:00.000Z','2026-08-14T00:00:00.000Z');
    INSERT INTO providers VALUES
      ('shared','Shared','https://shared.example.com/v1','sk-shared',NULL,NULL,'responses',0,1,'2026-08-14T00:00:00.000Z','2026-08-14T00:00:00.000Z');
    INSERT INTO provider_models VALUES
      ('model-1','shared','shared-model','shared-model','Shared Model','', '["high"]','["text"]',1,1,'2026-08-14T00:00:00.000Z','2026-08-14T00:00:00.000Z');
  `);
  sqlite.close();

  const db = testDb(root);
  assert.equal(db.getProvider(LEGACY_USER_ID, "shared")?.base_url, "https://shared.example.com/v1");
  assert.equal(db.getProvider(memberId, "shared")?.base_url, "https://shared.example.com/v1");
  assert.equal(db.getProvider(LEGACY_USER_ID, "shared")?.auto_review_model_override, null);
  assert.equal(db.listProviderModels(LEGACY_USER_ID, "shared").length, 1);
  assert.equal(db.listProviderModels(memberId, "shared").length, 1);
  assert.equal(db.getProviderManagementEnabled(LEGACY_USER_ID), true);
  assert.equal(db.getProviderManagementEnabled(memberId), true);

  db.updateProvider(memberId, "shared", { baseUrl: "https://member.example.com/v1" });
  assert.equal(db.getProvider(memberId, "shared")?.base_url, "https://member.example.com/v1");
  assert.equal(db.getProvider(LEGACY_USER_ID, "shared")?.base_url, "https://shared.example.com/v1");
  db.close();
});

test("provider management migration preserves an explicit opt-out", () => {
  const root = tempRoot();
  const db = testDb(root);
  db.createProvider({
    userId: LEGACY_USER_ID,
    id: "shared",
    name: "Shared",
    baseUrl: "https://shared.example.com/v1",
    enabled: true,
  });
  db.setProviderManagementEnabled(false, LEGACY_USER_ID);
  db.close();

  const reopened = testDb(root);
  assert.equal(reopened.getProviderManagementEnabled(LEGACY_USER_ID), false);
  reopened.close();
});

function sampleConfig(codexHome: string): void {
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    '[model_providers.deepseek]',
    'name = "deepseek"',
    'base_url = "https://api.deepseek.com/"',
    'wire_api = "responses"',
    'experimental_bearer_token = "sk-test"',
    'request_max_retries = 10',
    '[model_providers.legacy]',
    'base_url = "https://legacy.example.com/v1"',
    'wire_api = "responses"',
  ].join("\n"), "utf8");
}

function sampleCatalog(codexHome: string): void {
  fs.writeFileSync(path.join(codexHome, "models.json"), JSON.stringify({
    models: [
      {
        slug: "deepseek-v4-flash",
        display_name: "DeepSeek-V4-Flash",
        description: "Fast agent",
        visibility: "list",
        input_modalities: ["text"],
        supported_reasoning_levels: [{ effort: "low", description: "Template low" }, { effort: "high" }],
        priority: 1,
        context_window: 1000,
      },
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        description: "Official model",
        visibility: "list",
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }],
        priority: 2,
        context_window: 2000,
      },
    ],
  }, null, 2), "utf8");
}

test("provider catalog only lists enabled providers and visible models", () => {
  const root = tempRoot();
  const db = testDb(root);
  db.createProvider({ userId: LEGACY_USER_ID, id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/", modelsFile: "models.json", apiKey: "sk-a" });
  db.createProvider({ userId: LEGACY_USER_ID, id: "other", name: "Other", baseUrl: "https://other.example.com/v1", enabled: false });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m1", providerId: "deepseek", modelId: "deepseek-v4-flash", slug: "deepseek-v4-flash", displayName: "Flash", reasoningEfforts: ["low", "high"], priority: 1 });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m2", providerId: "deepseek", modelId: "hidden-model", slug: "hidden-model", displayName: "Hidden", visible: false, priority: 2 });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m3", providerId: "other", modelId: "disabled-model", slug: "disabled-model", displayName: "Disabled", priority: 1 });
  const options = listCatalogModelOptions(db, LEGACY_USER_ID);
  assert.deepEqual(options.map((model) => model.id), ["deepseek-v4-flash"]);
  assert.equal(options[0].provider, "deepseek");
  assert.equal(options[0].providerName, "DeepSeek");
  assert.equal(options[0].upstreamModel, "deepseek-v4-flash");
  db.close();
});

test("colliding model ids get unique source-prefixed catalog slugs", () => {
  const root = tempRoot();
  const db = testDb(root);
  db.createProvider({ userId: LEGACY_USER_ID, id: "official", name: "Official", baseUrl: "https://api.openai.com/v1", requiresOpenaiAuth: true });
  db.createProvider({ userId: LEGACY_USER_ID, id: "proxy", name: "Proxy", baseUrl: "https://proxy.example.com/v1", apiKey: "sk-p" });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m1", providerId: "official", modelId: "gpt-5.6-sol", slug: "gpt-5.6-sol", displayName: "Official Sol", priority: 1 });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m2", providerId: "proxy", modelId: "gpt-5.6-sol", slug: "gpt-5.6-sol", displayName: "Proxy Sol", priority: 1 });
  reassignProviderModelSlugs(db, LEGACY_USER_ID);
  const slugs = db.listProviderModels(LEGACY_USER_ID).map((model) => model.slug).sort();
  assert.deepEqual(slugs, ["gpt-5.6-sol", "proxy-gpt-5.6-sol"]);
  const options = loadAgentOptions({} as AppConfig, "", db, LEGACY_USER_ID);
  const persistedSelection = resolveAgentSelection(options, "proxy-gpt-5.6-sol", "high", "proxy");
  assert.deepEqual(persistedSelection, { model: "proxy-gpt-5.6-sol", reasoningEffort: "high", provider: "proxy", sandbox: "workspace-write" });
  assert.deepEqual(resolveAgentExecutionSelection(options, persistedSelection), {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    provider: "proxy",
    sandbox: "workspace-write",
  });
  db.close();
});

test("writeProviderConfig merges managed providers and preserves unmanaged sections", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  sampleConfig(codexHome);
  sampleCatalog(codexHome);
  fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({
    models: [{ slug: "deepseek-v4-flash", display_name: "Broken cache entry" }],
  }), "utf8");
  const db = testDb(root);
  db.createProvider({
    userId: LEGACY_USER_ID,
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/",
    modelsFile: "models.json",
    apiKey: "sk-test",
    extraConfig: { request_max_retries: 10 },
  });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m1", providerId: "deepseek", modelId: "deepseek-v4-flash", slug: "deepseek-v4-flash", displayName: "Flash", reasoningEfforts: ["low", "high"], priority: 1 });
  writeProviderConfig(codexHome, db, LEGACY_USER_ID);

  const config = parseToml(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")) as Record<string, any>;
  assert.equal(config.model_provider, "deepseek");
  assert.ok(config.model_providers.deepseek);
  assert.equal(config.model_providers.deepseek.name, "DeepSeek");
  assert.equal(config.model_providers.deepseek.base_url, "https://api.deepseek.com/");
  assert.equal(config.model_providers.deepseek.experimental_bearer_token, "sk-test");
  assert.equal(config.model_providers.deepseek.models_file, "models.json");
  assert.equal(config.model_providers.deepseek.request_max_retries, 10);
  assert.ok(config.model_providers.legacy, "unmanaged provider section must stay");
  assert.equal(config.model_catalog_json, path.join(codexHome, "models_cache.json"));

  const catalog = JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8")) as { models: Array<Record<string, unknown>> };
  assert.deepEqual(catalog.models.map((model) => model.slug), ["deepseek-v4-flash"]);
  assert.equal(typeof catalog.models[0].display_name, "string");
  assert.ok(catalog.models[0].display_name);
  assert.equal(typeof catalog.models[0].description, "string");
  assert.ok(catalog.models[0].description);
  assert.equal(catalog.models[0].visibility, "list");
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "high", description: "Extra high reasoning depth for complex problems" },
  ]);
  assert.equal(catalog.models[0].shell_type, "shell_command");
  assert.equal(catalog.models[0].context_window, 1_048_576, "bundled DeepSeek template is used");
  assert.ok(String(catalog.models[0].base_instructions).length > 1_000, "complete bundled instructions are preserved");
  db.close();
});

test("provider auto review model override is applied per source and falls back to the template default", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  const db = testDb(root);
  db.createProvider({
    userId: LEGACY_USER_ID,
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/",
    autoReviewModelOverride: "gpt-5.6-terra",
  });
  db.createProvider({ userId: LEGACY_USER_ID, id: "other", name: "Other", baseUrl: "https://other.example.com/v1" });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m1", providerId: "deepseek", modelId: "deepseek-v4-flash", slug: "deepseek-v4-flash", displayName: "Flash", priority: 1 });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m2", providerId: "other", modelId: "bare-model", slug: "bare-model", displayName: "Bare", priority: 1 });
  writeProviderConfig(codexHome, db, LEGACY_USER_ID);
  const catalog = JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8")) as { models: Array<Record<string, unknown>> };
  const bySlug = new Map(catalog.models.map((model) => [model.slug, model]));
  assert.equal(bySlug.get("deepseek-v4-flash")?.auto_review_model_override, "gpt-5.6-terra");
  assert.equal(bySlug.get("bare-model")?.auto_review_model_override, null, "unspecified source keeps the template default");

  db.updateProvider(LEGACY_USER_ID, "deepseek", { autoReviewModelOverride: null });
  writeProviderConfig(codexHome, db, LEGACY_USER_ID);
  const updated = JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8")) as { models: Array<Record<string, unknown>> };
  assert.equal(updated.models.find((model) => model.slug === "deepseek-v4-flash")?.auto_review_model_override, null);
  db.close();
});

test("importProvidersFromConfig reads a provider-level auto_review_model_override", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    '[model_providers.deepseek]',
    'name = "DeepSeek"',
    'base_url = "https://api.deepseek.com/"',
    'auto_review_model_override = "gpt-5.6-terra"',
  ].join("\n"), "utf8");
  const db = testDb(root);
  importProvidersFromConfig(codexHome, db, LEGACY_USER_ID);
  assert.equal(db.getProvider(LEGACY_USER_ID, "deepseek")?.auto_review_model_override, "gpt-5.6-terra");
  assert.deepEqual(db.getProvider(LEGACY_USER_ID, "deepseek")?.extra_config, "{}", "override is not duplicated into extra config");
  db.close();
});

test("aggregated catalog carries Codex-required fields even when templates omit description", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "models.json"), JSON.stringify({
    models: [
      {
        slug: "bare-model",
        display_name: "Bare Model",
        visibility: "list",
        input_modalities: ["text"],
        supported_reasoning_levels: [{ effort: "high" }],
      },
    ],
  }, null, 2), "utf8");
  const db = testDb(root);
  db.createProvider({ userId: LEGACY_USER_ID, id: "bare", name: "Bare", baseUrl: "https://bare.example.com/v1", modelsFile: "models.json" });
  importCatalogModels("bare", codexHome, db, LEGACY_USER_ID);
  writeProviderConfig(codexHome, db, LEGACY_USER_ID);
  const catalog = JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8")) as { models: Array<Record<string, unknown>> };
  assert.equal(catalog.models.length, 1);
  for (const field of ["slug", "display_name", "description"]) {
    assert.equal(typeof catalog.models[0][field], "string", `${field} must be a string`);
    assert.ok(catalog.models[0][field], `${field} must not be empty`);
  }
  assert.equal(catalog.models[0].shell_type, "default");
  assert.equal(catalog.models[0].supported_in_api, true);
  assert.ok(String(catalog.models[0].base_instructions).length > 1_000);
  assert.equal(catalog.models[0].support_verbosity, false);
  assert.equal(catalog.models[0].default_verbosity, null);
  assert.equal(catalog.models[0].apply_patch_tool_type, null);
  assert.deepEqual(catalog.models[0].truncation_policy, { mode: "bytes", limit: 10_000 });
  assert.equal(catalog.models[0].supports_parallel_tool_calls, false);
  assert.deepEqual(catalog.models[0].experimental_supported_tools, []);
  assert.equal(catalog.models[0].context_window, 272_000);
  const reasoningLevels = catalog.models[0].supported_reasoning_levels as Array<Record<string, unknown>>;
  assert.deepEqual(reasoningLevels, [{ effort: "high", description: "Deeper reasoning for complex tasks" }]);
  db.close();
});

test("aggregated catalog matches bundled model templates by longest upstream prefix", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  const db = testDb(root);
  db.createProvider({ userId: LEGACY_USER_ID, id: "proxy", name: "Proxy", baseUrl: "https://proxy.example.com/v1" });
  db.createProviderModel({
    userId: LEGACY_USER_ID,
    id: "m1",
    providerId: "proxy",
    modelId: "gpt-5.6-sol-custom",
    slug: "gpt-5.6-sol-custom",
    displayName: "Custom Sol",
    reasoningEfforts: ["low", "high"],
  });
  writeProviderConfig(codexHome, db, LEGACY_USER_ID);
  const catalog = JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8")) as { models: Array<Record<string, unknown>> };
  assert.equal(catalog.models[0].shell_type, "shell_command");
  assert.equal(catalog.models[0].supported_in_api, true);
  assert.ok(String(catalog.models[0].base_instructions).length > 1_000);
  assert.equal(catalog.models[0].support_verbosity, true);
  assert.deepEqual(catalog.models[0].truncation_policy, { mode: "tokens", limit: 10_000 });
  assert.equal(catalog.models[0].supports_parallel_tool_calls, true);
  assert.equal(catalog.models[0].context_window, 272_000);
  assert.equal(catalog.models[0].tool_mode, "code_mode_only");
  db.close();
});

test("writeProviderConfig accepts a host owner without failing when not root", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  sampleConfig(codexHome);
  const db = testDb(root);
  db.createProvider({ userId: LEGACY_USER_ID, id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/" });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m1", providerId: "deepseek", modelId: "deepseek-v4-flash", slug: "deepseek-v4-flash", displayName: "Flash", priority: 1 });
  assert.doesNotThrow(() => writeProviderConfig(codexHome, db, LEGACY_USER_ID, { uid: 12345, gid: 12345 }));
  if (process.getuid?.() === 0) {
    const configStat = fs.statSync(path.join(codexHome, "config.toml"));
    const catalogStat = fs.statSync(path.join(codexHome, "models_cache.json"));
    assert.equal(configStat.uid, 12345);
    assert.equal(catalogStat.uid, 12345);
  }
  db.close();
});

test("disabling a provider removes its section and catalog entries", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  sampleConfig(codexHome);
  const db = testDb(root);
  db.createProvider({ userId: LEGACY_USER_ID, id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/", apiKey: "sk-test" });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m1", providerId: "deepseek", modelId: "deepseek-v4-flash", slug: "deepseek-v4-flash", displayName: "Flash", priority: 1 });
  writeProviderConfig(codexHome, db, LEGACY_USER_ID);
  db.updateProvider(LEGACY_USER_ID, "deepseek", { enabled: false });
  writeProviderConfig(codexHome, db, LEGACY_USER_ID);
  const config = parseToml(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")) as Record<string, any>;
  assert.ok(!config.model_providers?.deepseek);
  assert.ok(config.model_providers?.legacy);
  const catalog = JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8")) as { models: unknown[] };
  assert.deepEqual(catalog.models, []);
  db.close();
});

test("official OAuth limit allows one enabled official source only", () => {
  const root = tempRoot();
  const db = testDb(root);
  db.createProvider({ userId: LEGACY_USER_ID, id: "official", name: "Official", baseUrl: "https://api.openai.com/v1", requiresOpenaiAuth: true });
  assert.throws(() => assertOfficialOAuthLimit(db, LEGACY_USER_ID, { requiresOpenaiAuth: true, enabled: true }), /同一时间只能启用一个/);
  assert.doesNotThrow(() => assertOfficialOAuthLimit(db, LEGACY_USER_ID, { id: "official", requiresOpenaiAuth: true, enabled: true }));
  assert.doesNotThrow(() => assertOfficialOAuthLimit(db, LEGACY_USER_ID, { requiresOpenaiAuth: false, enabled: true }));
  db.close();
});

test("loadAgentOptions prefers the provider SSOT when providers exist", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  sampleCatalog(codexHome);
  const db = testDb(root);
  const config = { codexHome } as unknown as AppConfig;
  const before = loadAgentOptions(config, codexHome);
  assert.ok(before.models.some((model) => model.id === "gpt-5.6-sol"));
  db.createProvider({ userId: LEGACY_USER_ID, id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/" });
  db.createProvider({ userId: LEGACY_USER_ID, id: "disabled", name: "Disabled", baseUrl: "https://disabled.example.com/", enabled: false });
  db.createProviderModel({ userId: LEGACY_USER_ID, id: "m1", providerId: "deepseek", modelId: "deepseek-v4-flash", slug: "deepseek-v4-flash", displayName: "Flash", priority: 1 });
  const after = loadAgentOptions(config, codexHome, db, LEGACY_USER_ID);
  assert.deepEqual(after.providers, [{ id: "deepseek", name: "DeepSeek" }]);
  assert.deepEqual(after.models.map((model) => model.id), ["deepseek-v4-flash"]);
  assert.equal(after.defaults.provider, "deepseek");
  db.close();
});

test("importCatalogModels imports provider-specific model files", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  sampleCatalog(codexHome);
  const db = testDb(root);
  db.createProvider({ userId: LEGACY_USER_ID, id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/", modelsFile: "models.json" });
  const imported = importCatalogModels("deepseek", codexHome, db, LEGACY_USER_ID);
  assert.deepEqual(imported.map((model) => model.modelId).sort(), ["deepseek-v4-flash", "gpt-5.6-sol"]);
  assert.equal(imported[0].inputModalities.join(","), "text");
  assert.equal(imported.find((model) => model.modelId === "gpt-5.6-sol")?.inputModalities.join(","), "text,image");
  assert.deepEqual(listProviderModelsPublic(db, LEGACY_USER_ID, "deepseek").map((model) => model.slug).sort(), ["deepseek-v4-flash", "gpt-5.6-sol"]);
  importCatalogModels("deepseek", codexHome, db, LEGACY_USER_ID);
  assert.equal(db.listProviderModels(LEGACY_USER_ID, "deepseek").length, 2, "re-import skips existing models");
  db.close();
});
