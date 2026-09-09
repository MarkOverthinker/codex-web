import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = fileURLToPath(new URL('../', import.meta.url));
const schema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+-preview$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  apk: z.string().min(1), output: z.string().min(1),
  signerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.array(z.string().min(1)).min(1),
  limitations: z.string().min(1),
}).strict();
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function atomic(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, filename);
}

export async function publish(configFile, verify = verifyApk) {
  const config = schema.parse(JSON.parse(await fs.readFile(configFile, 'utf8')));
  const directory = path.dirname(path.resolve(configFile));
  const apk = path.resolve(directory, config.apk);
  const output = path.resolve(directory, config.output);
  const bytes = await fs.readFile(apk);
  const digest = sha(bytes);
  verify(apk, config.signerSha256, config.version);
  await fs.mkdir(output, { recursive: true });
  const lock = await fs.open(path.join(output, '.publish.lock'), 'wx');
  try {
    const manifestFile = path.join(output, 'releases.json');
    let releases;
    try { releases = JSON.parse(await fs.readFile(manifestFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; releases = []; }
    if (!Array.isArray(releases)) throw new Error('Invalid release history');
    const previous = releases.find(release => release.version === config.version);
    if (previous && previous.sha256 !== digest) throw new Error('Published versions are immutable; increment version first');
    const filename = `codex-native-android-${config.version}.apk`;
    try {
      if (sha(await fs.readFile(path.join(output, filename))) !== digest) throw new Error('Existing APK differs');
    } catch (error) { if (error.code !== 'ENOENT') throw error; await atomic(path.join(output, filename), bytes); }
    await atomic(path.join(output, `${filename}.sha256`), `${digest}  ${filename}\n`);
    const release = { version: config.version, date: config.date, filename, bytes: bytes.length, sha256: digest,
      notes: config.notes, limitations: config.limitations };
    releases = [release, ...releases.filter(item => item.version !== config.version)].sort((left, right) =>
      right.version.replace('-preview', '').localeCompare(left.version.replace('-preview', ''), 'en', { numeric: true }));
    const latest = releases[0];
    const template = await fs.readFile(path.join(root, 'releases/android/index.html'), 'utf8');
    const changes = releases.map(item => `<article class="release"><h3>${escape(item.version)} <small>${escape(item.date)}</small></h3><ul>${item.notes.map(note => `<li>${escape(note)}</li>`).join('')}</ul><p class="muted">${escape(item.limitations)}</p><a href="${escape(item.filename)}" download>下载此版本</a> · <a href="${escape(item.filename)}.sha256">SHA-256</a></article>`).join('');
    const replacements = { VERSION: escape(latest.version), DATE: escape(latest.date), SIZE: (latest.bytes / 1048576).toFixed(1), APK: escape(latest.filename), SHA: latest.sha256, HISTORY: changes };
    const html = template.replace(/\{\{([A-Z]+)\}\}/g, (_, key) => replacements[key]);
    await atomic(manifestFile, `${JSON.stringify(releases, null, 2)}\n`);
    await atomic(path.join(output, 'index.html'), html);
    return { output, latest: latest.version, filename, sha256: digest };
  } finally { await lock.close(); await fs.unlink(path.join(output, '.publish.lock')); }
}

function verifyApk(apk, signer, version) {
  execFileSync('bash', [path.join(root, 'scripts/verify-android-preview.sh'), apk, signer], { stdio: 'pipe' });
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const tools = process.env.ANDROID_BUILD_TOOLS_VERSION ?? '35.0.0';
  const badging = execFileSync(path.join(sdk, 'build-tools', tools, 'aapt'), ['dump', 'badging', apk], { encoding: 'utf8' });
  if (!badging.includes(`versionName='${version}'`)) throw new Error('APK version differs from release metadata');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) { console.error('Usage: node scripts/publish-android.mjs release.json'); process.exitCode = 1; }
  else publish(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
