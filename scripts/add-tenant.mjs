#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { loadConfig } from "../dist-server/server/config.js";
import { AppDatabase } from "../dist-server/server/db.js";
import { ensureTenant } from "../dist-server/server/paths.js";
import { assignTenantIdentity } from "../dist-server/server/tenant-identities.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

if (process.env.CONTAINERIZED !== "true" || !process.env.DATA_ROOT || !process.env.TENANT_ROOT) {
  console.error("Run this inside the codex-web container, for example:");
  console.error("  docker compose exec app node scripts/add-tenant.mjs <username> <password> [display-name]");
  process.exit(1);
}
if (process.getuid?.() !== 0) {
  console.error("add-tenant must run as root (docker compose exec uses root by default).");
  process.exit(1);
}

const [username, password, ...rest] = process.argv.slice(2);
const displayName = rest[0] || username;
if (!username || !password) {
  console.error("Usage: node scripts/add-tenant.mjs <username> <password> [display-name]");
  process.exit(1);
}
if (password.length < 12) {
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}

const config = loadConfig();
const db = new AppDatabase(config.dataRoot, {
  username: config.username,
  passwordHash: config.passwordHash,
  displayName: config.displayName,
});

try {
  if (db.getUserByUsername(username)) {
    console.error(`User "${username}" already exists.`);
    process.exit(1);
  }
  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  db.createUser({
    id: userId,
    username,
    display_name: displayName,
    password_hash: bcrypt.hashSync(password, 12),
    role: "member",
    status: "active",
    created_at: now,
    updated_at: now,
  });
  const identity = assignTenantIdentity(userId, username);
  ensureTenant(config.tenantRoot, userId);
  console.log(`User created: ${username} (${userId}), tenant uid ${identity.uid}.`);
} finally {
  db.close();
}

execFileSync(process.execPath, [path.join(scriptDir, "apply-tenant-permissions.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(scriptDir, "seed-host-codex.mjs")], { stdio: "inherit" });
console.log(`Done. ${username} can log in at /codex-web/ now.`);
