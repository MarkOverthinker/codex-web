import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const checkerModule = "../scripts/check-public-privacy.mjs";
const { checkPrivacy, checkOutgoing, readPrivacyPolicy, textPrivacyProblems } = await import(checkerModule);
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
  assert.deepEqual(textPrivacyProblems(privateHome.replaceAll("/", "\\/"), "README.md"), ["personal home-directory path"]);
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

test("normal author and committer identities are preserved and accepted", (context) => {
  const project = fixture(context);
  project.write("README.md", "Public text");
  project.git("add", "README.md");
  project.git("config", "user.email", privateEmail);
  project.git("commit", "-m", "Public snapshot");
  const issues = checkPrivacy({ cwd: project.cwd });
  assert.deepEqual(issues, []);
  assert.deepEqual(checkPrivacy({ cwd: project.cwd, staged: true, policy: { forbiddenLiterals: [privateEmail] } }), []);
  assert.equal(project.git("log", "-1", "--format=%ae"), privateEmail);
  assert.equal(project.git("log", "-1", "--format=%ce"), privateEmail);
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


test("outgoing checks reject a private intermediate snapshot even after cleanup", (context) => {
  const project = fixture(context);
  project.write("README.md", "Public text");
  project.git("add", "README.md");
  project.git("commit", "-m", "Initial public snapshot");
  const remoteId = project.git("rev-parse", "HEAD");
  project.write("README.md", privateHome);
  project.git("add", "README.md");
  project.git("commit", "-m", "Intermediate snapshot");
  project.write("README.md", "Public text again");
  project.git("add", "README.md");
  project.git("commit", "-m", "Clean final snapshot");
  const localId = project.git("rev-parse", "HEAD");
  assert.deepEqual(checkPrivacy({ cwd: project.cwd }), []);
  const input = `refs/heads/main ${localId} refs/heads/main ${remoteId}\n`;
  assert.ok(checkOutgoing({ cwd: project.cwd, input }).some((issue: { rule: string }) => issue.rule === "personal home-directory path"));
});

test("outgoing checks cover messages and reject internal refs", (context) => {
  const project = fixture(context);
  project.write("README.md", "Public text");
  project.git("add", "README.md");
  project.git("commit", "-m", "Initial public snapshot");
  const remoteId = project.git("rev-parse", "HEAD");
  project.git("commit", "--allow-empty", "-m", `Inspect ${privateHome}`);
  const localId = project.git("rev-parse", "HEAD");
  const input = `refs/heads/main ${localId} refs/heads/main ${remoteId}\n`;
  assert.ok(checkOutgoing({ cwd: project.cwd, input }).some((issue: { filename: string }) => issue.filename.endsWith(":commit message")));
  const internal = `refs/backup/local ${localId} refs/backup/local ${"0".repeat(40)}\n`;
  assert.deepEqual(checkOutgoing({ cwd: project.cwd, input: internal }), [{ filename: "push", rule: "internal agent or backup refs must not be published" }]);
});

test("outgoing checks accept public changes with normal Git identities", (context) => {
  const project = fixture(context);
  project.git("config", "user.email", privateEmail);
  project.write("README.md", "Public text");
  project.git("add", "README.md");
  project.git("commit", "-m", "Initial public snapshot");
  const localId = project.git("rev-parse", "HEAD");
  const input = `refs/heads/main ${localId} refs/heads/main ${"0".repeat(40)}\n`;
  assert.deepEqual(checkOutgoing({ cwd: project.cwd, input }), []);
  assert.throws(() => checkOutgoing({ cwd: project.cwd, input: "invalid input" }), /Invalid pre-push input/);
});
