#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../dist-server/server/config.js";
import { AppDatabase, LEGACY_USER_ID } from "../dist-server/server/db.js";
import { removePersistedDeliverable, tenantPaths } from "../dist-server/server/paths.js";
import { resolveSystemUser } from "../dist-server/server/host-mode.js";

if (process.getuid?.() !== 0) {
  console.error("remove-tenant must run as root (tenant storage is owned by the tenant user).");
  process.exit(1);
}

const [username, ...rest] = process.argv.slice(2);
const removeSystem = rest.includes("--system");
const force = rest.includes("--force");
if (!username || rest.some((arg) => !["--system", "--force"].includes(arg))) {
  console.error("Usage: node scripts/remove-tenant.mjs <username> [--system] [--force]");
  process.exit(1);
}

const config = loadConfig();
const db = new AppDatabase(config.dataRoot, {
  username: config.username,
  passwordHash: config.passwordHash,
  displayName: config.displayName,
});

try {
  const user = db.getUserByUsername(username);
  if (!user) {
    console.error(`User "${username}" does not exist.`);
    process.exit(1);
  }
  if (user.id === LEGACY_USER_ID) {
    console.error("Cannot remove the owner account.");
    process.exit(1);
  }
  const active = Number(db.sqlite.prepare(`
    SELECT COUNT(*) AS n
    FROM jobs j JOIN conversations c ON c.id = j.conversation_id
    WHERE c.user_id = ? AND j.status IN ('queued', 'running')
  `).get(user.id).n);
  if (active > 0 && !force) {
    console.error(`User "${username}" still has ${active} queued/running job(s); pass --force to remove anyway.`);
    process.exit(1);
  }

  // Remove persisted deliverables before their file rows disappear.
  const files = db.sqlite.prepare(`
    SELECT f.relative_path
    FROM files f JOIN conversations c ON c.id = f.conversation_id
    WHERE c.user_id = ?
  `).all(user.id);
  for (const file of files) {
    try { removePersistedDeliverable(config.dataRoot, file.relative_path); } catch { /* keep going */ }
  }

  // Sessions have no cascade; conversations cascade to messages, files,
  // pending prompts, composer drafts and jobs (jobs cascade job_events).
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    db.sqlite.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
    db.sqlite.prepare("DELETE FROM conversations WHERE user_id=?").run(user.id);
    db.sqlite.prepare("DELETE FROM user_settings WHERE user_id=?").run(user.id);
    db.sqlite.prepare("DELETE FROM users WHERE id=?").run(user.id);
    db.sqlite.exec("COMMIT");
  } catch (error) {
    db.sqlite.exec("ROLLBACK");
    throw error;
  }

  fs.rmSync(tenantPaths(config.tenantRoot, user.id).root, { recursive: true, force: true });

  let systemNote = "";
  if (removeSystem) {
    const system = resolveSystemUser(username);
    if (system) {
      execFileSync(toolPath("userdel"), ["-r", username], { stdio: "inherit" });
      systemNote = `; system user ${username} removed with its home directory`;
    } else {
      systemNote = "; no system user found to remove";
    }
  }
  console.log(`Removed user ${username} (${user.id})${systemNote}.`);
} finally {
  db.close();
}

function toolPath(name) {
  const candidates = [`/usr/sbin/${name}`, `/sbin/${name}`, `/usr/bin/${name}`, `/bin/${name}`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
}
