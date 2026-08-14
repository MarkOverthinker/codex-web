#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

const configPath = path.resolve(process.argv[2] || "model-catalog-templates.toml");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readModels(file) {
  const parsed = readJson(file);
  if (!parsed || !Array.isArray(parsed.models)) throw new Error(`Invalid model catalog: ${file}`);
  return parsed.models.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
}

function requiredString(config, key) {
  const value = config[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing config field: ${key}`);
  return value;
}

function fallbackTemplate(baseInstructions) {
  return {
    slug: "__codex_web_fallback__",
    display_name: "Codex Web Fallback",
    description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: "default",
    visibility: "none",
    supported_in_api: true,
    priority: 99,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: baseInstructions,
    model_messages: null,
    include_skills_usage_instructions: false,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: 272_000,
    max_context_window: 272_000,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: null,
    tool_mode: null,
    multi_agent_version: null,
  };
}

const config = parseToml(fs.readFileSync(configPath, "utf8"));
const baseDir = path.dirname(configPath);
const resolveFromConfig = (value) => path.resolve(baseDir, value);
const codexModelsPath = resolveFromConfig(requiredString(config, "codex_models"));
const codexPromptPath = resolveFromConfig(requiredString(config, "codex_prompt"));
const outputPath = resolveFromConfig(requiredString(config, "output"));
const deepseekPaths = Array.isArray(config.deepseek_models)
  ? config.deepseek_models.map((value) => resolveFromConfig(String(value)))
  : [];
const models = [...readModels(codexModelsPath), ...deepseekPaths.flatMap(readModels)];
const bySlug = new Map();
for (const model of models) {
  const slug = typeof model.slug === "string" ? model.slug.trim() : "";
  if (!slug) throw new Error("Template model is missing slug");
  bySlug.set(slug, model);
}
const library = {
  schema_version: 1,
  codex_version: requiredString(config, "codex_version"),
  fallback: fallbackTemplate(fs.readFileSync(codexPromptPath, "utf8")),
  models: [...bySlug.values()],
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(library, null, 2)}\n`, "utf8");
console.log(`Wrote ${library.models.length} model templates to ${outputPath}`);
