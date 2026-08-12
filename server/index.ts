import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { createApp } from "./app.js";
import { assertProductionConfig } from "./config.js";

const { app, db, config, runner, beginShutdown } = createApp();
assertProductionConfig(config);
fs.mkdirSync(path.join(config.dataRoot, "logs"), { recursive: true });
const logger = pino(pino.destination({ dest: path.join(config.dataRoot, "logs", "app.log"), sync: false }));

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, basePath: config.basePath }, "Codex Web started");
});

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  beginShutdown();
  logger.info({ signal }, "Codex Web stopping");
  while (db.runningJobCount() > 0 || runner.activeJobCount > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  logger.info("Running jobs drained; closing network services");
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
