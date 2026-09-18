#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const approvedBinaryFiles = new Set([
  "android/gradle/wrapper/gradle-wrapper.jar",
  "docs/screenshots/desktop.png",
  "docs/screenshots/mobile.png",
  "docs/screenshots/review.png",
  "public/apple-touch-icon.png",
  "public/favicon.ico",
]);
const exampleUsers = new Set(["user", "you", "test", "owner", "tenant", "cww", "runner"]);
const credentialPattern = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

export function readPrivacyPolicy(cwd) {
  const filename = path.join(cwd, ".privacy.local.json");
  if (!fs.existsSync(filename)) return { forbiddenLiterals: [] };
  const policy = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(policy.forbiddenLiterals) || policy.forbiddenLiterals.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error("Local privacy policy must contain a forbiddenLiterals array of nonempty strings");
  }
  return policy;
}

export function textPrivacyProblems(text, filename, policy = { forbiddenLiterals: [] }) {
  text = text.replaceAll("\\/", "/");
  const problems = [];
  if (policy.forbiddenLiterals.some((value) => text.toLowerCase().includes(value.toLowerCase()))) {
    problems.push("operator-specific private value");
  }
  if (credentialPattern.test(text)) problems.push("credential or private-key pattern");
  if (!filename.startsWith("licenses/")) {
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    if (emails.some((email) => !/(?:@|\.)(?:example\.(?:com|org|net|invalid|test)|users\.noreply\.github\.com)$/i.test(email) && email.toLowerCase() !== "noreply@github.com")) {
      problems.push("non-placeholder email address");
    }
    const homes = [...text.matchAll(/(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)([A-Za-z0-9_.-]+)/gi)];
    if (homes.some((match) => !exampleUsers.has(match[1].toLowerCase()))) problems.push("personal home-directory path");
  }
  return problems;
}

function privateFilename(filename) {
  const basename = path.posix.basename(filename);
  return (basename !== ".env.example" && /^\.env(?:\.|$)/.test(basename))
    || /(?:^|\/)(?:\.privacy\.local\.json|compose\.override\.ya?ml|auth\.json|credentials\.json|preview-signing\.properties|local\.properties)$/.test(filename)
    || /(?:^|\/)(?:\.zcode|\.codex|\.agents|\.signing|node_modules|data|tenants|workspaces|tmp|test-results|playwright-report)(?:\/|$)/.test(filename)
    || /\.(?:orig|rej|bak|backup|pem|key|p12|pfx|jks|keystore|sqlite(?:-wal|-shm)?|db|log|jsonl|apk|zip|tar|gz|zst)$/i.test(filename);
}

export function checkPrivacy({ cwd = process.cwd(), staged = false, revision = "HEAD", policy = readPrivacyPolicy(cwd), seenEntries = new Set() } = {}) {
  const issues = [];
  const add = (filename, problems) => problems.forEach((rule) => issues.push({ filename, rule }));
  const entries = git(cwd, staged ? ["ls-files", "--stage", "-z"] : ["ls-tree", "-r", "-z", revision]).toString("utf8").split("\0").filter(Boolean);
  for (const entry of entries) {
    const separator = entry.indexOf("\t");
    const filename = entry.slice(separator + 1);
    const fields = entry.slice(0, separator).split(" ");
    const mode = fields[0];
    const objectId = fields[staged ? 1 : 2];
    const cacheKey = `${entry}`;
    if (seenEntries.has(cacheKey)) continue;
    seenEntries.add(cacheKey);
    if (privateFilename(filename)) add(filename, ["private or generated file must not be tracked"]);
    add(filename, textPrivacyProblems(filename, filename, policy));
    if (mode !== "100644" && mode !== "100755") {
      add(filename, ["symlink or submodule requires explicit privacy review"]);
      continue;
    }
    if (staged && fields[2] !== "0") {
      add(filename, ["unmerged index entry"]);
      continue;
    }
    const content = git(cwd, ["cat-file", "blob", objectId]);
    if (content.includes(0)) {
      if (!approvedBinaryFiles.has(filename)) add(filename, ["binary content requires explicit privacy review"]);
      continue;
    }
    add(filename, textPrivacyProblems(content.toString("utf8"), filename, policy));
  }
  if (!staged) {
    const message = git(cwd, ["show", "-s", "--format=%B", revision]).toString("utf8");
    add("commit message", textPrivacyProblems(message, "commit message", policy));
  }
  return issues;
}

export function checkOutgoing({ cwd = process.cwd(), input, policy = readPrivacyPolicy(cwd) }) {
  const seenEntries = new Set();
  const seenCommits = new Set();
  const zeroId = /^0+$/;
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(fields[1]) || !/^[a-f0-9]{40,64}$/.test(fields[3])) {
      throw new Error("Invalid pre-push input");
    }
    const [, localId, remoteRef, remoteId] = fields;
    if (!/^refs\/(?:heads|tags)\//.test(remoteRef)) return [{ filename: "push", rule: "internal agent or backup refs must not be published" }];
    if (zeroId.test(localId)) continue;
    const args = ["rev-list", "--reverse", localId];
    if (!zeroId.test(remoteId)) {
      try {
        git(cwd, ["cat-file", "-e", `${remoteId}^{commit}`]);
        args.push("--not", remoteId);
      } catch {}
    }
    const revisions = git(cwd, args).toString("utf8").trim().split("\n").filter(Boolean);
    for (const revision of revisions) {
      if (seenCommits.has(revision)) continue;
      seenCommits.add(revision);
      const issues = checkPrivacy({ cwd, revision, policy, seenEntries });
      if (issues.length) return issues.map((issue) => ({ ...issue, filename: `${revision.slice(0, 12)}:${issue.filename}` }));
    }
  }
  return [];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const cwd = process.cwd();
    let issues;
    if (args.length === 2 && args[0] === "--message") {
      issues = textPrivacyProblems(fs.readFileSync(args[1], "utf8"), "commit message", readPrivacyPolicy(cwd)).map((rule) => ({ filename: "commit message", rule }));
    } else if (args.length === 1 && args[0] === "--push") {
      issues = checkOutgoing({ cwd, input: fs.readFileSync(0, "utf8") });
    } else if (args.length === 0 || (args.length === 1 && args[0] === "--staged")) {
      issues = checkPrivacy({ cwd, staged: args[0] === "--staged" });
    } else {
      throw new Error("Usage: check-public-privacy.mjs [--staged | --message FILE | --push]");
    }
    for (const issue of issues) console.error(`${issue.filename}: ${issue.rule}`);
    if (issues.length) process.exitCode = 1;
    else console.log("Privacy checks passed; manual review remains required.");
  } catch {
    console.error("Privacy check could not complete. Verify arguments, Git state, Node.js and the local JSON policy.");
    process.exitCode = 1;
  }
}
