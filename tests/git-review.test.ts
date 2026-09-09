import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { readGitReview } from "../server/git-review.js";
import { runGitReviewWorker } from "../server/git-review-client.js";
import { diffLines } from "../src/review-panel.js";

function fixture(context: { after(callback: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-review-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review@example.invalid");
  const write = (name: string, value: string | Buffer) => fs.writeFileSync(path.join(root, name), value);
  return { root, git, write, request: { workingDir: root, restrictRoot: true, scope: "working" as const } };
}

test("review includes staged, unstaged, deleted and literal untracked paths without changing index", async (context) => {
  const { root, git, write, request } = fixture(context);
  write("tracked.txt", "original\n"); write("deleted.txt", "delete\n");
  git("add", "."); git("commit", "-m", "initial");
  write("tracked.txt", "staged\n"); git("add", "."); write("tracked.txt", "unstaged\n");
  fs.unlinkSync(path.join(root, "deleted.txt"));
  write("中文\tfile\n.txt", "new text\n"); write(":(glob)*", "literal\n");
  write("binary.bin", Buffer.from([0, 1, 2]));
  const before = fs.readFileSync(path.join(root, ".git/index"));
  const result = await readGitReview(request);
  assert.equal(result.branch, "main"); assert.equal(result.files.length, 5);
  assert.equal(result.files.find((file) => file.path === "deleted.txt")?.status, "D");
  assert.match((await readGitReview({ ...request, file: "tracked.txt" })).patch!, /\+unstaged/);
  assert.match((await readGitReview({ ...request, scope: "staged", file: "tracked.txt" })).patch!, /\+staged/);
  assert.match((await readGitReview({ ...request, file: ":(glob)*" })).patch!, /\+literal/);
  assert.match((await readGitReview({ ...request, file: "binary.bin" })).patch!, /二进制/);
  assert.deepEqual(fs.readFileSync(path.join(root, ".git/index")), before);
  await assert.rejects(readGitReview({ ...request, file: "../outside" }), /变更列表/);
});

test("branch review uses merge base and excludes uncommitted edits", async (context) => {
  const { git, write, request } = fixture(context);
  write("base", "base\n"); git("add", "."); git("commit", "-m", "base");
  git("checkout", "-b", "feature"); write("feature", "feature\n"); git("add", "."); git("commit", "-m", "feature");
  git("checkout", "main"); write("main-only", "main\n"); git("add", "."); git("commit", "-m", "main advances");
  git("checkout", "feature"); write("untracked", "not committed\n");
  const result = await readGitReview({ ...request, scope: "branch", base: "refs/heads/main" });
  assert.deepEqual(result.files.map((file) => file.path), ["feature"]);
  await assert.rejects(readGitReview({ ...request, scope: "branch", base: "--output=/tmp/invalid" }), /有效的基准/);
});

test("unborn repositories, detached HEAD, root restrictions and bounded previews", async (context) => {
  const { root, git, write, request } = fixture(context);
  write("first", "first\n"); git("add", ".");
  assert.equal((await readGitReview(request)).files[0].status, "A");
  assert.equal((await readGitReview({ ...request, scope: "staged" })).files.length, 1);
  git("commit", "-m", "first"); git("checkout", "--detach");
  assert.match((await readGitReview(request)).branch, /detached/);
  fs.mkdirSync(path.join(root, "child"));
  await assert.rejects(readGitReview({ ...request, workingDir: path.join(root, "child") }), /父目录仓库/);
  write("large", "text\n".repeat(100_000));
  assert.equal((await readGitReview({ ...request, file: "large" })).truncated, true);
  fs.symlinkSync(os.tmpdir(), path.join(root, "outside"));
  await assert.rejects(readGitReview({ ...request, file: "outside" }), /仓库外/);
});

test("non-repository directories return a clear error", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-review-no-git-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(readGitReview({ workingDir: root, restrictRoot: true, scope: "working" }), /仓库/);
});

test("review disables repository-configured external diff and textconv", async (context) => {
  const { root, git, write, request } = fixture(context);
  write("file", "before\n"); write(".gitattributes", "file diff=unsafe\n"); git("add", "."); git("commit", "-m", "initial");
  git("config", "diff.unsafe.textconv", `touch ${root}/executed`);
  git("config", "diff.external", `touch ${root}/executed`);
  write("file", "after\n");
  assert.match((await readGitReview({ ...request, file: "file" })).patch!, /\+after/);
  assert.equal(fs.existsSync(path.join(root, "executed")), false);
});

test("compiled review worker returns structured results", async (context) => {
  const { request } = fixture(context);
  const { runGitReviewWorker: compiled } = await import("../dist-server/server/git-review-client.js");
  assert.equal((await compiled(request)).branch, "main");
  assert.equal((await runGitReviewWorker(request)).branch, "main");
});

test("diff lines have independent old and new line numbers", () => {
  const lines = diffLines("--- a/file\n+++ b/file\n@@ -2,2 +4,2 @@\n keep\n-old\n+new");
  assert.equal(lines[1].kind, "context");
  assert.deepEqual(lines.slice(3).map((line) => [line.old, line.next]), [[2, 4], [3, null], [null, 5]]);
  assert.equal(diffLines("@@ 新文件 @@\n+new")[1].kind, "add");
});
