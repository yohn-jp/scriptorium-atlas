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
  const dependencyDirectory = join(fixtureRoot, 'packages', 'dependency');
  const packageDirectory = join(fixtureRoot, 'packages', 'sample');
  await mkdir(join(dependencyDirectory, 'dist'), { recursive: true });
  await mkdir(join(packageDirectory, 'dist'), { recursive: true });
  await writeFile(join(packageDirectory, 'README.md'), 'External pack fixture.\n');
  await writeFile(join(dependencyDirectory, 'dist/index.js'), 'export const atlasPackDependency = "loaded from an archive";\n');
  await writeFile(join(dependencyDirectory, 'package.json'), `${JSON.stringify({
    name: '@scriptorium-atlas/pack-dependency',
    version: '1.2.3',
    type: 'module',
    files: ['dist', 'package.json'],
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } }
  }, null, 2)}\n`);
  await writeFile(join(packageDirectory, 'dist/index.js'), 'import { atlasPackDependency } from "@scriptorium-atlas/pack-dependency";\nexport const atlasPackFixture = atlasPackDependency;\n');
  await writeFile(join(packageDirectory, 'package.json'), `${JSON.stringify({
    name: '@scriptorium-atlas/pack-fixture',
    version: '1.2.3',
    type: 'module',
    dependencies: { '@scriptorium-atlas/pack-dependency': '1.2.3' },
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
    assert.equal(report.packages.length, 2);
    assert.ok(report.packages.every(packageRecord => packageRecord.status === 'PASS'));
    assert.equal(report.consumer.status, 'PASS');
    assert.equal(report.consumer.workspaceOverrideCount, 1);
    assert.deepEqual(report.consumer.exportedModules.map(({ specifier }) => specifier), [
      '@scriptorium-atlas/pack-dependency',
      '@scriptorium-atlas/pack-fixture'
    ]);
    assert.ok(report.packages.every(packageRecord => /^[a-f0-9]{64}$/.test(packageRecord.archive.sha256)));
    assert.deepEqual(report.packages.find(packageRecord => packageRecord.name === '@scriptorium-atlas/pack-fixture').internalDependencies, [
      { name: '@scriptorium-atlas/pack-dependency', version: '1.2.3' }
    ]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
