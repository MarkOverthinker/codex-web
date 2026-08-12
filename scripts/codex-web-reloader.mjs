#!/usr/bin/env node
// Root control service for Codex Web host mode.
//
// The service listens on loopback only and, after an authenticated request,
// rebuilds the checkout and restarts the root systemd unit that runs
// codex-web. It never restarts the service when the build fails.
import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const DEFAULT_PORT = 37822;
const MAX_COMMAND_LOG_BYTES = 128 * 1024;

function parseCommand(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("empty command in CODEX_WEB_RELOADER_BUILD_CMD or CODEX_WEB_RELOADER_RESTART_CMD");
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || parsed.length === 0) {
      throw new Error("JSON command must be a non-empty string array");
    }
    return { cmd: parsed[0], args: parsed.slice(1) };
  }
  const parts = trimmed.match(/"[^"]*"|\S+/g) ?? [];
  const argv = parts.map((part) => {
    if (part.length >= 2 && part.startsWith('"') && part.endsWith('"')) {
      return part.slice(1, -1);
    }
    return part;
  });
  return { cmd: argv[0], args: argv.slice(1) };
}

function loadConfig() {
  const port = Number(process.env.CODEX_WEB_RELOADER_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid CODEX_WEB_RELOADER_PORT: ${process.env.CODEX_WEB_RELOADER_PORT}`);
  }
  return {
    host: "127.0.0.1",
    port,
    token: process.env.CODEX_WEB_RELOADER_TOKEN ?? "",
    root: process.env.CODEX_WEB_RELOADER_ROOT ?? process.cwd(),
    buildCommand: parseCommand(process.env.CODEX_WEB_RELOADER_BUILD_CMD ?? "npm run build"),
    restartCommand: parseCommand(process.env.CODEX_WEB_RELOADER_RESTART_CMD ?? "systemctl restart codex-web.service"),
  };
}

function runCommand(command, cwd) {
  return new Promise((resolve) => {
    let output = "";
    const append = (chunk) => {
      if (output.length < MAX_COMMAND_LOG_BYTES) {
        output += chunk.toString();
      }
    };
    let child;
    try {
      child = spawn(command.cmd, command.args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, output: String(error?.message ?? error) });
      return;
    }
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      resolve({ ok: false, output: output.trim() || String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorized(req, token) {
  if (!token) return false;
  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!provided) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const config = loadConfig();
let state = "idle";
let busy = false;
let lastResult = null;

async function handleRestart(res) {
  if (busy) {
    sendJson(res, 409, {
      ok: false,
      error: "another rebuild/restart is already running",
      state,
      lastResult,
    });
    return;
  }

  busy = true;
  state = "building";
  lastResult = null;

  const build = await runCommand(config.buildCommand, config.root);
  if (!build.ok) {
    state = "build-failed";
    busy = false;
    lastResult = {
      command: "build",
      ok: false,
      finishedAt: new Date().toISOString(),
      output: build.output,
    };
    console.error(`build failed:\n${build.output}`);
    sendJson(res, 500, { ok: false, error: "build failed; codex-web.service was not restarted", state, lastResult });
    return;
  }

  state = "restarting";
  console.log(`build succeeded; restarting ${config.restartCommand.cmd}`);
  const restart = await runCommand(config.restartCommand, config.root);
  if (!restart.ok) {
    state = "restart-failed";
    busy = false;
    lastResult = {
      command: "restart",
      ok: false,
      finishedAt: new Date().toISOString(),
      output: restart.output,
    };
    console.error(`restart failed:\n${restart.output}`);
    sendJson(res, 500, { ok: false, error: "restart command failed", state, lastResult });
    return;
  }

  state = "idle";
  busy = false;
  lastResult = {
    command: "restart",
    ok: true,
    finishedAt: new Date().toISOString(),
  };
  sendJson(res, 200, {
    ok: true,
    state,
    lastResult,
    build: { ok: true, output: build.output },
    restart: { ok: true, output: restart.output },
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/status") {
      sendJson(res, 200, { ok: true, state, busy, lastResult });
      return;
    }
    if (req.method === "POST" && url.pathname === "/restart") {
      if (!authorized(req, config.token)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      await handleRestart(res);
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
});

server.listen(config.port, config.host, () => {
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : config.port;
  console.log(`codex-web-reloader listening on http://127.0.0.1:${actualPort}`);
});

function shutdown(signal) {
  console.log(`received ${signal}; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
