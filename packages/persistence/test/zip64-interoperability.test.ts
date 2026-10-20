import { lstat, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createBundle, workspaceRevision } from '../src/bundle.js';
import { sha256 } from '../src/bytes.js';

const outputSetting = process.env.ATLAS_BUNDLE_OUTPUT;

(outputSetting ? it : it.skip)('writes a max-cap 100,000-entry ZIP64 archive for an external Python oracle', async () => {
  if (!outputSetting || !isAbsolute(outputSetting)) {
    throw new Error('Set ATLAS_BUNDLE_OUTPUT to an absolute path outside the repository.');
  }

  const repositoryRoot = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  const outputDirectory = await realpath(dirname(outputSetting));
  const outputPath = resolve(outputDirectory, basename(outputSetting));
  const relativeOutput = relative(repositoryRoot, outputPath);
  const outputIsInsideRepository = relativeOutput === '' || (
    relativeOutput !== '..' &&
    !relativeOutput.startsWith(`..${sep}`) &&
    !isAbsolute(relativeOutput)
  );
  if (outputIsInsideRepository) {
    throw new Error('ATLAS_BUNDLE_OUTPUT must resolve outside the repository.');
  }
  try {
    const existingOutput = await lstat(outputPath);
    if (!existingOutput.isFile() || existingOutput.nlink !== 1) {
      throw new Error('ATLAS_BUNDLE_OUTPUT must be a regular file without hard links.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const workspaceId = 'python-zip64-interop';
  const payloadCount = 99_999;
  const emptyBytes = new ArrayBuffer(0);
  const tailPath = `payload/file-${String(payloadCount - 1).padStart(6, '0')}.bin`;
  const tailBytes = new TextEncoder().encode('ZIP64 Python interoperability tail\n');
  const tailBuffer = tailBytes.buffer.slice(tailBytes.byteOffset, tailBytes.byteOffset + tailBytes.byteLength) as ArrayBuffer;
  const emptyRevision = await sha256(new Uint8Array(emptyBytes));
  const tailRevision = await sha256(tailBytes);
  const files = Array.from({ length: payloadCount }, (_, index) => {
    const path = index === payloadCount - 1
      ? tailPath
      : `payload/file-${String(index).padStart(6, '0')}.bin`;
    return {
      workspaceId,
      path,
      revision: index === payloadCount - 1 ? tailRevision : emptyRevision,
      bytes: index === payloadCount - 1 ? tailBuffer : emptyBytes,
      contentType: 'application/octet-stream',
      updatedAt: new Date(0).toISOString()
    };
  });
  const sourceRevision = await workspaceRevision(files);
  const bundle = await createBundle({
    workspaceId,
    name: 'Python ZIP64 interoperability',
    sourceRevision,
    files
  });
  const archiveBytes = new Uint8Array(await bundle.arrayBuffer());
  await writeFile(outputPath, archiveBytes);

  expect(files).toHaveLength(99_999);
  expect(bundle.size).toBe(14_682_752);
}, 300_000);
