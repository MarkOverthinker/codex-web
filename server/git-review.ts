import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { GitReview, GitReviewRequest, ReviewFile } from "../src/git-review.js";

const MAX_PATCH_BYTES = 256 * 1024;

export async function readGitReview(request: GitReviewRequest): Promise<GitReview> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(environment, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  let cwd = await fs.realpath(request.workingDir);
  async function git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile("git", ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...args], {
        cwd, env: environment, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout) => error ? reject(new Error("Git 无法读取变更：请检查仓库权限、冲突状态或输出大小。")) : resolve(stdout));
      child.stdin?.on("error", () => {});
      child.stdin?.end();
    });
  }
  let root: string;
  try { root = (await git(["rev-parse", "--show-toplevel"])).trimEnd(); }
  catch { throw new Error("当前工作目录不是可读取的 Git 仓库。"); }
  root = await fs.realpath(root);
  if (request.restrictRoot && root !== cwd && !root.startsWith(`${cwd}${path.sep}`)) throw new Error("独立工作区不能查看父目录仓库，请在工作区内初始化 Git。");
  cwd = root;
  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "HEAD (detached)")).trim();
  const head = (await git(["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim() || null;
  const upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")).trim() || null;
  const divergence = upstream ? (await git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).catch(() => "")).trim().split(/\s+/).map(Number) : [];
  const remotes = (await git(["remote"])).split("\n").filter(Boolean);
  const stagedFiles = (await git(["diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--"])).split("\0").filter(Boolean);
  const conflictedFiles = [...new Set((await git(["diff", "--name-only", "--diff-filter=U", "-z", "--"])).split("\0").filter(Boolean))];
  const bases = (await git(["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"])).trim().split("\n").filter(Boolean).filter((ref) => !ref.endsWith("/HEAD"));
  let base: string | null = request.base ?? ["refs/remotes/origin/main", "refs/heads/main", "refs/remotes/origin/master", "refs/heads/master"].find((ref) => bases.includes(ref) && ref !== `refs/heads/${branch}`) ?? bases.find((ref) => ref !== `refs/heads/${branch}`) ?? null;
  let comparison = "HEAD 与工作区（包含已暂存和未暂存）";
  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", "--no-color"];
  if (request.scope === "branch") {
    if (!base || !bases.includes(base)) throw new Error("请选择有效的基准分支。");
    const baseCommit = (await git(["rev-parse", "--verify", `${base}^{commit}`])).trim();
    const mergeBase = (await git(["merge-base", "HEAD", baseCommit])).trim();
    diff.push(mergeBase, "HEAD");
    comparison = `${base.replace(/^refs\/(heads|remotes)\//, "")} 的共同祖先 → HEAD（仅已提交）`;
  } else if (request.scope === "staged") {
    diff.push("--cached");
    comparison = "HEAD 与暂存区";
  } else {
    const head = await git(["rev-parse", "--verify", "HEAD"]).catch(() => "");
    if (head) diff.push("HEAD");
    else {
      const emptyTree = (await git(["hash-object", "-t", "tree", "--stdin"])).trim();
      diff.push(emptyTree);
    }
  }
  const files: ReviewFile[] = [];
  const statuses = new Map<string, string>();
  const names = (await git([...diff, "--name-status", "-z", "--"])).split("\0");
  for (let index = 0; index + 1 < names.length; index += 2) statuses.set(names[index + 1], names[index]);
  for (const record of (await git([...diff, "--numstat", "-z", "--"])).split("\0").filter(Boolean)) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (match) files.push({ path: match[3], status: statuses.get(match[3]) ?? "M", additions: match[1] === "-" ? null : Number(match[1]), deletions: match[2] === "-" ? null : Number(match[2]) });
  }
  if (request.scope === "working") {
    for (const filename of (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)) {
      files.push({ path: filename, status: "?", additions: null, deletions: null });
    }
  }
  const result: GitReview = { root, branch, bases, base, comparison, files, head, upstream, remotes, stagedFiles, conflictedFiles,
    ahead: divergence.length === 2 ? divergence[0] : null, behind: divergence.length === 2 ? divergence[1] : null };
  if (request.file !== undefined) {
    const file = files.find((entry) => entry.path === request.file);
    if (!file) throw new Error("该文件已不在当前变更列表中，请刷新。");
    const previewRevision = request.scope === "working" ? "工作区当前文件" : request.scope === "staged" ? "暂存区版本" : "HEAD 已提交版本";
    result.preview = { content: null, revision: previewRevision, truncated: false };
    if (file.status === "?") {
      const target = path.resolve(root, file.path);
      const real = await fs.realpath(target);
      if (!real.startsWith(`${root}${path.sep}`)) throw new Error("不能预览指向仓库外的文件。");
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) result.patch = "符号链接或特殊文件，不提供内容预览。";
      else {
        const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const buffer = Buffer.alloc(MAX_PATCH_BYTES + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          result.truncated = bytesRead > MAX_PATCH_BYTES;
          const content = buffer.subarray(0, Math.min(bytesRead, MAX_PATCH_BYTES));
          result.preview = { content: content.includes(0) ? null : content.toString("utf8"), revision: previewRevision, truncated: result.truncated,
            ...(content.includes(0) ? { reason: "二进制文件，请在全部文件中预览或下载。" } : {}) };
          result.patch = content.includes(0) ? "二进制文件，不提供文本 diff。" : `@@ 新文件 @@\n${content.toString("utf8").split("\n").map((line) => `+${line}`).join("\n")}`;
        } finally { await handle.close(); }
      }
    } else {
      const patch = await git([...diff, "--patch", "--", file.path]);
      result.truncated = Buffer.byteLength(patch) > MAX_PATCH_BYTES;
      result.patch = Buffer.from(patch).subarray(0, MAX_PATCH_BYTES).toString("utf8");
      try {
        let content: Buffer;
        let truncated = false;
        if (request.scope === "working") {
          const target = path.resolve(root, file.path);
          const real = await fs.realpath(target);
          if (!real.startsWith(`${root}${path.sep}`)) throw new Error("不能预览指向仓库外的文件。");
          const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            if (!(await handle.stat()).isFile()) throw new Error("符号链接或特殊文件，不提供内容预览。");
            const buffer = Buffer.alloc(MAX_PATCH_BYTES + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            truncated = bytesRead > MAX_PATCH_BYTES;
            content = buffer.subarray(0, Math.min(bytesRead, MAX_PATCH_BYTES));
          } finally { await handle.close(); }
        } else {
          const object = (await git(["rev-parse", "--verify", request.scope === "staged" ? `:${file.path}` : `HEAD:${file.path}`])).trim();
          if (!/^[a-f0-9]{40,64}$/.test(object)) throw new Error("此版本无可预览的文件。");
          const size = Number((await git(["cat-file", "-s", object])).trim());
          if (size > MAX_PATCH_BYTES) throw new Error("此版本文件超过 256 KiB，请使用差异视图。");
          content = Buffer.from(await git(["cat-file", "blob", object]));
        }
        result.preview = { content: content.includes(0) ? null : content.toString("utf8"), revision: previewRevision, truncated,
          ...(content.includes(0) ? { reason: "二进制文件，请在全部文件中预览或下载。" } : {}) };
      } catch {
        result.preview.reason = file.status === "D" ? "该文件已在此版本中删除，可在差异视图查看原内容。" : "该文件过大、已移动或属于符号链接/特殊文件，无法提供完整预览。";
      }
    }
  }
  return result;
}
