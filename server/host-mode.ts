import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db.js";
import { tenantPaths } from "./paths.js";

export type SystemUser = {
  username: string;
  uid: number;
  gid: number;
  home: string;
};

export type HostTenant = {
  userId: string;
  username: string;
  label: string;
  uid: number;
  gid: number;
  home: string;
  codexHome: string;
  root: string;
  library: string;
  conversations: string;
};

export const CODEX_CONFIG_HINT = "你的 Codex 尚未配置：该系统用户的主目录缺少可用的 ~/.codex（需要 config.toml 和登录凭据）。请先以该系统用户身份完成 codex 登录，或联系管理员。";

/**
 * Resolve a machine user from the local passwd database. getent is preferred
 * (NSS-aware); /etc/passwd is a fallback for minimal environments.
 */
export function resolveSystemUser(username: string): SystemUser | undefined {
  if (!username || !/^[a-z_][a-z0-9._-]{0,31}$/i.test(username)) return undefined;
  try {
    const output = execFileSync("getent", ["passwd", username], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parsed = parsePasswdLine((output.split(/\r?\n/, 1)[0] ?? "").trim(), username);
    if (parsed) return parsed;
  } catch {
    // getent unavailable or the user is missing; fall through to /etc/passwd.
  }
  try {
    for (const line of fs.readFileSync("/etc/passwd", "utf8").split(/\r?\n/)) {
      const parsed = parsePasswdLine(line.trim(), username);
      if (parsed) return parsed;
    }
  } catch {
    // No readable passwd database; the user cannot be mapped.
  }
  return undefined;
}

function parsePasswdLine(line: string, expectedUsername: string): SystemUser | undefined {
  const fields = line.split(":");
  if (fields.length < 7 || fields[0] !== expectedUsername) return undefined;
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return undefined;
  const home = fields[5];
  if (!home || !home.startsWith("/")) return undefined;
  return { username: fields[0], uid, gid, home };
}

/**
 * A tenant is usable when its real ~/.codex has config.toml plus either a
 * credential file or an inline bearer token. When an owner is supplied, the
 * check also models the permissions of the UID that will run Codex; a root
 * process must not report a root-only config as usable by that tenant.
 */
function readableByOwner(file: string, owner: { uid: number; gid: number } | undefined): boolean {
  try {
    const stat = fs.statSync(file);
    if (!owner) {
      fs.accessSync(file, fs.constants.R_OK);
      return true;
    }
    const parent = fs.statSync(path.dirname(file));
    const mode = stat.mode & 0o777;
    const parentMode = parent.mode & 0o777;
    const readable = stat.uid === owner.uid
      ? (mode & 0o400) !== 0
      : stat.gid === owner.gid
        ? (mode & 0o040) !== 0
        : (mode & 0o004) !== 0;
    const traversable = parent.uid === owner.uid
      ? (parentMode & 0o100) !== 0
      : parent.gid === owner.gid
        ? (parentMode & 0o010) !== 0
        : (parentMode & 0o001) !== 0;
    return readable && traversable;
  } catch {
    return false;
  }
}

export function isCodexConfigured(codexHome: string | undefined | null, owner?: { uid: number; gid: number }): boolean {
  if (!codexHome) return false;
  const configToml = path.join(codexHome, "config.toml");
  if (!readableByOwner(configToml, owner)) return false;
  if (["auth.json", "rightcode_auth.json"].some((name) => readableByOwner(path.join(codexHome, name), owner))) return true;
  try {
    return /experimental_bearer_token\s*=/.test(fs.readFileSync(configToml, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Host mode maps every web user to the machine user with the same username.
 * Storage (conversations, library) stays under TENANT_ROOT while CODEX_HOME
 * points at the machine user's real ~/.codex.
 */
export function hostTenantFor(config: AppConfig, db: AppDatabase, userId: string): HostTenant | null {
  const user = db.getUser(userId);
  if (!user) return null;
  const system = resolveSystemUser(user.username);
  if (!system) return null;
  const paths = tenantPaths(config.tenantRoot, userId);
  return {
    userId,
    username: user.username,
    label: user.display_name || user.username,
    uid: system.uid,
    gid: system.gid,
    home: system.home,
    codexHome: path.join(system.home, ".codex"),
    root: paths.root,
    library: paths.library,
    conversations: paths.conversations,
  };
}
