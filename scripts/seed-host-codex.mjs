#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listTenantIdentities } from "../dist-server/server/tenant-identities.js";

if (process.env.CONTAINERIZED !== "true") {
  console.error("seed-host-codex must run inside the codex-web container.");
  process.exit(1);
}
if (process.getuid?.() !== 0) {
  console.error("seed-host-codex must run as root.");
  process.exit(1);
}

const hostHome = process.env.HOST_CODEX_HOME || "";
const tenantRoot = process.env.TENANT_ROOT || "/app/tenants";

if (!hostHome || !fs.existsSync(hostHome) || !fs.statSync(hostHome).isDirectory()) {
  console.log("HOST_CODEX_HOME is not mounted; skipping host Codex seeding.");
  process.exit(0);
}

const SECRET_FILES = ["config.toml", "auth.json", "rightcode_auth.json"];
const CATALOG_FILES = ["models.json", "models_cache.json"];
const SEEDED_FILES = [...SECRET_FILES, ...CATALOG_FILES];

for (const identity of listTenantIdentities()) {
  const codexHome = path.join(tenantRoot, identity.userId, "codex-home");
  if (!fs.existsSync(codexHome)) continue;
  for (const name of SEEDED_FILES) {
    const source = path.join(hostHome, name);
    const dest = path.join(codexHome, name);
    if (!fs.existsSync(source)) continue;
    if (name === "config.toml") {
      // The tenant worker's HOME is the tenant root, not the codex home, so
      // rewrite ~/.codex/ references to the tenant-absolute location.
      const rewritten = fs.readFileSync(source, "utf8").replaceAll("~/.codex/", `${codexHome}/`);
      fs.writeFileSync(dest, rewritten, "utf8");
    } else {
      fs.copyFileSync(source, dest);
    }
    fs.chownSync(dest, identity.uid, identity.gid);
    execFileSync("setfacl", ["-b", dest]);
    fs.chmodSync(dest, CATALOG_FILES.includes(name) ? 0o644 : 0o600);
  }
  // The web model picker reads models_cache.json; derive it from the host
  // catalog when the CLI has not produced its own cache yet.
  const models = path.join(codexHome, "models.json");
  const modelsCache = path.join(codexHome, "models_cache.json");
  if (fs.existsSync(models) && !fs.existsSync(modelsCache)) {
    fs.copyFileSync(models, modelsCache);
    fs.chownSync(modelsCache, identity.uid, identity.gid);
    execFileSync("setfacl", ["-b", modelsCache]);
    fs.chmodSync(modelsCache, 0o644);
  }
  console.log(`Seeded host Codex config for tenant ${identity.label} (uid ${identity.uid}).`);
}
