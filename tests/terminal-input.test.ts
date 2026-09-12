import assert from "node:assert/strict";
import test from "node:test";
import { TerminalInputQueue } from "../src/terminal-input.js";

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("terminal input merges keys behind one in-flight request instead of queuing one request per key", async () => {
  const sent: string[] = [];
  let release: () => void = () => {};
  const queue = new TerminalInputQueue(async (data) => {
    sent.push(data);
    if (sent.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  }, assert.fail);
  queue.write("p");
  await pause(15);
  assert.deepEqual(sent, ["p"]);
  for (const key of "wd\r") queue.write(key);
  await pause(15);
  assert.deepEqual(sent, ["p"]);
  release();
  await pause(15);
  assert.deepEqual(sent, ["p", "wd\r"]);
  queue.dispose();
});

test("terminal input bounds paste size, preserves Unicode chunk boundaries and drops ambiguous failed writes", async () => {
  const sent: string[] = [];
  const queue = new TerminalInputQueue(async (data) => { sent.push(data); }, assert.fail);
  const text = `${"a".repeat(4095)}😀中文\r`;
  assert.equal(queue.write("a".repeat(32769)), false);
  assert.equal(queue.write(text), true);
  await pause(30);
  assert.equal(sent.join(""), text);
  assert.ok(sent.every((data) => data.length <= 4096 && data.isWellFormed()));
  queue.dispose();
  assert.equal(queue.write("ignored"), false);
  let failures = 0;
  let sends = 0;
  const broken = new TerminalInputQueue(async () => { sends++; throw new Error("network lost"); }, () => { failures++; });
  broken.write("first");
  await pause(20);
  assert.equal(broken.write("do not replay"), false);
  await pause(20);
  assert.equal(sends, 1);
  assert.equal(failures, 1);
  broken.dispose();
});
