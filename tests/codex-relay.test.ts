import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startCodexRelay } from "../server/codex-relay.js";

function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("codex-relay test timed out")), timeoutMs)),
  ]);
}

test("codex-relay starts on an ephemeral loopback port and receives only upstream credentials", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-relay-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex-relay.mjs");
  const capturePath = path.join(root, "capture.json");
  const historyDir = path.join(root, "history");
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  bind: process.env.CODEX_RELAY_BIND,
  port: process.env.CODEX_RELAY_PORT,
  upstream: process.env.CODEX_RELAY_UPSTREAM,
  apiKey: process.env.CODEX_RELAY_API_KEY,
  historyStore: process.env.CODEX_RELAY_HISTORY_STORE,
  historyDir: process.env.CODEX_RELAY_HISTORY_DIR,
}));
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
process.stderr.write("codex-relay listening on 127.0.0.1:43123 → " + process.env.CODEX_RELAY_UPSTREAM + "\\n");
`, { mode: 0o755 });

  const controller = new AbortController();
  const relay = await withTimeout(startCodexRelay({
    executablePath: executable,
    upstreamBaseUrl: "https://chat.example.com/v1/",
    apiKey: "sk-upstream",
    historyDir,
    env: { ...process.env, CAPTURE_PATH: capturePath },
    signal: controller.signal,
  }));
  assert.equal(relay.baseUrl, "http://127.0.0.1:43123/v1");
  assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf8")), {
    bind: "127.0.0.1",
    port: "0",
    upstream: "https://chat.example.com/v1",
    apiKey: "sk-upstream",
    historyStore: "disk",
    historyDir,
  });
  await relay.stop();
  assert.deepEqual(await withTimeout(relay.exited), { code: 0, signal: null });
});

test("codex-relay rejects non-http upstream URLs before spawning", async () => {
  const controller = new AbortController();
  await assert.rejects(startCodexRelay({
    executablePath: "codex-relay",
    upstreamBaseUrl: "file:///tmp/chat",
    apiKey: null,
    historyDir: path.join(os.tmpdir(), "unused-relay-history"),
    env: process.env,
    signal: controller.signal,
  }), /只支持 HTTP 或 HTTPS/);
});

test("codex-relay startup errors redact upstream credentials and URL", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-relay-error-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "failing-codex-relay.mjs");
  fs.writeFileSync(executable, `#!/usr/bin/env node
process.stderr.write("failed upstream " + process.env.CODEX_RELAY_UPSTREAM + " key=" + process.env.CODEX_RELAY_API_KEY + "\\n");
process.exit(1);
`, { mode: 0o755 });

  const controller = new AbortController();
  const upstreamBaseUrl = "https://user:password@chat.example.com/v1?token=query-secret";
  const apiKey = "sk-upstream-secret";
  await assert.rejects(startCodexRelay({
    executablePath: executable,
    upstreamBaseUrl,
    apiKey,
    historyDir: path.join(root, "history"),
    env: process.env,
    signal: controller.signal,
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /password|query-secret|sk-upstream-secret/);
    assert.match(error.message, /\[UPSTREAM\].*\[REDACTED\]/);
    return true;
  });
});
