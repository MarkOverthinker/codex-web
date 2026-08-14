import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { isCodexConfigured, resolveSystemUser } from "../server/host-mode.js";

test("isCodexConfigured requires config.toml plus credentials", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-mode-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(isCodexConfigured(undefined), false);
  assert.equal(isCodexConfigured(path.join(root, "missing")), false);
  assert.equal(isCodexConfigured(root), false);

  fs.writeFileSync(path.join(root, "config.toml"), "model = \"gpt-5.6-sol\"\n");
  assert.equal(isCodexConfigured(root), false);

  fs.writeFileSync(path.join(root, "auth.json"), "{}");
  assert.equal(isCodexConfigured(root), true);
});

test("isCodexConfigured rejects files unreadable by the tenant identity", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-mode-permissions-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "config.toml"), "model = \"gpt-5.6-sol\"\n");
  fs.writeFileSync(path.join(root, "auth.json"), "{}");
  const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
  assert.equal(isCodexConfigured(root, owner), true);
  fs.chmodSync(path.join(root, "config.toml"), 0o600);
  fs.chmodSync(path.join(root, "auth.json"), 0o600);
  assert.equal(isCodexConfigured(root, { uid: owner.uid + 1, gid: owner.gid + 1 }), false);
});

test("isCodexConfigured accepts inline bearer tokens from config.toml", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-mode-token-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "config.toml"), "[model_providers.deepseek]\nexperimental_bearer_token = \"sk-test\"\n");
  assert.equal(isCodexConfigured(root), true);
});

test("resolveSystemUser maps a machine user to uid, gid and home", () => {
  const username = process.env.USER || process.env.LOGNAME || "root";
  const system = resolveSystemUser(username);
  assert.ok(system, `expected the current machine user ${username} to resolve`);
  assert.equal(system.username, username);
  assert.ok(Number.isInteger(system.uid));
  assert.ok(Number.isInteger(system.gid));
  assert.ok(system.home.startsWith("/"));
});
