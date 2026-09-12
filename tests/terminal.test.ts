import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TerminalBuffer, TerminalError, TerminalManager } from "../server/terminal-manager.js";
import { terminalCommand, type TerminalContext, type TerminalSnapshot } from "../src/terminal-protocol.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("terminal buffer bounds replay, detects gaps, and pages output without losing the cursor", () => {
  const buffer = new TerminalBuffer(8);
  buffer.append("你好123");
  assert.deepEqual(buffer.read(0), { data: "你好123", cursor: 5, truncated: false });
  buffer.append("456789");
  assert.deepEqual(buffer.read(0), { data: "23456789", cursor: 11, truncated: true });
  assert.deepEqual(buffer.read(8), { data: "789", cursor: 11, truncated: false });
  assert.equal(buffer.read(11).data, "");
  assert.throws(() => buffer.read(12), TerminalError);
  const large = new TerminalBuffer();
  large.append("a".repeat(70000));
  assert.equal(large.read(0).cursor, 65536);
  assert.equal(large.read(65536).data.length, 4464);
});

test("terminal protocol rejects oversized input, invalid dimensions and injected actions", () => {
  const terminalId = crypto.randomUUID();
  for (const input of [
    { action: "open", cols: 0, rows: 24 }, { action: "open", cols: 80, rows: 1.5 },
    { action: "write", terminalId, data: "x".repeat(8193) }, { action: "write", terminalId: "../other", data: "ls" },
    { action: "read", terminalId, after: -1 }, { action: "exec", command: "whoami" },
  ]) assert.equal(terminalCommand.safeParse(input).success, false);
});

test("real PTY retains shell state, isolates environment, resizes, interrupts and closes descendants", { skip: process.platform !== "linux", timeout: 20000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-terminal-"));
  fs.chmodSync(root, 0o777);
  const childDirectory = path.join(root, "child");
  fs.mkdirSync(childDirectory, { mode: 0o777 });
  const manager = new TerminalManager();
  context.after(() => { manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.CWW_TERMINAL_TEST_SECRET; });
  process.env.CWW_TERMINAL_TEST_SECRET = "must-not-reach-shell";
  const identity: TerminalContext = { userId: "first", conversationId: "task", cwd: root, home: root, uid: process.getuid!() || 65534, gid: process.getgid!() || 65534, restrictRoot: root };
  const opened = await manager.execute(identity, { action: "open", cols: 80, rows: 24 });
  assert.ok("terminalId" in opened);
  const terminalId = opened.terminalId;
  assert.deepEqual(await manager.execute(identity, { action: "open", cols: 80, rows: 24 }), opened);
  await assert.rejects(manager.execute({ ...identity, userId: "second" }, { action: "read", terminalId, after: 0 }), (error: unknown) => error instanceof TerminalError && error.status === 404);
  await assert.rejects(manager.execute({ ...identity, conversationId: "other" }, { action: "write", terminalId, data: "whoami\n" }), (error: unknown) => error instanceof TerminalError && error.status === 404);
  let cursor = 0;
  let output = "";
  const until = async (pattern: RegExp) => {
    for (let attempts = 0; attempts < 100; attempts++) {
      const snapshot = await manager.execute(identity, { action: "read", terminalId, after: cursor }) as TerminalSnapshot;
      output += snapshot.data; cursor = snapshot.cursor;
      if (pattern.test(output)) return;
      await pause(40);
    }
    assert.fail(`Missing ${pattern} in ${output}`);
  };
  const write = (data: string) => manager.execute(identity, { action: "write", terminalId, data });
  await write("stty -echo; test -t 0 && printf 'CWW-%s\\n' tty; printf 'SECRET:%s\\n' \"${CWW_TERMINAL_TEST_SECRET-unset}\"\n");
  await until(/CWW-tty/); await until(/SECRET:unset/);
  assert.ok(!output.includes("must-not-reach-shell"));
  await write("cd child; printf 'CWD:%s\\n' \"$PWD\"; printf '中文:%s\\n' 正常\n");
  await until(new RegExp(`CWD:${childDirectory}`)); await until(/中文:正常/);
  await manager.execute(identity, { action: "resize", terminalId, cols: 90, rows: 30 });
  await write("stty size\n"); await until(/30 90/);
  await write("printf 'UID:%s\\n' $(id -u)\n"); await until(new RegExp(`UID:${identity.uid}`));
  await write("sleep 60\n"); await pause(100); await write("\u0003");
  await write("printf 'CWW-%s\\n' interrupted\n"); await until(/CWW-interrupted/);
  await write("sleep 60 & printf 'CHILD:%s\\n' $!\n"); await until(/CHILD:\d+/);
  const childPid = Number(/CHILD:(\d+)/.exec(output)![1]);
  await manager.execute(identity, { action: "close", terminalId });
  await assert.rejects(manager.execute(identity, { action: "read", terminalId, after: 0 }), TerminalError);
  let alive = true;
  for (let attempts = 0; attempts < 50; attempts++) {
    try { alive = !fs.readFileSync(`/proc/${childPid}/stat`, "utf8").includes(") Z "); } catch { alive = false; }
    if (!alive) break;
    await pause(40);
  }
  assert.equal(alive, false, "closing a terminal must stop background descendants");
});

test("terminal rejects root, expires disconnected sessions and enforces per-user quotas", { skip: process.platform !== "linux", timeout: 20000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-terminal-limits-"));
  fs.chmodSync(root, 0o777);
  const manager = new TerminalManager();
  const expiring = new TerminalManager(100);
  context.after(() => { manager.dispose(); expiring.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const identity: TerminalContext = { userId: "first", conversationId: "task", cwd: root, home: root, uid: process.getuid!() || 65534, gid: process.getgid!() || 65534 };
  const open = { action: "open", cols: 80, rows: 24 } as const;
  await assert.rejects(manager.execute({ ...identity, uid: 0 }, open), TerminalError);
  await assert.rejects(manager.execute({ ...identity, restrictRoot: path.join(root, "missing") }, open), TerminalError);
  const escape = path.join(root, "escape");
  fs.symlinkSync(os.tmpdir(), escape);
  await assert.rejects(manager.execute({ ...identity, cwd: escape, restrictRoot: root }, open), TerminalError);
  for (let index = 0; index < 3; index++) await manager.execute({ ...identity, conversationId: String(index) }, open);
  await assert.rejects(manager.execute(identity, open), (error: unknown) => error instanceof TerminalError && error.status === 429);
  await manager.execute({ ...identity, conversationId: "0" }, { action: "close-task" });
  const replacement = await manager.execute(identity, open);
  assert.ok("terminalId" in replacement);
  await manager.execute({ ...identity, userId: "other" }, { action: "close-task" });
  assert.ok("data" in await manager.execute(identity, { action: "read", terminalId: replacement.terminalId, after: 0 }));
  await manager.execute(identity, { action: "close-task" });
  await assert.rejects(manager.execute(identity, { action: "read", terminalId: replacement.terminalId, after: 0 }), TerminalError);
  const session = await expiring.execute(identity, open);
  assert.ok("terminalId" in session);
  await pause(250);
  await assert.rejects(expiring.execute(identity, { action: "read", terminalId: session.terminalId, after: 0 }), (error: unknown) => error instanceof TerminalError && error.status === 404);
});

test("terminal long reads wake on output without a polling interval and release cancelled readers", { skip: process.platform !== "linux", timeout: 20000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-terminal-events-"));
  fs.chmodSync(root, 0o777);
  const manager = new TerminalManager();
  context.after(() => { manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const identity: TerminalContext = { userId: "first", conversationId: "task", cwd: root, home: root, uid: process.getuid!() || 65534, gid: process.getgid!() || 65534 };
  const opened = await manager.execute(identity, { action: "open", cols: 80, rows: 24 });
  assert.ok("terminalId" in opened);
  const terminalId = opened.terminalId;
  let cursor = 0;
  const quiet = async () => {
    for (let attempts = 0; attempts < 30; attempts++) {
      const result = await manager.execute(identity, { action: "read", terminalId, after: cursor, waitMs: 60 }) as TerminalSnapshot;
      cursor = result.cursor;
      if (!result.data) return;
    }
    assert.fail("terminal did not become idle");
  };
  await manager.execute(identity, { action: "write", terminalId, data: "stty -echo\n" });
  await quiet();
  let completed = false;
  const pending = manager.execute(identity, { action: "read", terminalId, after: cursor, waitMs: 10000 }).then((result) => { completed = true; return result as TerminalSnapshot; });
  await pause(40);
  assert.equal(completed, false, "idle reads must wait rather than return an empty response");
  const started = performance.now();
  await manager.execute(identity, { action: "write", terminalId, data: "printf 'EVENT:%s\\n' ready\n" });
  const output = await pending;
  const latency = performance.now() - started;
  assert.ok(output.data.length > 0);
  assert.ok(latency < 500, `output wakeup took ${latency}ms`);
  context.diagnostic(`PTY input-to-first-output wakeup: ${latency.toFixed(1)}ms (local, not network latency)`);
  cursor = output.cursor;
  await quiet();
  const controller = new AbortController();
  const readers = Array.from({ length: 8 }, () => assert.rejects(manager.execute(identity, { action: "read", terminalId, after: cursor, waitMs: 10000 }, controller.signal), { name: "AbortError" }));
  await assert.rejects(manager.execute(identity, { action: "read", terminalId, after: cursor, waitMs: 10000 }), (error: unknown) => error instanceof TerminalError && error.status === 429);
  controller.abort();
  await Promise.all(readers);
  const timeout = await manager.execute(identity, { action: "read", terminalId, after: cursor, waitMs: 30 }) as TerminalSnapshot;
  assert.equal(timeout.data, "");
  const closingRead = assert.rejects(manager.execute(identity, { action: "read", terminalId, after: cursor, waitMs: 10000 }), (error: unknown) => error instanceof TerminalError && error.status === 404);
  await manager.execute(identity, { action: "close", terminalId });
  await closingRead;
});
