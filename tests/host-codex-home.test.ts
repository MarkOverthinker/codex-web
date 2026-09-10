import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parse, stringify } from "smol-toml";
import { prepareHostCodexHome, copyHostCodexThread } from "../server/host-codex-home.js";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { writeProviderConfig } from "../server/provider-manager.js";
import { removeCodexThreadFiles } from "../server/paths.js";

function fixture(context: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-isolation-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = {
    sourceCodexHome: path.join(root, "desktop"), codexHome: path.join(root, "web", "host-codex-home"),
    uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0,
  };
  fs.mkdirSync(host.sourceCodexHome);
  fs.writeFileSync(path.join(host.sourceCodexHome, "config.toml"), stringify({
    model_provider: "official", cli_auth_credentials_store: "keyring", sqlite_home: host.sourceCodexHome,
    model_catalog_json: path.join(host.sourceCodexHome, "models_cache.json"),
    model_providers: { official: { name: "Official", requires_openai_auth: true } },
  }));
  fs.writeFileSync(path.join(host.sourceCodexHome, "models_cache.json"), JSON.stringify({ models: [] }));
  fs.writeFileSync(path.join(host.sourceCodexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-only" } }), { mode: 0o600 });
  const before = Object.fromEntries(["config.toml", "auth.json", "models_cache.json"].map((name) => [name, {
    content: fs.readFileSync(path.join(host.sourceCodexHome, name)), mode: fs.statSync(path.join(host.sourceCodexHome, name)).mode,
  }]));
  return { root, host, assertDesktopUnchanged: () => {
    for (const [name, value] of Object.entries(before)) {
      assert.deepEqual(fs.readFileSync(path.join(host.sourceCodexHome, name)), value.content);
      assert.equal(fs.statSync(path.join(host.sourceCodexHome, name)).mode, value.mode);
    }
  } };
}

test("provider changes, credential refresh and service restart stay in the Web home", (context) => {
  const { root, host, assertDesktopUnchanged } = fixture(context);
  prepareHostCodexHome(host);
  const config = parse(fs.readFileSync(path.join(host.codexHome, "config.toml"), "utf8"));
  assert.equal(config.model_provider, "official");
  assert.equal(config.cli_auth_credentials_store, "file");
  assert.equal(config.sqlite_home, host.codexHome);
  assert.ok(String(config.model_catalog_json).startsWith(`${host.codexHome}/`));
  assert.notEqual(fs.statSync(path.join(host.codexHome, "auth.json")).ino, fs.statSync(path.join(host.sourceCodexHome, "auth.json")).ino);
  const db = new AppDatabase(path.join(root, "db"), { username: "owner", passwordHash: "$2b$10$invalid", displayName: "Owner" }, false);
  try {
    db.createProvider({ userId: LEGACY_USER_ID, id: "web-api", name: "Web API", baseUrl: "https://provider.example/v1", apiKey: "test-api-key" });
    db.createProviderModel({ userId: LEGACY_USER_ID, id: "model", providerId: "web-api", modelId: "gpt-5.6-sol", slug: "web-model", displayName: "Web model" });
    db.setProviderManagementEnabled(true, LEGACY_USER_ID);
    writeProviderConfig(host.codexHome, db, LEGACY_USER_ID, host);
    db.updateProvider(LEGACY_USER_ID, "web-api", { apiKey: "rotated-test-key", enabled: false });
    writeProviderConfig(host.codexHome, db, LEGACY_USER_ID, host);
    fs.writeFileSync(path.join(host.codexHome, "auth.json"), '{"auth_mode":"apikey","OPENAI_API_KEY":"web-only"}');
    const webConfig = fs.readFileSync(path.join(host.codexHome, "config.toml"));
    prepareHostCodexHome(host, true);
    assert.deepEqual(fs.readFileSync(path.join(host.codexHome, "config.toml")), webConfig);
    assert.equal(JSON.parse(fs.readFileSync(path.join(host.codexHome, "auth.json"), "utf8")).auth_mode, "apikey");
    assertDesktopUnchanged();
  } finally { db.close(); }
});

test("legacy history migration snapshots live WAL data and redirects rollout paths", (context) => {
  const { host, assertDesktopUnchanged } = fixture(context);
  const id = "11111111-1111-4111-8111-111111111111";
  const relative = path.join("sessions", "2026", `rollout-${id}.jsonl`);
  const original = path.join(host.sourceCodexHome, relative);
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, '{"type":"session_meta"}\n');
  const db = new DatabaseSync(path.join(host.sourceCodexHome, "state_5.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    db.prepare("INSERT INTO threads VALUES (?, ?)").run(id, original);
    db.prepare("INSERT INTO threads VALUES (?, ?)").run("stale", "/previous-home/.codex/sessions/stale.jsonl");
    prepareHostCodexHome(host, true);
    const snapshot = new DatabaseSync(path.join(host.codexHome, "state_5.sqlite"));
    try {
      assert.equal(snapshot.prepare("SELECT rollout_path FROM threads WHERE id=?").get(id)?.rollout_path, path.join(host.codexHome, relative));
      assert.equal(snapshot.prepare("SELECT rollout_path FROM threads WHERE id='stale'").get()?.rollout_path, path.join(host.codexHome, "sessions", "stale.jsonl"));
    } finally { snapshot.close(); }
    fs.appendFileSync(path.join(host.codexHome, relative), '{"web":"continued"}\n');
    assert.equal(fs.readFileSync(original, "utf8"), '{"type":"session_meta"}\n');
    assert.equal(db.prepare("SELECT rollout_path FROM threads WHERE id=?").get(id)?.rollout_path, original);
    assertDesktopUnchanged();
  } finally { db.close(); }
});

test("explicit history import and deletion leave the desktop rollout intact", (context) => {
  const { host } = fixture(context);
  prepareHostCodexHome(host);
  const id = "22222222-2222-4222-8222-222222222222";
  const relative = path.join("sessions", "2026", "09", `rollout-${id}.jsonl`);
  const original = path.join(host.sourceCodexHome, relative);
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, "desktop-history\n");
  copyHostCodexThread(host, id);
  assert.equal(fs.readFileSync(path.join(host.codexHome, relative), "utf8"), "desktop-history\n");
  assert.equal(removeCodexThreadFiles(host.codexHome, id), 1);
  assert.equal(fs.readFileSync(original, "utf8"), "desktop-history\n");
});

test("bootstrap rejects aliasing the desktop home and leaves no partial home on failure", (context) => {
  const { host, assertDesktopUnchanged } = fixture(context);
  assert.throws(() => prepareHostCodexHome({ ...host, codexHome: host.sourceCodexHome }), /separate/);
  fs.mkdirSync(path.dirname(host.codexHome), { recursive: true });
  fs.symlinkSync(host.sourceCodexHome, host.codexHome, "dir");
  assert.throws(() => prepareHostCodexHome(host), /symlink/);
  fs.unlinkSync(host.codexHome);
  fs.writeFileSync(path.join(host.sourceCodexHome, "state_5.sqlite"), "broken database");
  assert.throws(() => prepareHostCodexHome(host, true));
  assert.equal(fs.existsSync(host.codexHome), false);
  assert.equal(fs.readdirSync(path.dirname(host.codexHome)).length, 0);
  assertDesktopUnchanged();
});
