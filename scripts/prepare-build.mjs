#!/usr/bin/env node
// Guard `vite build` against partially wiping dist/.
//
// Vite empties its outDir before writing the new bundle. When dist/ contains
// files the current user cannot delete (for example, a previous build created
// by root through codex-web-reloader), Vite removes the entries it can and
// then aborts with EACCES, leaving a half-wiped bundle without index.html.
// This check runs before Vite so the build fails before any deletion.
import fs from "node:fs";
import path from "node:path";

const distPath = path.join(process.cwd(), "dist");

function firstUnwritableDirectory(root) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    try {
      // Deleting any entry in a directory needs write + execute on the
      // directory itself, and emptying a subdirectory recursively needs the
      // same on every directory below it.
      fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      return dir;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return dir;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  return null;
}

const blocked = firstUnwritableDirectory(distPath);
if (blocked) {
  const stat = fs.statSync(blocked);
  console.error(`error: cannot safely rebuild dist/ — ${blocked} is not writable by the current user (owner uid ${stat.uid}).`);
  console.error("The build must empty dist/ before writing the new bundle, but some files there were");
  console.error("created by another user (e.g. root via codex-web-reloader). Aborting before deleting");
  console.error("anything so the existing bundle is not left broken.");
  console.error("");
  console.error("Fix ownership first, then re-run the build:");
  console.error(`  sudo chown -R "$(id -un):$(id -gn)" dist dist-server`);
  console.error("or trigger the normal root-managed rebuild:");
  console.error("  npm run reload");
  process.exit(1);
}
