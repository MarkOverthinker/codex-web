import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const TOKEN = "test-token";

function waitForListeningUrl(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderrBuffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/codex-web-reloader listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new Error(`${error.message}\n${stderrBuffer}`));
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`reloader exited early with code ${code}\n${stderrBuffer}`));
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function runWithOutput(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("codex-web-reloader rebuilds, restarts, and rejects unauthenticated requests", async (t) => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-web-reloader-"));
  const buildLog = path.join(tmp, "build.log");
  const restartLog = path.join(tmp, "restart.log");
  const failMarker = path.join(tmp, "fail");
  const busyMarker = path.join(tmp, "busy");
  const unreadableMarker = path.join(tmp, "unreadable");
  const tokenFile = path.join(tmp, "token");

  const mockBuild = path.join(tmp, "mock-build.mjs");
  const mockRestart = path.join(tmp, "mock-restart.mjs");
  const mockIdleCheck = path.join(tmp, "mock-idle-check.mjs");
  await fs.promises.writeFile(
    mockBuild,
    `import fs from "node:fs";
if (process.env.CODEX_WEB_RELOADER_FAIL_MARKER && fs.existsSync(process.env.CODEX_WEB_RELOADER_FAIL_MARKER)) {
  console.error("mock build failed");
  process.exit(1);
}
fs.appendFileSync(process.env.CODEX_WEB_RELOADER_BUILD_LOG, "build ok\\n");
console.log("mock build ok");
`,
  );
  await fs.promises.writeFile(
    mockRestart,
    `import fs from "node:fs";
fs.appendFileSync(process.env.CODEX_WEB_RELOADER_RESTART_LOG, "restart ok\\n");
console.log("mock restart ok");
`,
  );
  await fs.promises.writeFile(
    mockIdleCheck,
    `import fs from "node:fs";
if (process.env.CODEX_WEB_RELOADER_UNREADABLE_MARKER && fs.existsSync(process.env.CODEX_WEB_RELOADER_UNREADABLE_MARKER)) {
  console.log(JSON.stringify({ idle: false, running: -1, error: "db missing" }));
} else if (process.env.CODEX_WEB_RELOADER_BUSY_MARKER && fs.existsSync(process.env.CODEX_WEB_RELOADER_BUSY_MARKER)) {
  console.log(JSON.stringify({ idle: false, running: 1 }));
} else {
  console.log(JSON.stringify({ idle: true, running: 0 }));
}
`,
  );

  const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "codex-web-reloader.mjs")], {
    env: {
      ...process.env,
      CODEX_WEB_RELOADER_PORT: "0",
      CODEX_WEB_RELOADER_TOKEN: TOKEN,
      CODEX_WEB_RELOADER_ROOT: tmp,
      CODEX_WEB_RELOADER_IDLE_CHECK_CMD: JSON.stringify([process.execPath, mockIdleCheck]),
      CODEX_WEB_RELOADER_BUILD_CMD: JSON.stringify([process.execPath, mockBuild]),
      CODEX_WEB_RELOADER_RESTART_CMD: JSON.stringify([process.execPath, mockRestart]),
      CODEX_WEB_RELOADER_BUILD_LOG: buildLog,
      CODEX_WEB_RELOADER_RESTART_LOG: restartLog,
      CODEX_WEB_RELOADER_FAIL_MARKER: failMarker,
      CODEX_WEB_RELOADER_BUSY_MARKER: busyMarker,
      CODEX_WEB_RELOADER_UNREADABLE_MARKER: unreadableMarker,
      CODEX_WEB_RELOADER_POLL_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  const baseUrl = await waitForListeningUrl(child);

  const status = await fetch(`${baseUrl}/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).state, "idle");

  const noToken = await fetch(`${baseUrl}/restart`, { method: "POST", body: JSON.stringify({ command: "restart" }) });
  assert.equal(noToken.status, 401);

  const wrongToken = await fetch(`${baseUrl}/restart`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token" },
    body: JSON.stringify({ command: "restart" }),
  });
  assert.equal(wrongToken.status, 401);

  const ok = await fetch(`${baseUrl}/restart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command: "restart" }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).state, "idle");
  assert.match(await fs.promises.readFile(buildLog, "utf8"), /build ok/);
  assert.match(await fs.promises.readFile(restartLog, "utf8"), /restart ok/);

  await fs.promises.writeFile(tokenFile, `${TOKEN}\n`);
  const client = await runWithOutput(process.execPath, [path.join(process.cwd(), "scripts", "reload-codex-web.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_WEB_RELOADER_URL: baseUrl,
      CODEX_WEB_RELOADER_TOKEN_FILE: tokenFile,
    },
  });
  assert.equal(client.code, 0, client.stderr);
  assert.match(client.stdout, /"ok":true/);

  await fs.promises.writeFile(failMarker, "fail");
  const failed = await fetch(`${baseUrl}/restart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command: "restart" }),
  });
  assert.equal(failed.status, 500);
  const failedBody = await failed.json();
  assert.equal(failedBody.state, "build-failed");
  assert.match(failedBody.lastResult.output, /mock build failed/);

  const restartLogAfterFailure = await fs.promises.readFile(restartLog, "utf8");
  assert.equal(restartLogAfterFailure.match(/restart ok/g)?.length ?? 0, 2);
  await fs.promises.rm(failMarker);

  const buildRunsBeforeQueue = (await fs.promises.readFile(buildLog, "utf8")).match(/build ok/g)?.length ?? 0;
  const restartRunsBeforeQueue = (await fs.promises.readFile(restartLog, "utf8")).match(/restart ok/g)?.length ?? 0;

  await fs.promises.writeFile(unreadableMarker, "unreadable");
  const unreadable = await fetch(`${baseUrl}/restart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command: "restart" }),
  });
  assert.equal(unreadable.status, 409);
  const unreadableBody = await unreadable.json();
  assert.equal(unreadableBody.state, "busy");
  assert.equal(unreadableBody.ok, false);
  assert.match(unreadableBody.error, /db missing/);
  await fs.promises.rm(unreadableMarker);

  await fs.promises.writeFile(busyMarker, "busy");
  const busy = await fetch(`${baseUrl}/restart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command: "restart" }),
  });
  assert.equal(busy.status, 202);
  const busyBody = await busy.json();
  assert.equal(busyBody.state, "waiting");
  assert.equal(busyBody.ok, true);
  assert.equal(busyBody.lastResult.command, "idle-check");
  const buildLogAfterBusy = await fs.promises.readFile(buildLog, "utf8");
  const restartLogAfterBusy = await fs.promises.readFile(restartLog, "utf8");
  assert.equal(buildLogAfterBusy.match(/build ok/g)?.length ?? 0, buildRunsBeforeQueue);
  assert.equal(restartLogAfterBusy.match(/restart ok/g)?.length ?? 0, restartRunsBeforeQueue);

  const busyClient = await runWithOutput(process.execPath, [path.join(process.cwd(), "scripts", "reload-codex-web.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_WEB_RELOADER_URL: baseUrl,
      CODEX_WEB_RELOADER_TOKEN_FILE: tokenFile,
      CODEX_WEB_RELOADER_BUSY_MARKER: busyMarker,
    },
  });
  assert.equal(busyClient.code, 0, busyClient.stderr);
  assert.match(busyClient.stdout, /排队/);

  await fs.promises.rm(busyMarker);
  let finalState = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await (await fetch(`${baseUrl}/status`)).json();
    if (status.state === "idle" && status.lastResult?.command === "restart") {
      finalState = status.state;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(finalState, "idle");
  const buildLogAfterQueue = await fs.promises.readFile(buildLog, "utf8");
  const restartLogAfterQueue = await fs.promises.readFile(restartLog, "utf8");
  assert.ok((buildLogAfterQueue.match(/build ok/g)?.length ?? 0) > buildRunsBeforeQueue);
  assert.ok((restartLogAfterQueue.match(/restart ok/g)?.length ?? 0) > restartRunsBeforeQueue);
});
