import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { GitReview, GitReviewRequest } from "../src/git-review.js";
import type { SupervisorToWebMessage, WebToSupervisorMessage } from "./tenant-worker-protocol.js";

export function runGitReviewWorker(request: GitReviewRequest, identity?: { uid: number; gid: number; home?: string }): Promise<GitReview> {
  return new Promise((resolve, reject) => {
    const sourceMode = import.meta.url.endsWith(".ts");
    const workerPath = fileURLToPath(new URL(sourceMode ? "./git-review-worker.ts" : "./git-review-worker.js", import.meta.url));
    const worker = execFile(process.execPath, [...(sourceMode ? ["--import", "tsx"] : []), workerPath], {
      uid: identity?.uid, gid: identity?.gid, timeout: 30_000, maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, ...(identity?.home ? { HOME: identity.home } : {}) },
    }, (error, stdout) => {
      if (error) return reject(new Error("读取 Git 变更超时或失败。"));
      try {
        const payload = JSON.parse(stdout);
        if (payload.error) reject(new Error(payload.error));
        else resolve(payload.result);
      } catch { reject(new Error("Git worker 返回了无效结果。")); }
    });
    worker.stdin?.on("error", () => {});
    worker.stdin?.end(JSON.stringify(request));
  });
}

export function requestIsolatedGitReview(userId: string, request: GitReviewRequest): Promise<GitReview> {
  if (!process.send || !process.connected) return Promise.reject(new Error("租户隔离服务不可用。"));
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const cleanup = () => { clearTimeout(timer); process.off("message", receive); process.off("disconnect", disconnected); };
    const disconnected = () => { cleanup(); reject(new Error("租户隔离服务已断开。")); };
    const receive = (message: SupervisorToWebMessage) => {
      if (message.kind !== "git_review_result" || message.requestId !== requestId) return;
      cleanup();
      if (message.error) reject(new Error(message.error));
      else if (message.result) resolve(message.result);
      else reject(new Error("Git worker 返回了空结果。"));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("读取 Git 变更超时。")); }, 35_000);
    process.on("message", receive);
    process.once("disconnect", disconnected);
    const message: WebToSupervisorMessage = { kind: "git_review", requestId, userId, request };
    process.send!(message, (error) => { if (error) { cleanup(); reject(error); } });
  });
}
