import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const upgradeScript = path.resolve("scripts/upgrade.sh");
const supported = process.platform === "linux" && spawnSync("zstd", ["--version"]).status === 0;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-offline-upgrade-"));
  function write(relative: string, value: string) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value, { mode: 0o755 });
  }
  for (const prefix of ["old", "source/codex-web"]) {
    write(`${prefix}/start.sh`, "#!/bin/sh\nexit 0\n");
    write(`${prefix}/app/dist/index.html`, prefix);
    write(`${prefix}/app/dist-server/server/index.js`, prefix);
    write(`${prefix}/app/node_modules/version`, prefix);
    write(`${prefix}/app/data/python/bin/uv`, prefix);
  }
  write("old/app/.env", "PORT=39999\nBASE_PATH=/test\n");
  write("old/app/data/database.sqlite", "old database");
  write("old/app/tenants/attachments/file", "attachment");
  write("old/app/workspaces/project/file", "workspace");
  write("old/app/node_modules/obsolete", "obsolete");
  write("tools/curl", "#!/bin/sh\nexit 1\n");
  write("tools/systemctl", '#!/bin/sh\ncase "$*" in *is-active*) exit 0;; *show*) echo /unrelated/app;; *) echo unexpected >&2; exit 90;; esac\n');
  const archive = path.join(root, "upgrade.tar.zst");
  function pack() {
    execFileSync("tar", ["--zstd", "-C", path.join(root, "source"), "-cf", archive, "codex-web"]);
    fs.writeFileSync(`${archive}.sha256`, execFileSync("sha256sum", ["upgrade.tar.zst"], { cwd: root }));
  }
  function run() {
    return spawnSync("bash", [upgradeScript, archive, path.join(root, "old"), "--no-start"], {
      encoding: "utf8", env: { ...process.env, PATH: `${path.join(root, "tools")}:${process.env.PATH}` },
    });
  }
  return { root, pack, run };
}

test("offline upgrade preserves state, replaces runtime, ignores unrelated service and backs up old code", { skip: !supported }, () => {
  const context = fixture();
  try {
    context.pack();
    const result = context.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const read = (relative: string) => fs.readFileSync(path.join(context.root, relative), "utf8");
    assert.equal(read("old/app/data/database.sqlite"), "old database");
    assert.equal(read("old/app/tenants/attachments/file"), "attachment");
    assert.equal(read("old/app/workspaces/project/file"), "workspace");
    assert.equal(read("old/app/.env"), "PORT=39999\nBASE_PATH=/test\n");
    assert.equal(read("old/app/data/python/bin/uv"), "source/codex-web");
    assert.equal(read("old/app/dist/index.html"), "source/codex-web");
    assert.equal(fs.existsSync(path.join(context.root, "old/app/node_modules/obsolete")), false);
    const backupDir = path.join(context.root, "codex-web-backups");
    const backup = path.join(backupDir, fs.readdirSync(backupDir)[0]);
    assert.equal(fs.statSync(backup).mode & 0o077, 0);
    assert.equal(execFileSync("tar", ["--zstd", "-xOf", backup, "./app/dist/index.html"], { encoding: "utf8" }), "old");
    assert.equal(execFileSync("tar", ["--zstd", "-xOf", backup, "./app/data/python/bin/uv"], { encoding: "utf8" }), "old");
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("invalid and corrupted offline archives fail before changing the deployment", { skip: !supported }, () => {
  const context = fixture();
  try {
    fs.unlinkSync(path.join(context.root, "source/codex-web/app/dist/index.html"));
    context.pack();
    const invalid = context.run();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /升级包缺少/);
    fs.appendFileSync(path.join(context.root, "upgrade.tar.zst"), "corrupt");
    assert.notEqual(context.run().status, 0);
    assert.equal(fs.existsSync(path.join(context.root, "codex-web-backups")), false);
    assert.equal(fs.readFileSync(path.join(context.root, "old/app/dist/index.html"), "utf8"), "old");
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});


test("offline packaging uses a committed snapshot and portable runtime checksums", () => {
  const source = fs.readFileSync("scripts/package-offline.sh", "utf8");
  assert.ok(source.includes('git -C "$REPO_ROOT" archive "$SOURCE_REVISION"'));
  assert.ok(source.includes('sha256sum "$(basename "$archive")"'));
  assert.ok(source.includes('UV_OFFLINE=1 PYTHON_RUNTIME_ROOT="$STAGING/app/data/python"'));
  assert.ok(source.includes('mktemp -d "$STAGING_ROOT/build.XXXXXX"'));
  assert.ok(source.includes('cp "$STAGING/upgrade.sh" "$OUTPUT_DIR/upgrade.sh"'));
});
