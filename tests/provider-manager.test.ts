import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { AppDatabase } from "../server/db.js";
import type { AppConfig } from "../server/config.js";
import { loadAgentOptions } from "../server/model-options.js";
import {
  assertOfficialOAuthLimit,
  importCatalogModels,
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
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
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
  db.createProvider({ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/", modelsFile: "models.json", apiKey: "sk-a" });
  db.createProvider({ id: "other", name: "Other", baseUrl: "https://other.example.com/v1", enabled: false });
  db.createProviderModel({ id: "m1", providerId: "deepseek", modelId: "deepseek-v4-flash", slug: "deepseek-v4-flash", displayName: "Flash", reasoningEfforts: ["low", "high"], priority: 1 });
  db.createProviderModel({ id: "m2", providerId: "deepseek", modelId: "hidden-model", slug: "hidden-model", displayName: "Hidden", visible: false, priority: 2 });
  db.createProviderModel({ id: "m3", providerId: "other", modelId: "disabled-model", slug: "disabled-model", displayName: "Disabled", priority: 1 });
  const options = listCatalogModelOptions(db);
  assert.deepEqual(options.map((model) => model.id), ["deepseek-v4-flash"]);
  assert.equal(options[0].provider, "deepseek");
  assert.equal(options[0].providerName, "DeepSeek");
  assert.equal(options[0].upstreamModel, "deepseek-v4-flash");
  db.close();
});

test("colliding model ids get unique source-prefixed catalog slugs", () => {
  const root = tempRoot();
  const db = testDb(root);
  db.createProvider({ id: "official", name: "Official", baseUrl: "https://api.openai.com/v1", requiresOpenaiAuth: true });
  db.createProvider({ id: "proxy", name: "Proxy", baseUrl: "https://proxy.example.com/v1", apiKey: "sk-p" });
  db.createProviderModel({ id: "m1", providerId: "official", modelId: "gpt-5.6-sol", slug: "gpt-5.6-sol", displayName: "Official Sol", priority: 1 });
  db.createProviderModel({ id: "m2", providerId: "proxy", modelId: "gpt-5.6-sol", slug: "gpt-5.6-sol", displayName: "Proxy Sol", priority: 1 });
  reassignProviderModelSlugs(db);
  const slugs = db.listProviderModels().map((model) => model.slug).sort();
  assert.deepEqual(slugs, ["gpt-5.6-sol", "proxy-gpt-5.6-sol"]);
  db.close();
});

test("writeProviderConfig merges managed providers and preserves unmanaged sections", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  sampleConfig(codexHome);
  sampleCatalog(codexHome);
  const db = testDb(root);
  db.createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/",
    modelsFile: "models.json",
    apiKey: "sk-test",
    extraConfig: { request_max_retries: 10 },
  });
  db.createProviderModel({ id: "m1", providerId: "deepseek", modelId: "deepseek-v4-flash", slug: "deepseek-v4-flash", displayName: "Flash", reasoningEfforts: ["low", "high"], priority: 1 });
  writeProviderConfig(codexHome, db);

  const config = parseToml(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")) as Record<string, any>;
  assert.equal(config.model_provider, "deepseek");
  assert.ok(config.model_providers.deepseek);
  assert.equal(config.model_providers.deepseek.name, "DeepSeek");
  assert.equal(config.model_providers.deepseek.base_url, "https://api.deepseek.com/");
  assert.equal(config.model_providers.deepseek.experimental_bearer_token, "sk-test");
  assert.equal(config.model_providers.deepseek.request_max_retries, 10);
  assert.ok(config.model_providers.legacy, "unmanaged provider section must stay");
  assert.equal(config.model_catalog_json, path.join(codexHome, "models_cache.json"));

  const catalog = JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8")) as { models: Array<Record<string, unknown>> };
  assert.deepEqual(catalog.models.map((model) => model.slug), ["deepseek-v4-flash"]);
  assert.equal(catalog.models[0].visibility, "list");
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, [{ effort: "low" }, { effort: "high" }]);
  assert.equal(catalog.models[0].context_window, 1000, "template fields are cloned");
  db.close();
});

test("disabling a provider removes its section and catalog entries", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  sampleConfig(codexHome);
  const db = testDb(root);
  db.createProvider({ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/", apiKey: "sk-test" });
  db.createProviderModel({ id: "m1", providerId: "deepseek", modelId: "deepseek-v4-flash", slug: "deepseek-v4-flash", displayName: "Flash", priority: 1 });
  writeProviderConfig(codexHome, db);
  db.updateProvider("deepseek", { enabled: false });
  writeProviderConfig(codexHome, db);
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
  db.createProvider({ id: "official", name: "Official", baseUrl: "https://api.openai.com/v1", requiresOpenaiAuth: true });
  assert.throws(() => assertOfficialOAuthLimit(db, { requiresOpenaiAuth: true, enabled: true }), /同一时间只能启用一个/);
  assert.doesNotThrow(() => assertOfficialOAuthLimit(db, { id: "official", requiresOpenaiAuth: true, enabled: true }));
  assert.doesNotThrow(() => assertOfficialOAuthLimit(db, { requiresOpenaiAuth: false, enabled: true }));
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
  db.createProvider({ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/" });
  db.createProviderModel({ id: "m1", providerId: "deepseek", modelId: "deepseek-v4-flash", slug: "deepseek-v4-flash", displayName: "Flash", priority: 1 });
  const after = loadAgentOptions(config, codexHome, db);
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
  db.createProvider({ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/", modelsFile: "models.json" });
  const imported = importCatalogModels("deepseek", codexHome, db);
  assert.deepEqual(imported.map((model) => model.modelId).sort(), ["deepseek-v4-flash", "gpt-5.6-sol"]);
  assert.equal(imported[0].inputModalities.join(","), "text");
  assert.equal(imported.find((model) => model.modelId === "gpt-5.6-sol")?.inputModalities.join(","), "text,image");
  assert.deepEqual(listProviderModelsPublic(db, "deepseek").map((model) => model.slug).sort(), ["deepseek-v4-flash", "gpt-5.6-sol"]);
  importCatalogModels("deepseek", codexHome, db);
  assert.equal(db.listProviderModels("deepseek").length, 2, "re-import skips existing models");
  db.close();
});
