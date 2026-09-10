import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse, stringify } from "smol-toml";
import { chownTenantStorageIfNeeded, findCodexThreadFiles } from "./paths.js";

type HostCodexHome = {
  sourceCodexHome: string;
  codexHome: string;
  uid: number;
  gid: number;
};

function assertPrivateHome(host: HostCodexHome): void {
  const source = fs.realpathSync(host.sourceCodexHome);
  const parent = fs.realpathSync(path.dirname(host.codexHome));
  const target = path.join(parent, path.basename(host.codexHome));
  if (target === source || target.startsWith(`${source}${path.sep}`) || source.startsWith(`${target}${path.sep}`)) {
    throw new Error("Web Codex Home must be separate from the desktop Codex Home");
  }
  if (fs.existsSync(host.codexHome) && fs.lstatSync(host.codexHome).isSymbolicLink()) {
    throw new Error("Web Codex Home must not be a symlink");
  }
}

function rewriteHomePaths(value: unknown, source: string, target: string): unknown {
  if (typeof value === "string") {
    for (const prefix of [source, "~/.codex"]) {
      if (value === prefix || value.startsWith(`${prefix}/`)) return target + value.slice(prefix.length);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteHomePaths(item, source, target));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteHomePaths(item, source, target)]));
  }
  return value;
}

/** Bootstrap once, using independent files. Never link or write back to ~/.codex. */
export function prepareHostCodexHome(host: HostCodexHome, migrateHistory = false): void {
  fs.mkdirSync(path.dirname(host.codexHome), { recursive: true });
  if (!fs.existsSync(host.sourceCodexHome)) return;
  assertPrivateHome(host);
  // A completed Web home belongs to the Web user, including its login state.
  // Restarting the service must not re-import a desktop provider or credential.
  if (fs.existsSync(path.join(host.codexHome, "config.toml"))) return;
  const sourceConfig = path.join(host.sourceCodexHome, "config.toml");
  if (!fs.existsSync(sourceConfig)) return;
  if (fs.existsSync(host.codexHome)) {
    throw new Error("Incomplete Web Codex Home: preserve it and repair before retrying migration");
  }
  const original = parse(fs.readFileSync(sourceConfig, "utf8"));
  const config = rewriteHomePaths(original, host.sourceCodexHome, host.codexHome) as Record<string, any>;
  // Do not inherit a shared OS keyring, SQLite directory or log destination.
  config.cli_auth_credentials_store = "file";
  config.sqlite_home = host.codexHome;
  if (config.log_dir) config.log_dir = path.join(host.codexHome, "log");
  const staging = fs.mkdtempSync(path.join(path.dirname(host.codexHome), ".host-codex-home-"));
  fs.chmodSync(staging, 0o700);
  try {
    const fixedFiles = new Set(["auth.json", "rightcode_auth.json", "AGENTS.md", ".env"]);
    for (const provider of Object.values(original.model_providers ?? {})) {
      if (provider && typeof provider === "object" && !Array.isArray(provider)
        && typeof provider.models_file === "string" && path.basename(provider.models_file) === provider.models_file) {
        fixedFiles.add(provider.models_file);
      }
    }
    for (const entry of fs.readdirSync(host.sourceCodexHome, { withFileTypes: true })) {
      if ((!entry.isFile() && !entry.isSymbolicLink()) || (!fixedFiles.has(entry.name) && !/models.*\.json$|.*-models\.json$/.test(entry.name))) continue;
      if (!fs.statSync(path.join(host.sourceCodexHome, entry.name)).isFile()) continue;
      const destination = path.join(staging, entry.name);
      fs.copyFileSync(path.join(host.sourceCodexHome, entry.name), destination);
      fs.chmodSync(destination, 0o600);
    }
    // An explicitly configured catalog may live outside the original home.
    if (typeof original.model_catalog_json === "string") {
      const catalog = original.model_catalog_json.replace(/^~\//, `${path.dirname(host.sourceCodexHome)}/`);
      const resolved = path.isAbsolute(catalog) ? catalog : path.join(host.sourceCodexHome, catalog);
      if (fs.existsSync(resolved)) {
        const name = "host-imported-models.json";
        fs.copyFileSync(resolved, path.join(staging, name));
        fs.chmodSync(path.join(staging, name), 0o600);
        config.model_catalog_json = path.join(host.codexHome, name);
      }
    }
    for (const name of ["skills", "plugins", "rules", ...(migrateHistory ? ["sessions", "archived_sessions"] : [])]) {
      const source = path.join(host.sourceCodexHome, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(staging, name), { recursive: true, dereference: true });
    }
    if (migrateHistory) {
      // VACUUM INTO reads a consistent snapshot, including committed WAL data;
      // copying a live .sqlite file alone can silently lose recent threads.
      const sqliteRoot = typeof original.sqlite_home === "string"
        ? path.resolve(host.sourceCodexHome, original.sqlite_home.replace(/^~\//, `${path.dirname(host.sourceCodexHome)}/`))
        : host.sourceCodexHome;
      for (const name of fs.readdirSync(sqliteRoot)) {
        if (!/^(state|thread_history)_\d+\.sqlite$/.test(name)) continue;
        const destination = path.join(staging, name);
        const source = new DatabaseSync(path.join(sqliteRoot, name), { readOnly: true });
        try { source.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }
        finally { source.close(); }
        const snapshot = new DatabaseSync(destination);
        try {
          if (snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'").get()) {
            snapshot.exec("BEGIN");
            const rows = snapshot.prepare("SELECT id, rollout_path FROM threads").all() as Array<{ id: string; rollout_path: string }>;
            const update = snapshot.prepare("UPDATE threads SET rollout_path=? WHERE id=?");
            for (const row of rows) {
              const relative = path.relative(host.sourceCodexHome, row.rollout_path);
              const privatePath = relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)
                ? path.join("sessions", path.basename(row.rollout_path)) : relative;
              update.run(path.join(host.codexHome, privatePath), row.id);
            }
            snapshot.exec("COMMIT");
          }
        } finally { snapshot.close(); }
        fs.chmodSync(destination, 0o600);
      }
    }
    fs.writeFileSync(path.join(staging, "config.toml"), stringify(config), { mode: 0o600 });
    fs.writeFileSync(path.join(staging, ".web-home-initialized"), "1\n", { mode: 0o600 });
    chownTenantStorageIfNeeded(staging, host.uid, host.gid);
    fs.renameSync(staging, host.codexHome);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Explicit import takes a snapshot; later Web edits/deletion never touch the source. */
export function copyHostCodexThread(host: HostCodexHome, threadId: string): void {
  assertPrivateHome(host);
  for (const source of findCodexThreadFiles(host.sourceCodexHome, threadId)) {
    const destination = path.join(host.codexHome, path.relative(host.sourceCodexHome, source));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const parent = fs.realpathSync(path.dirname(destination));
    const home = fs.realpathSync(host.codexHome);
    if (!parent.startsWith(`${home}${path.sep}`)) throw new Error("Imported session escapes the Web Codex Home");
    if (process.getuid?.() === 0) {
      for (let directory = parent; directory !== home; directory = path.dirname(directory)) {
        fs.chownSync(directory, host.uid, host.gid);
      }
    }
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(source, temporary);
      fs.chmodSync(temporary, 0o600);
      if (process.getuid?.() === 0) fs.chownSync(temporary, host.uid, host.gid);
      fs.renameSync(temporary, destination);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  // Parent directories created by the root service must also be writable by Codex.
  for (const name of ["sessions", "archived_sessions"]) {
    const directory = path.join(host.codexHome, name);
    if (fs.existsSync(directory)) chownTenantStorageIfNeeded(directory, host.uid, host.gid);
  }
}
