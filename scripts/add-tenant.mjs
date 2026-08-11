#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { loadConfig } from "../dist-server/server/config.js";
import { AppDatabase } from "../dist-server/server/db.js";
import { ensureTenant } from "../dist-server/server/paths.js";
import { assignTenantIdentity } from "../dist-server/server/tenant-identities.js";
import { isCodexConfigured, resolveSystemUser } from "../dist-server/server/host-mode.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const containerized = process.env.CONTAINERIZED === "true";

if (containerized && (!process.env.DATA_ROOT || !process.env.TENANT_ROOT)) {
  console.error("Run this inside the codex-web container, for example:");
  console.error("  docker compose exec app node scripts/add-tenant.mjs <username> <password> [display-name]");
  process.exit(1);
}
if (process.getuid?.() !== 0) {
  console.error("add-tenant must run as root (host mode creates system users; container mode uses docker compose exec).");
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
if (!/^[a-z_][a-z0-9._-]{0,31}$/i.test(username)) {
  console.error("Username must match a valid POSIX account name ([a-z_][a-z0-9._-]{0,31}).");
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
  const hostUser = containerized ? null : addHostSystemUser(username);
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

  if (hostUser) {
    ensureTenant(config.tenantRoot, userId, { skipCodexHome: true });
    execFileSync(toolPath("chown"), ["-R", `${hostUser.uid}:${hostUser.gid}`, path.join(config.tenantRoot, userId)]);
    const codexHome = path.join(hostUser.home, ".codex");
    const configured = isCodexConfigured(codexHome);
    console.log(`User created: ${username} (${userId}) as machine user ${username} (uid ${hostUser.uid}).`);
    console.log(configured
      ? `Codex config: configured at ${codexHome}.`
      : `Codex config: NOT configured at ${codexHome}. The user will see a web hint until they configure codex login as ${username}.`);
  } else {
    const identity = assignTenantIdentity(userId, username);
    ensureTenant(config.tenantRoot, userId);
    console.log(`User created: ${username} (${userId}), tenant uid ${identity.uid}.`);
  }
} finally {
  db.close();
}

if (containerized) {
  execFileSync(process.execPath, [path.join(scriptDir, "apply-tenant-permissions.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(scriptDir, "seed-host-codex.mjs")], { stdio: "inherit" });
}
console.log(`Done. ${username} can log in at ${config.basePath || "/"}/ now.`);

function addHostSystemUser(username) {
  let system = resolveSystemUser(username);
  if (system) {
    console.log(`System user ${username} already exists; keeping existing ~/.codex unchanged.`);
    return system;
  }
  try {
    execFileSync(toolPath("useradd"), ["--create-home", "--shell", "/bin/bash", username], { stdio: "inherit" });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`未找到 useradd（通常在 /usr/sbin）。请确认系统安装了 passwd/shadow 工具包，或带完整 PATH 重试：PATH=$PATH:/usr/sbin node scripts/add-tenant.mjs ${username} ...`);
    }
    throw error;
  }
  system = resolveSystemUser(username);
  if (!system) throw new Error(`Failed to create system user ${username}`);
  const template = process.env.CODEX_TEMPLATE_HOME || "/etc/skel/.codex";
  const target = path.join(system.home, ".codex");
  if (fs.existsSync(template)) {
    fs.cpSync(template, target, { recursive: true, force: true });
    execFileSync(toolPath("chown"), ["-R", `${system.uid}:${system.gid}`, target]);
    console.log(`New system user ${username} created; ~/.codex copied from ${template}.`);
  } else {
    console.log(`New system user ${username} created; no template at ${template}, so ~/.codex must be configured later by ${username}.`);
  }
  return system;
}

function toolPath(name) {
  const candidates = [`/usr/sbin/${name}`, `/sbin/${name}`, `/usr/bin/${name}`, `/bin/${name}`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
}
