#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listTenantIdentities, WEB_IDENTITY } from "../dist-server/server/tenant-identities.js";

if (process.env.CONTAINERIZED !== "true") {
  console.error("apply-tenant-permissions must run inside the codex-web container.");
  process.exit(1);
}
if (process.getuid?.() !== 0) {
  console.error("apply-tenant-permissions must run as root (container supervisor or docker compose exec).");
  process.exit(1);
}

const dataRoot = process.env.DATA_ROOT || "/app/data";
const tenantRoot = process.env.TENANT_ROOT || "/app/tenants";

for (const root of [dataRoot, tenantRoot]) {
  if (!root || root === "/" || root === "/app") {
    console.error(`Refusing unsafe state root: ${root}`);
    process.exit(1);
  }
}

function run(args) {
  execFileSync(args[0], args.slice(1), { stdio: "inherit" });
}

fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(tenantRoot, { recursive: true });
run(["chown", "-R", `${WEB_IDENTITY.uid}:${WEB_IDENTITY.gid}`, dataRoot]);
run(["chmod", "0700", dataRoot]);
run(["chown", `${WEB_IDENTITY.uid}:${WEB_IDENTITY.gid}`, tenantRoot]);
run(["chmod", "0711", tenantRoot]);

for (const identity of listTenantIdentities()) {
  const tenant = path.join(tenantRoot, identity.userId);
  if (!fs.existsSync(tenant)) continue;
  run(["chown", "-R", `${identity.uid}:${identity.gid}`, tenant]);
  run(["chmod", "-R", "go-rwx", tenant]);

  const directories = [];
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(absolute);
        walk(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(absolute);
      }
    }
  };
  walk(tenant);

  for (const directory of directories) {
    run(["setfacl", "-b", directory]);
    run(["setfacl", "-m", `u::rwx,u:${WEB_IDENTITY.uid}:rwx,g::---,m::rwx,o::---`, directory]);
    run(["setfacl", "-d", "-m", `u::rwx,u:${WEB_IDENTITY.uid}:rwx,u:${identity.uid}:rwx,g::---,m::rwx,o::---`, directory]);
  }
  for (const file of files) {
    run(["setfacl", "-b", file]);
    run(["setfacl", "-m", `u:${WEB_IDENTITY.uid}:rw-`, file]);
  }
}

console.log(`Codex Web tenant permissions are ready (${listTenantIdentities().length} identities).`);
