import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../../scripts/verification/check-pack-consumer.mjs', import.meta.url));

test('packs a public module and imports it from an isolated external consumer', async () => {
  const fixtureRoot = await mkdtemp(join(os.tmpdir(), 'atlas-pack-consumer-test-'));
  const packageDirectory = join(fixtureRoot, 'packages', 'sample');
  await mkdir(join(packageDirectory, 'dist'), { recursive: true });
  await writeFile(join(packageDirectory, 'README.md'), 'External pack fixture.\n');
  await writeFile(join(packageDirectory, 'dist/index.js'), 'export const atlasPackFixture = "loaded";\n');
  await writeFile(join(packageDirectory, 'package.json'), `${JSON.stringify({
    name: '@scriptorium-atlas/pack-fixture',
    version: '1.2.3',
    type: 'module',
    files: ['dist', 'package.json', 'README.md'],
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } }
  }, null, 2)}\n`);

  try {
    const run = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, ATLAS_PACK_REPO_ROOT: fixtureRoot },
      maxBuffer: 2 * 1024 * 1024
    });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, 'PASS');
    assert.equal(report.packages.length, 1);
    assert.equal(report.packages[0].status, 'PASS');
    assert.equal(report.consumer.status, 'PASS');
    assert.deepEqual(report.consumer.exportedModules.map(({ specifier }) => specifier), ['@scriptorium-atlas/pack-fixture']);
    assert.match(report.packages[0].archive.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
