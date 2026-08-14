#!/usr/bin/env node
// Import provider definitions and model catalogs into codex-web's provider
// SSOT, then regenerate the merged config.toml and models_cache.json.
//
// The web database is normally owned by the root service account, so run this
// script as root (or as the account that owns DATA_ROOT/codex-web.sqlite):
//
//   sudo node scripts/init-provider-sources.mjs \
//     --models-file deepseek=models.json \
//     --models-file sssaicodeapi=sssaicodeapi-models.json
//
// Without --models-file, each provider tries <providerId>-models.json first,
// then falls back to the models_file key written inside its config.toml
// section. Providers already present in the database are left untouched.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../dist-server/server/config.js";
import { AppDatabase } from "../dist-server/server/db.js";
import { hostTenantFor } from "../dist-server/server/host-mode.js";
import {
  importCatalogModels,
  importProvidersFromConfig,
  repairCodexHomeOwnership,
  writeProviderConfig,
} from "../dist-server/server/provider-manager.js";

function parseModelFilesArgs(argv) {
  const mapping = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--models-file") continue;
    const value = argv[index + 1];
    if (!value || !value.includes("=")) {
      console.error("--models-file expects providerId=fileName");
      process.exit(2);
    }
    const separator = value.indexOf("=");
    mapping.set(value.slice(0, separator), value.slice(separator + 1));
    index += 1;
  }
  return mapping;
}

function readLegacyUser(dataRoot) {
  const dbPath = path.join(dataRoot, "codex-web.sqlite");
  if (!fs.existsSync(dbPath)) return { username: "owner", passwordHash: "", displayName: "Owner" };
  const sqlite = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const user = sqlite.prepare(
      "SELECT username,display_name,password_hash FROM users WHERE role='owner' ORDER BY created_at,id LIMIT 1",
    ).get();
    if (!user) return { username: "owner", passwordHash: "", displayName: "Owner" };
    return {
      username: user.username,
      displayName: user.display_name,
      passwordHash: user.password_hash,
    };
  } finally {
    sqlite.close();
  }
}

function main() {
  const config = loadConfig();
  const requestedModelFiles = parseModelFilesArgs(process.argv.slice(2));
  if (!config.hostMode) {
    console.error("Provider initialization currently supports host-mode deployments only.");
    process.exit(1);
  }
  if (process.getuid?.() !== 0) {
    console.error("Run as root so the web database and codex homes are writable.");
    process.exit(1);
  }
  const legacyUser = readLegacyUser(config.dataRoot);
  const db = new AppDatabase(config.dataRoot, legacyUser, false);
  try {
    const users = db.listUsers();
    let changed = false;
    for (const user of users) {
      const hostTenant = hostTenantFor(config, db, user.id);
      if (!hostTenant) continue;
      const codexHome = hostTenant.codexHome;
      repairCodexHomeOwnership(codexHome, { uid: hostTenant.uid, gid: hostTenant.gid });
      if (!fs.existsSync(path.join(codexHome, "config.toml"))) continue;
      const providers = importProvidersFromConfig(codexHome, db, user.id);
      let providerChanged = false;
      for (const provider of providers) {
        const modelsFile = requestedModelFiles.get(provider.id)
          ?? (fs.existsSync(path.join(codexHome, `${provider.id}-models.json`)) ? `${provider.id}-models.json` : null);
        if (modelsFile) {
          db.updateProvider(user.id, provider.id, { modelsFile });
        }
        const current = db.getProvider(user.id, provider.id);
        if (current?.models_file && fs.existsSync(path.join(codexHome, current.models_file))) {
          const before = db.listProviderModels(user.id, provider.id).length;
          importCatalogModels(provider.id, codexHome, db, user.id);
          if (db.listProviderModels(user.id, provider.id).length !== before) providerChanged = true;
        }
      }
      if (providerChanged || providers.length > 0) {
        writeProviderConfig(codexHome, db, user.id, { uid: hostTenant.uid, gid: hostTenant.gid });
        changed = true;
        console.log(`Initialized providers for ${hostTenant.label} (${codexHome}).`);
      }
    }
    if (!changed) console.log("No providers needed initialization.");
  } finally {
    db.close();
  }
}

main();
