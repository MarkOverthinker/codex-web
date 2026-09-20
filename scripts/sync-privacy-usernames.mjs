#!/usr/bin/env node
// Keep the local privacy policy in step with the deployment's Web users.
//
// Every Web user except the owner maps to a machine account, and those account
// names are deployment identifiers: they must not reach the public repository in
// file contents or commit messages. This script reads the locally stored usernames
// and appends the missing ones to the ignored .privacy.local.json, which the Git
// hooks already consult through scripts/check-public-privacy.mjs.
//
//   node scripts/sync-privacy-usernames.mjs            # sync from the local database
//   node scripts/sync-privacy-usernames.mjs --dry-run  # report without writing
//
// scripts/add-tenant.mjs calls the same helper, so a new user is covered as soon
// as it is created. The policy file stays local (chmod 600) and is never pushed.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRootFromScripts = path.dirname(scriptDir);
const policyFile = (cwd) => path.join(cwd, ".privacy.local.json");

function readPolicy(cwd) {
  const file = policyFile(cwd);
  if (!fs.existsSync(file)) return { forbiddenLiterals: [] };
  const policy = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(policy.forbiddenLiterals)) {
    throw new Error(`${file} must contain a forbiddenLiterals array`);
  }
  return policy;
}

/** Append usernames that are not present yet; returns the names actually added. */
export function syncPrivacyUsernames(cwd, usernames, { dryRun = false } = {}) {
  const policy = readPolicy(cwd);
  const known = new Set(policy.forbiddenLiterals.map((value) => String(value).toLowerCase()));
  const added = [];
  for (const raw of usernames) {
    const value = String(raw ?? "").trim();
    if (!value || known.has(value.toLowerCase())) continue;
    known.add(value.toLowerCase());
    added.push(value);
  }
  if (added.length && !dryRun) {
    policy.forbiddenLiterals.push(...added);
    fs.writeFileSync(policyFile(cwd), `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(policyFile(cwd), 0o600);
  }
  return added;
}

/** Usernames of every Web user that is not the owner account. */
export function nonOwnerUsernames(dataRoot) {
  const database = path.join(dataRoot, "codex-web.sqlite");
  if (!fs.existsSync(database)) return [];
  const sqlite = new DatabaseSync(database, { readOnly: true });
  try {
    const rows = sqlite.prepare("SELECT username FROM users WHERE role <> 'owner' ORDER BY username").all();
    return rows.map((row) => String(row.username));
  } finally {
    sqlite.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const dataRoot = process.env.DATA_ROOT || path.join(repoRootFromScripts, "data");
  const usernames = nonOwnerUsernames(dataRoot);
  const added = syncPrivacyUsernames(repoRootFromScripts, usernames, { dryRun });
  if (!usernames.length) {
    console.log(`No non-owner users found in ${dataRoot}; nothing to sync.`);
  } else if (!added.length) {
    console.log(`Privacy terms already cover ${usernames.length} non-owner user(s).`);
  } else {
    console.log(`${dryRun ? "Would add" : "Added"} to .privacy.local.json: ${added.join(", ")}`);
  }
}
