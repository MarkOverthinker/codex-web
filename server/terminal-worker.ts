import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as pty from "node-pty";
import { terminalCommand } from "../src/terminal-protocol.js";

let terminal: pty.IPty | undefined;
let closing = false;
function send(value: unknown): void {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) terminal?.pause();
}
process.stdout.on("drain", () => terminal?.resume());
function killTree(pid: number): void {
  try {
    const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    for (const child of children) killTree(Number(child));
  } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}
function close(): void {
  if (closing) return;
  closing = true;
  if (terminal) killTree(terminal.pid);
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
process.stdout.on("error", close);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("close", close);
input.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (!terminal) {
      if (message.action !== "start" || !process.getuid?.() || process.getuid() !== message.uid || process.getgid?.() !== message.gid) throw new Error("终端必须以非 root 的目标用户运行。");
      const cwd = fs.realpathSync(message.cwd);
      if (!fs.statSync(cwd).isDirectory()) throw new Error("终端工作目录不存在。");
      if (message.restrictRoot) {
        const root = fs.realpathSync(message.restrictRoot);
        const relative = path.relative(root, cwd);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("终端目录超出工作区。");
      }
      terminal = pty.spawn("/bin/bash", ["--noprofile", "--norc", "-i"], {
        name: "xterm-256color", cols: message.cols, rows: message.rows, cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", HISTFILE: "/dev/null", PS1: "\\u@\\h:\\w\\$ " },
      });
      terminal.onData((data) => send({ type: "data", data }));
      terminal.onExit(({ exitCode }) => { send({ type: "exit", exitCode }); process.exit(0); });
      send({ type: "ready" });
      return;
    }
    const command = terminalCommand.parse(message);
    if (command.action === "write") terminal.write(command.data);
    if (command.action === "resize") terminal.resize(command.cols, command.rows);
    if (command.action === "close") close();
  } catch (error) {
    send({ type: "error", error: error instanceof Error ? error.message : "终端启动失败。" });
    close();
  }
});
