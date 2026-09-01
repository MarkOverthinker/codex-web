import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildBillingState, BUILTIN_PROVIDER_ID, recordTokenUsage, syncProviderPricing } from "../server/billing.js";
import { AppDatabase } from "../server/db.js";

function makeDb(): { db: AppDatabase; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-billing-"));
  return { root, db: new AppDatabase(root, { username: "owner", passwordHash: "$2b$10$invalid", displayName: "Owner" }, false) };
}

test("billing aggregates usage and calculates token costs", () => {
  const { db, root } = makeDb();
  try {
    const conversation = db.createConversation("11111111-1111-4111-8111-111111111111", "Billing test");
    const job = db.createJob("22222222-2222-4222-8222-222222222222", conversation.id, undefined, { model: "gpt-test", reasoningEffort: "medium" });
    db.upsertPricingRule({
      user_id: conversation.user_id, provider_id: BUILTIN_PROVIDER_ID, model_id: "gpt-test",
      input_per_million: 2, cached_input_per_million: 1, cache_write_per_million: 0.5, output_per_million: 4,
      currency: "USD", source: "manual", pricing_url: null,
    });
    recordTokenUsage(db, {
      userId: conversation.user_id, jobId: job.id, conversationId: conversation.id, modelId: "gpt-test",
      usage: { input_tokens: 1_000_000, cached_input_tokens: 200_000, cache_write_input_tokens: 100_000, output_tokens: 500_000, reasoning_output_tokens: 100_000 },
    });
    const state = buildBillingState(db, conversation.user_id, 30);
    assert.equal(state.summary.calls, 1);
    assert.equal(state.summary.inputTokens, 1_000_000);
    assert.equal(state.summary.cachedInputTokens, 200_000);
    assert.equal(state.summary.cacheHitRate, 0.2);
    assert.equal(state.summary.estimatedCost, 4.25);
    assert.equal(state.summary.unpricedCalls, 0);
    assert.equal(state.byModel[0]?.modelId, "gpt-test");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("billing switches between valley and peak prices by local usage time", () => {
  const { db, root } = makeDb();
  try {
    const conversation = db.createConversation("33333333-3333-4333-8333-333333333333", "Peak pricing test");
    const peakJob = db.createJob("44444444-4444-4444-8444-444444444444", conversation.id, undefined, { model: "gpt-test", reasoningEffort: "medium" });
    const valleyJob = db.createJob("55555555-5555-4555-8555-555555555555", conversation.id, undefined, { model: "gpt-test", reasoningEffort: "medium" });
    db.upsertPricingRule({
      user_id: conversation.user_id, provider_id: BUILTIN_PROVIDER_ID, model_id: "gpt-test",
      input_per_million: 1, cached_input_per_million: 1, cache_write_per_million: 1, output_per_million: 1,
      peak_enabled: 1, peak_input_per_million: 3, peak_cached_input_per_million: 3, peak_cache_write_per_million: 3, peak_output_per_million: 3,
      peak_start_minute: 9 * 60, peak_end_minute: 18 * 60, peak_weekdays: "1,2,3,4,5", timezone: "Asia/Shanghai",
      currency: "USD", source: "manual", pricing_url: null,
    });
    db.addApiUsage({
      id: "66666666-6666-4666-8666-666666666666", user_id: conversation.user_id, job_id: peakJob.id, conversation_id: conversation.id,
      provider_id: BUILTIN_PROVIDER_ID, model_id: "gpt-test", input_tokens: 1_000_000, cached_input_tokens: 0,
      cache_write_input_tokens: 0, output_tokens: 1_000_000, reasoning_output_tokens: 0, created_at: "2026-08-31T02:00:00.000Z",
    });
    db.addApiUsage({
      id: "77777777-7777-4777-8777-777777777777", user_id: conversation.user_id, job_id: valleyJob.id, conversation_id: conversation.id,
      provider_id: BUILTIN_PROVIDER_ID, model_id: "gpt-test", input_tokens: 1_000_000, cached_input_tokens: 0,
      cache_write_input_tokens: 0, output_tokens: 1_000_000, reasoning_output_tokens: 0, created_at: "2026-08-31T12:00:00.000Z",
    });
    const state = buildBillingState(db, conversation.user_id, 30);
    assert.equal(state.summary.estimatedCost, 8);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("New API pricing ratios are converted to per-million-token prices", async () => {
  const savedFetch = globalThis.fetch;
  const rules: unknown[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ model_name: "gpt-test", model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.5 }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await syncProviderPricing({ upsertPricingRule: (rule: unknown) => rules.push(rule) } as never, "user-1", {
      id: "new-api", base_url: "https://new-api.example.com/v1", api_key: null,
    } as never);
    assert.equal(result.imported, 1);
    assert.deepEqual(rules[0], {
      user_id: "user-1", provider_id: "new-api", model_id: "gpt-test",
      input_per_million: 1, cached_input_per_million: 0.5, cache_write_per_million: 0, output_per_million: 2,
      currency: "USD", source: "remote", pricing_url: "https://new-api.example.com/api/pricing",
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
});


test("New API ratio config maps are converted to per-million-token prices", async () => {
  const savedFetch = globalThis.fetch;
  const rules: unknown[] = [];
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/api/pricing")) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({
      success: true,
      data: {
        model_ratio: { "gpt-test": 0.5 },
        completion_ratio: { "gpt-test": 2 },
        cache_ratio: { "gpt-test": 0.5 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await syncProviderPricing({ upsertPricingRule: (rule: unknown) => rules.push(rule) } as never, "user-1", {
      id: "new-api", base_url: "https://new-api.example.com/v1", api_key: null,
    } as never);
    assert.equal(result.imported, 1);
    assert.deepEqual(rules[0], {
      user_id: "user-1", provider_id: "new-api", model_id: "gpt-test",
      input_per_million: 1, cached_input_per_million: 0.5, cache_write_per_million: 0, output_per_million: 2,
      currency: "USD", source: "remote", pricing_url: "https://new-api.example.com/api/ratio_config",
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("pricing page URL falls back to the same-origin ratio config endpoint", async () => {
  const savedFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/pricing")) return new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
    return new Response(JSON.stringify({ data: { model_ratio: { "gpt-test": 0.5 } } }), { status: 200 });
  };
  try {
    const result = await syncProviderPricing({ upsertPricingRule: () => undefined } as never, "user-1", {
      id: "new-api", base_url: "https://new-api.example.com/v1", api_key: null,
    } as never, "https://new-api.example.com/pricing");
    assert.equal(result.imported, 1);
    assert.deepEqual(urls, [
      "https://new-api.example.com/pricing",
      "https://new-api.example.com/api/ratio_config",
    ]);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
