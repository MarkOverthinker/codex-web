import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const publisherModule = '../scripts/publish-android.mjs';
const { publish } = await import(publisherModule);

test('Android releases retain history, escape text and reject changed binaries and failed verification', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-release-'));
  try {
    const configFile = path.join(directory, 'release.json');
    const config = { version: '0.3.0-preview', date: '2026-09-09', apk: 'app.apk', output: 'site', signerSha256: 'a'.repeat(64), notes: ['<script>unsafe</script>'], limitations: 'Preview only' };
    const write = () => fs.writeFile(configFile, JSON.stringify(config));
    await fs.writeFile(path.join(directory, 'app.apk'), 'test fixture');
    await write();
    let checks = 0;
    await publish(configFile, () => { checks++; });
    assert.equal(checks, 1);
    const indexFile = path.join(directory, 'site/index.html');
    assert.match(await fs.readFile(indexFile, 'utf8'), /&lt;script&gt;unsafe/);
    assert.doesNotMatch(await fs.readFile(indexFile, 'utf8'), /\{\{[A-Z]+\}\}/);
    await publish(configFile, () => {});
    await fs.writeFile(path.join(directory, 'app.apk'), 'different');
    await assert.rejects(publish(configFile, () => {}), /immutable/);
    config.version = '0.4.0-preview';
    await write();
    const before = await fs.readFile(indexFile, 'utf8');
    await assert.rejects(publish(configFile, () => { throw new Error('Invalid signature'); }), /Invalid signature/);
    assert.equal(await fs.readFile(indexFile, 'utf8'), before);
    await publish(configFile, () => {});
    const releases = JSON.parse(await fs.readFile(path.join(directory, 'site/releases.json'), 'utf8'));
    assert.deepEqual(releases.map((release: { version: string }) => release.version), ['0.4.0-preview', '0.3.0-preview']);
    assert.equal(await fs.readFile(path.join(directory, 'site/codex-native-android-0.3.0-preview.apk'), 'utf8'), 'test fixture');
    config.version = '0.2.1-preview';
    await write();
    const result = await publish(configFile, () => {});
    assert.equal(result.latest, '0.4.0-preview');
    config.apk = 'missing.apk';
    await write();
    await assert.rejects(publish(configFile, () => {}), /ENOENT/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
