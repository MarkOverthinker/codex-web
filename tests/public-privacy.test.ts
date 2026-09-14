import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const checkerModule = "../scripts/check-public-privacy.mjs";
const { checkPrivacy, readPrivacyPolicy, textPrivacyProblems } = await import(checkerModule);
const checkerPath = path.resolve("scripts/check-public-privacy.mjs");
const privateHome = ["/home", "sensitive-operator", "project"].join("/");
const privateEmail = ["operator", "personal.test"].join("@");

function fixture(context: { after: (callback: () => void) => void }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "public-privacy-"));
  context.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"]) delete env[name];
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (name: string, value: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), value);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Public contributor");
  git("config", "user.email", "contributor@example.invalid");
  return { cwd, env, git, write };
}

test("privacy checks allow examples and retain third-party attribution", () => {
  assert.deepEqual(textPrivacyProblems("https://codex.example.com /home/test/project contributor@example.invalid", "README.md"), []);
  assert.deepEqual(textPrivacyProblems(privateEmail, "licenses/vendor/NOTICE"), []);
  assert.deepEqual(textPrivacyProblems("noreply@github.com contributor@users.noreply.github.com", "commit metadata"), []);
  assert.deepEqual(textPrivacyProblems(privateHome, "README.md"), ["personal home-directory path"]);
  assert.deepEqual(textPrivacyProblems(privateEmail, "README.md"), ["non-placeholder email address"]);
  const credential = "ghp_" + "A".repeat(30);
  assert.deepEqual(textPrivacyProblems(credential, "config.txt"), ["credential or private-key pattern"]);
  assert.deepEqual(textPrivacyProblems("hidden-operator", "licenses/vendor/NOTICE", { forbiddenLiterals: ["HIDDEN-OPERATOR"] }), ["operator-specific private value"]);
});

test("privacy check scans staged bytes, not a cleaned working copy", (context) => {
  const project = fixture(context);
  project.write("README.md", privateHome);
  project.git("add", "README.md");
  project.write("README.md", "Public text");
  const issues = checkPrivacy({ cwd: project.cwd, staged: true });
  assert.ok(issues.some((issue: { rule: string }) => issue.rule === "personal home-directory path"));
  project.git("add", "README.md");
  assert.deepEqual(checkPrivacy({ cwd: project.cwd, staged: true }), []);
});

test("private filenames and unreviewed binary assets are blocked", (context) => {
  const project = fixture(context);
  for (const name of [".env", "server/app.ts.orig", ".zcode/plan.md", "android/signing.jks"]) project.write(name, "private fixture");
  project.write("docs/capture.png", Buffer.from([0, 1, 2]));
  project.git("add", ".");
  const issues = checkPrivacy({ cwd: project.cwd, staged: true });
  assert.equal(issues.filter((issue: { rule: string }) => issue.rule === "private or generated file must not be tracked").length, 4);
  assert.ok(issues.some((issue: { rule: string }) => issue.rule === "binary content requires explicit privacy review"));
});

test("commit metadata is checked independently of public file contents", (context) => {
  const project = fixture(context);
  project.write("README.md", "Public text");
  project.git("add", "README.md");
  project.git("config", "user.email", privateEmail);
  project.git("commit", "-m", "Public snapshot");
  const issues = checkPrivacy({ cwd: project.cwd });
  assert.deepEqual(issues, [{ filename: "commit metadata", rule: "non-placeholder email address" }]);
});

test("local forbidden terms stay local and malformed policy fails closed", (context) => {
  const project = fixture(context);
  project.write(".privacy.local.json", JSON.stringify({ forbiddenLiterals: ["private-host-placeholder"] }));
  project.write("README.md", "PRIVATE-HOST-PLACEHOLDER");
  project.git("add", "README.md");
  assert.ok(checkPrivacy({ cwd: project.cwd, staged: true }).some((issue: { rule: string }) => issue.rule === "operator-specific private value"));
  project.write(".privacy.local.json", JSON.stringify({ forbiddenLiterals: "invalid" }));
  assert.throws(() => readPrivacyPolicy(project.cwd), /forbiddenLiterals/);
  const result = spawnSync(process.execPath, [checkerPath, "--staged"], { cwd: project.cwd, env: project.env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not complete/);
});

test("commit-message hook rejects private values without echoing them", (context) => {
  const project = fixture(context);
  project.write("README.md", "Public text");
  project.git("add", "README.md");
  project.write("scripts/check-public-privacy.mjs", fs.readFileSync(checkerPath));
  for (const hook of ["pre-commit", "commit-msg"]) {
    project.write(`.githooks/${hook}`, fs.readFileSync(path.resolve(".githooks", hook)));
    fs.chmodSync(path.join(project.cwd, ".githooks", hook), 0o755);
  }
  project.git("config", "core.hooksPath", ".githooks");
  const result = spawnSync("git", ["commit", "-m", `Fix ${privateHome}`], { cwd: project.cwd, env: project.env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /personal home-directory path/);
  assert.ok(!result.stderr.includes(privateHome));
  project.git("commit", "-m", "Public snapshot");
  assert.deepEqual(checkPrivacy({ cwd: project.cwd }), []);
});
