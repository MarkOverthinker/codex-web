#!/usr/bin/env node
// Report whether Codex Web has running jobs. codex-web-reloader runs this
// before restarting the service so reloads never interrupt active work.
// The output is a single JSON line: { idle, running, error? }.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataRoot = process.env.CODEX_WEB_DATA_ROOT ?? path.join(process.cwd(), "data");
const dbPath = path.join(dataRoot, "codex-web.sqlite");

function report(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

let db;
try {
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const row = db.prepare("SELECT COUNT(*) AS running FROM jobs WHERE status='running'").get();
  const running = Number(row?.running ?? 0);
  report({ idle: running === 0, running });
} catch (error) {
  // Fail closed: when the database cannot be verified, treat Codex Web as
  // busy so the reloader refuses to restart instead of risking interruption.
  report({ idle: false, running: -1, error: String(error?.message ?? error) });
} finally {
  db?.close();
}
