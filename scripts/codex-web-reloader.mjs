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
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 5_000;
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
  const waitTimeoutMs = Number(process.env.CODEX_WEB_RELOADER_WAIT_TIMEOUT_MS ?? DEFAULT_WAIT_TIMEOUT_MS);
  const pollMs = Number(process.env.CODEX_WEB_RELOADER_POLL_MS ?? DEFAULT_POLL_MS);
  if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new Error(`invalid CODEX_WEB_RELOADER_WAIT_TIMEOUT_MS: ${process.env.CODEX_WEB_RELOADER_WAIT_TIMEOUT_MS}`);
  }
  if (!Number.isInteger(pollMs) || pollMs < 50) {
    throw new Error(`invalid CODEX_WEB_RELOADER_POLL_MS: ${process.env.CODEX_WEB_RELOADER_POLL_MS}`);
  }
  return {
    host: "127.0.0.1",
    port,
    token: process.env.CODEX_WEB_RELOADER_TOKEN ?? "",
    root: process.env.CODEX_WEB_RELOADER_ROOT ?? process.cwd(),
    idleCheckCommand: parseCommand(process.env.CODEX_WEB_RELOADER_IDLE_CHECK_CMD ?? "node scripts/check-codex-web-idle.mjs"),
    buildCommand: parseCommand(process.env.CODEX_WEB_RELOADER_BUILD_CMD ?? "npm run build"),
    restartCommand: parseCommand(process.env.CODEX_WEB_RELOADER_RESTART_CMD ?? "systemctl restart codex-web.service"),
    waitTimeoutMs,
    pollMs,
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

function parseIdleCheck(output) {
  try {
    const payloadLine = output.split("\n").find((line) => line.trim().startsWith("{"));
    const payload = payloadLine ? JSON.parse(payloadLine) : null;
    return {
      idle: payload?.idle === true,
      running: typeof payload?.running === "number" && Number.isInteger(payload.running) ? payload.running : -1,
      error: typeof payload?.error === "string" ? payload.error : "",
    };
  } catch {
    return { idle: false, running: -1, error: "invalid idle check output" };
  }
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
  let responded = false;
  if (busy) {
    if (state === "waiting") {
      sendJson(res, 202, {
        ok: true,
        state,
        message: "已有 reload 排队，任务结束后将自动构建并重启服务。",
        lastResult,
      });
      return;
    }
    sendJson(res, 409, {
      ok: false,
      error: "another rebuild/restart is already running",
      state,
      lastResult,
    });
    return;
  }

  busy = true;
  state = "checking";
  lastResult = null;

  const idleCheck = await runCommand(config.idleCheckCommand, config.root);
  let check = parseIdleCheck(idleCheck.output);
  if (check.running < 0) {
    state = "busy";
    busy = false;
    lastResult = {
      command: "idle-check",
      ok: false,
      finishedAt: new Date().toISOString(),
      idle: false,
      error: check.error || "cannot verify Codex Web idle state",
      output: idleCheck.output,
    };
    sendJson(res, 409, {
      ok: false,
      error: check.error || "cannot verify Codex Web idle state; restart skipped",
      state,
      lastResult,
    });
    return;
  }

  if (!check.idle) {
    state = "waiting";
    lastResult = {
      command: "idle-check",
      ok: true,
      finishedAt: new Date().toISOString(),
      idle: false,
      running: check.running,
      note: "waiting for running jobs to finish",
    };
    responded = true;
    sendJson(res, 202, {
      ok: true,
      state,
      message: "Codex Web 仍有任务运行；已排队，任务结束后将自动构建并重启服务。",
      lastResult,
    });
    const deadline = Date.now() + config.waitTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
      check = parseIdleCheck((await runCommand(config.idleCheckCommand, config.root)).output);
      if (check.idle) break;
    }
    if (!check.idle) {
      state = "wait-timeout";
      busy = false;
      lastResult = {
        command: "idle-check",
        ok: false,
        finishedAt: new Date().toISOString(),
        idle: false,
        error: check.error || `timed out waiting for jobs to finish after ${config.waitTimeoutMs} ms; restart skipped`,
        output: idleCheck.output,
      };
      return;
    }
  }

  state = "building";

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
    if (responded) return;
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
    if (responded) return;
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
  if (responded) return;
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
