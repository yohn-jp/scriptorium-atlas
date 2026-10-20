import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeBundleLicenses } from '../../scripts/verification/write-bundle-licenses.mjs';

async function fixture({ withLicense = true } = {}) {
  const root = await mkdtemp(join(os.tmpdir(), 'atlas-bundle-license-test-'));
  const dependencyDirectory = join(root, 'node_modules', '.pnpm', '@sample+dep@2.3.4', 'node_modules', '@sample', 'dep');
  const outputDirectory = join(root, 'dist', 'story');
  await mkdir(dependencyDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(dependencyDirectory, 'package.json'), JSON.stringify({ name: '@sample/dep', version: '2.3.4', license: 'MIT' }));
  await writeFile(join(dependencyDirectory, 'index.js'), 'export const value = 1;\n');
  if (withLicense) await writeFile(join(dependencyDirectory, 'LICENSE'), 'Exact upstream license text.\n');
  return {
    root,
    outputDirectory,
    module: 'node_modules/.pnpm/@sample+dep@2.3.4/node_modules/@sample/dep/index.js',
    dependencyDirectory
  };
}

test('writes exact bundled dependency legal text with a verifiable digest', async () => {
  const setup = await fixture();
  try {
    const result = await writeBundleLicenses({
      repoRoot: setup.root,
      profile: 'story',
      outputDirectory: setup.outputDirectory,
      closure: { chunks: [{ file: 'assets/index.js', modules: [setup.module] }] }
    });
    assert.equal(result.packageCount, 1);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    const [license] = manifest.packages[0].licenseFiles;
    const original = await readFile(join(setup.dependencyDirectory, 'LICENSE'));
    const copied = await readFile(join(setup.outputDirectory, 'licenses', license.output));
    assert.deepEqual(copied, original);
    assert.equal(license.sha256, createHash('sha256').update(original).digest('hex'));
    const notices = await readFile(join(setup.outputDirectory, 'licenses/THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(notices, /@sample\/dep@2\.3\.4/);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('fails closed when included package code has no license text to preserve', async () => {
  const setup = await fixture({ withLicense: false });
  try {
    await assert.rejects(
      writeBundleLicenses({
        repoRoot: setup.root,
        profile: 'story',
        outputDirectory: setup.outputDirectory,
        closure: { chunks: [{ file: 'assets/index.js', modules: [setup.module] }] }
      }),
      /no bundled LICENSE\/COPYING\/NOTICE text/
    );
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('preserves font notices, license text, and every copied font digest in Atlas output', async () => {
  const setup = await fixture();
  try {
    const fontDirectory = join(setup.outputDirectory, 'fonts');
    await mkdir(join(fontDirectory, 'licenses'), { recursive: true });
    const fontFiles = [
      { path: 'Assistant/sample.woff2', content: Buffer.from('ofl-font-bytes'), license: 'OFL-1.1' },
      { path: 'ComicShanns/sample.woff2', content: Buffer.from('mit-font-bytes'), license: 'MIT' }
    ];
    for (const font of fontFiles) {
      const path = join(fontDirectory, font.path);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, font.content);
    }
    const fontNotice = Buffer.from('Exact upstream font notice.\n');
    await writeFile(join(fontDirectory, 'THIRD_PARTY_NOTICES.md'), fontNotice);
    await writeFile(join(fontDirectory, 'licenses/MIT.txt'), 'Exact MIT text.\n');
    await writeFile(join(fontDirectory, 'licenses/OFL-1.1.txt'), 'Exact OFL text.\n');
    const fontManifest = {
      files: fontFiles.map(font => ({
        path: font.path,
        license: font.license,
        bytes: font.content.byteLength,
        sha256: createHash('sha256').update(font.content).digest('hex')
      }))
    };
    await writeFile(join(fontDirectory, 'manifest.json'), `${JSON.stringify(fontManifest)}\n`);
    const result = await writeBundleLicenses({
      repoRoot: setup.root,
      profile: 'atlas',
      outputDirectory: setup.outputDirectory,
      closure: { chunks: [{ file: 'assets/index.js', modules: [setup.module] }] }
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.assets.length, 6);
    assert.deepEqual(
      await readFile(join(setup.outputDirectory, 'licenses/assets/fonts/THIRD_PARTY_NOTICES.md')),
      fontNotice
    );
    assert.equal(await readFile(join(setup.outputDirectory, 'licenses/assets/fonts/licenses/MIT.txt'), 'utf8'), 'Exact MIT text.\n');
    assert.equal(await readFile(join(setup.outputDirectory, 'licenses/assets/fonts/licenses/OFL-1.1.txt'), 'utf8'), 'Exact OFL text.\n');
    assert.deepEqual(await readFile(join(fontDirectory, 'Assistant/sample.woff2')), fontFiles[0].content);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});
