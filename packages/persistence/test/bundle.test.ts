import 'fake-indexeddb/auto';
import { unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertBundleWorkspaceCapacity, createBundle, MAX_BUNDLE_ARCHIVE_BYTES, MAX_BUNDLE_EXPANDED_BYTES, MAX_IMAGE_BYTES, MAX_WORKSPACE_FILES, MAX_WORKSPACE_PAYLOAD_FILES, parseBundle, serializedManifestBytes, workspaceRevision } from '../src/bundle.js';
import { openDatabase } from '../src/database.js';
import { openIndexedDbHost } from '../src/host.js';
import { sha256, utf8Bytes } from '../src/bytes.js';

const hosts: Array<Awaited<ReturnType<typeof openIndexedDbHost>>> = [];
let databaseCounter = 1000;

afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
});

describe('V1 workspace bundle limits and byte fidelity', () => {
  it('reserves the serialized manifest inside the exact 256 MiB workspace limit', () => {
    const workspaceId = 'cap-workspace';
    const sourceRevision = 'a'.repeat(64);
    let payloadBytes = 0;
    let manifestBytes = 0;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      manifestBytes = serializedManifestBytes(workspaceId, 'Capacity', sourceRevision, [
        { path: 'payload.bin', revision: 'b'.repeat(64), byteLength: payloadBytes }
      ]).byteLength;
      payloadBytes = MAX_BUNDLE_EXPANDED_BYTES - manifestBytes;
    }
    const files = [{ path: 'payload.bin', revision: 'b'.repeat(64), byteLength: payloadBytes }];
    expect(serializedManifestBytes(workspaceId, 'Capacity', sourceRevision, files).byteLength).toBe(manifestBytes);
    expect(() => assertBundleWorkspaceCapacity(workspaceId, 'Capacity', sourceRevision, files)).not.toThrow();
    expect(() => assertBundleWorkspaceCapacity(workspaceId, 'Capacity', sourceRevision, [{ ...files[0]!, byteLength: payloadBytes + 1 }])).toThrow();
  });

  it('reserves one of the 100,000 ZIP entries for manifest.json', () => {
    expect(MAX_WORKSPACE_FILES).toBe(100_000);
    expect(MAX_WORKSPACE_PAYLOAD_FILES).toBe(MAX_WORKSPACE_FILES - 1);
    const files = Array.from({ length: MAX_WORKSPACE_PAYLOAD_FILES }, (_, index) => ({
      path: `file-${index}.bin`,
      revision: 'c'.repeat(64),
      byteLength: 0
    }));
    expect(() => assertBundleWorkspaceCapacity('file-cap', 'File cap', 'd'.repeat(64), files)).not.toThrow();
    expect(() => assertBundleWorkspaceCapacity('file-cap', 'File cap', 'd'.repeat(64), [...files, {
      path: 'file-extra.bin', revision: 'e'.repeat(64), byteLength: 0
    }])).toThrow();
  });

  it('emits decodable ZIP64 end records at the 65,535-entry boundary', async () => {
    for (const totalEntries of [65_534, 65_535, 65_536]) {
      const source = await emptyBundleSource(totalEntries - 1);
      const bundle = await createBundle(source);
      const archive = new Uint8Array(await bundle.arrayBuffer());
      const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
      const eocdOffset = archive.byteLength - 22;
      expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
      expect(view.getUint16(eocdOffset + 10, true)).toBe(totalEntries < 65_535 ? totalEntries : 0xffff);

      if (totalEntries >= 65_535) {
        expect(view.getUint32(eocdOffset - 20, true)).toBe(0x07064b50);
        const zip64Offset = Number(view.getBigUint64(eocdOffset - 12, true));
        expect(view.getUint32(zip64Offset, true)).toBe(0x06064b50);
        expect(view.getBigUint64(zip64Offset + 32, true)).toBe(BigInt(totalEntries));
      }

      const decoded = unzipSync(archive);
      expect(Object.keys(decoded)).toHaveLength(totalEntries);
      expect(decoded['manifest.json']).toBeDefined();
      const manifest = JSON.parse(new TextDecoder().decode(decoded['manifest.json'])) as { files: unknown[] };
      expect(manifest.files).toHaveLength(totalEntries - 1);
    }
  }, 180_000);

  it('exports and parses the full 100,000-entry workspace with record count and SHA intact', async () => {
    const source = await emptyBundleSource(MAX_WORKSPACE_PAYLOAD_FILES);
    const bundle = await createBundle(source);
    expect(bundle.size).toBeLessThanOrEqual(MAX_BUNDLE_ARCHIVE_BYTES);
    const imported = await parseBundle(bundle);
    expect(imported.files).toHaveLength(MAX_WORKSPACE_PAYLOAD_FILES);
    expect(imported.sourceRevision).toBe(source.sourceRevision);
    expect(imported.files[0]).toMatchObject({
      path: 'entries/file-000000.bin',
      revision: await sha256(new Uint8Array())
    });
    expect(imported.files.at(-1)).toMatchObject({
      path: `entries/file-${String(MAX_WORKSPACE_PAYLOAD_FILES - 1).padStart(6, '0')}.bin`,
      revision: await sha256(new Uint8Array())
    });
    expect(await workspaceRevision(imported.files)).toBe(source.sourceRevision);
  }, 180_000);

  it('rejects 100,001 archive entries, oversized archive input, and malformed ZIP metadata before import mutation', async () => {
    const host = await openIndexedDbHost({ databaseName: `atlas-import-limits-${++databaseCounter}` });
    hosts.push(host);
    const existing = await host.createWorkspace({ name: 'Preserved' });
    const readArchive = vi.fn(async () => new ArrayBuffer(0));
    const oversizedArchive = {
      size: MAX_BUNDLE_ARCHIVE_BYTES + 1,
      arrayBuffer: readArchive
    } as unknown as Blob;

    await expect(host.importBundle(oversizedArchive, { workspaceId: 'too-large-archive' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('archive size limit')
    });
    expect(readArchive).not.toHaveBeenCalled();

    await expect(host.importBundle(new Blob([makeZip64EntryCountArchive(MAX_WORKSPACE_FILES + 1)]), {
      workspaceId: 'too-many-entries'
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(host.importBundle(new Blob([makeMalformedZipMetadata()]), {
      workspaceId: 'malformed-metadata'
    })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('central directory bounds')
    });
    expect(await host.listWorkspaces()).toHaveLength(1);
    expect((await host.getWorkspaceHandle(existing.workspace.workspaceId)).sourceRevision).toBe(existing.workspace.sourceRevision);
  });

  it('preserves an existing workspace when rejecting oversized images, duplicate asset IDs, bad ZIP metadata, and corrupted member bytes', async () => {
    const host = await openIndexedDbHost({ databaseName: `atlas-import-failures-${++databaseCounter}` });
    hosts.push(host);
    const existing = await host.createWorkspace({ name: 'Preserved source' });
    const keepContent = 'existing bytes stay here\n';
    const seed = await host.prepare(existing.workspace, {
      operationId: 'op-preserve-existing',
      workspaceId: existing.workspace.workspaceId,
      baseWorkspaceRevision: existing.workspace.sourceRevision,
      reads: [{ path: 'notes/keep.txt', revision: null }],
      writes: [{ path: 'notes/keep.txt', content: keepContent, encoding: 'utf8' }],
      message: 'Seed the existing workspace',
      kind: 'document'
    });
    await host.commit(existing.workspace, seed.preparedId, true);
    const sourceRevision = (await host.getWorkspaceHandle(existing.workspace.workspaceId)).sourceRevision;

    const expectExistingUntouched = async () => {
      const workspaces = await host.listWorkspaces();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]).toMatchObject({ workspace: { workspaceId: existing.workspace.workspaceId, sourceRevision } });
      const current = await host.getWorkspaceHandle(existing.workspace.workspaceId);
      expect(current.sourceRevision).toBe(sourceRevision);
      await expect(host.read(current, { path: 'notes/keep.txt' })).resolves.toMatchObject({
        content: keepContent,
        revision: await sha256(utf8Bytes(keepContent))
      });
    };

    const oversizedImage = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const oversizedBundle = await makeBundleArchive('oversized-image', 'Oversized image', [
      { path: 'assets/oversized.png', bytes: oversizedImage }
    ]);
    await expect(host.importBundle(new Blob([oversizedBundle]), { workspaceId: 'oversized-image-destination' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Image file exceeds 10 MiB') });
    await expectExistingUntouched();

    const duplicateAsset = {
      id: 'asset-duplicate',
      path: 'assets/image.png',
      sha256: 'c'.repeat(64),
      bytes: 1,
      mime: 'image/png'
    };
    const duplicateBoard = utf8Bytes(JSON.stringify({
      schema: 'atlas.board/v1',
      boardId: 'duplicate-asset-board',
      name: 'Duplicate asset keys',
      revision: 0,
      views: [],
      nodes: [],
      edges: [],
      cards: [],
      assets: [duplicateAsset, { ...duplicateAsset }]
    }));
    const duplicateAssetBundle = await makeBundleArchive('duplicate-asset-source', 'Duplicate asset keys', [
      { path: 'boards/duplicate.atlas.json', bytes: duplicateBoard }
    ]);
    await expect(host.importBundle(new Blob([duplicateAssetBundle]), { workspaceId: 'duplicate-asset-destination' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expectExistingUntouched();

    await expect(host.importBundle(new Blob([makeMalformedZipMetadata()]), { workspaceId: 'bad-metadata-destination' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expectExistingUntouched();

    const body = utf8Bytes('ZIP payload bytes must match the manifest');
    const validArchive = await makeBundleArchive('corrupted-source', 'Corrupted payload', [
      { path: 'notes/body.txt', bytes: body }
    ], 0);
    const corruptedArchive = corruptStoredZipMember(validArchive, 'workspace/notes/body.txt');
    await expect(host.importBundle(new Blob([corruptedArchive]), { workspaceId: 'corrupted-destination' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expectExistingUntouched();
  });

  it('keeps a legacy 100,000-file workspace readable when bundle export is over the reserved-manifest limit', async () => {
    const databaseName = `atlas-legacy-limit-${++databaseCounter}`;
    const host = await openIndexedDbHost({ databaseName });
    hosts.push(host);
    const created = await host.createWorkspace({ name: 'Legacy workspace' });
    const emptyHash = await sha256(new Uint8Array());
    const tailContent = 'last legacy file';
    const tailBytes = utf8Bytes(tailContent);
    const tailHash = await sha256(tailBytes);
    const tailPath = `legacy-${String(MAX_WORKSPACE_FILES - 1).padStart(6, '0')}.txt`;
    const files = Array.from({ length: MAX_WORKSPACE_FILES }, (_, index) => ({
      path: `legacy-${String(index).padStart(6, '0')}.bin`,
      revision: emptyHash,
      byteLength: 0
    }));
    files[files.length - 1] = { path: tailPath, revision: tailHash, byteLength: tailBytes.byteLength };
    const sourceRevision = await workspaceRevision(files);
    const database = await openDatabase({ databaseName });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['workspaces', 'files'], 'readwrite');
      const workspaces = transaction.objectStore('workspaces');
      const filesStore = transaction.objectStore('files');
      for (const file of files) {
        const bytes = file.path === tailPath
          ? tailBytes.buffer.slice(tailBytes.byteOffset, tailBytes.byteOffset + tailBytes.byteLength) as ArrayBuffer
          : new ArrayBuffer(0);
        filesStore.put({
          workspaceId: created.workspace.workspaceId,
          path: file.path,
          revision: file.revision,
          bytes,
          contentType: file.path === tailPath ? 'text/plain' : 'application/octet-stream',
          updatedAt: created.createdAt
        });
      }
      const workspaceRequest = workspaces.get(created.workspace.workspaceId) as IDBRequest<Record<string, unknown> | undefined>;
      workspaceRequest.onsuccess = () => {
        if (!workspaceRequest.result) {
          transaction.abort();
          reject(new Error('Created workspace disappeared before legacy fixtures were seeded.'));
          return;
        }
        workspaces.put({ ...workspaceRequest.result, sourceRevision });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Legacy fixture transaction aborted.'));
    });
    database.close();

    const handle = await host.getWorkspaceHandle(created.workspace.workspaceId);
    await expect(host.export(created.workspace.workspaceId)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('after reserving manifest.json')
    });
    const tail = await host.getSnapshotPage(handle, { cursor: encodeURIComponent('legacy-099998.bin'), limit: 1 });
    expect(tail.files).toHaveLength(1);
    expect(tail.files[0]).toMatchObject({ path: tailPath, content: tailContent, revision: tailHash });
    const listedTail = await host.list(handle, { cursor: encodeURIComponent('legacy-099998.bin'), limit: 1 });
    expect(listedTail.files).toHaveLength(1);
    expect(listedTail.files[0]).toMatchObject({ path: tailPath, revision: tailHash });
    expect((await host.listWorkspaces())[0]?.fileCount).toBe(MAX_WORKSPACE_FILES);
    expect((await host.getWorkspaceHandle(created.workspace.workspaceId)).sourceRevision).toBe(sourceRevision);
  }, 60_000);

  it('round trips exported workspaces without changing original UTF-8 bytes', async () => {
    const host = await openIndexedDbHost({ databaseName: `atlas-bundle-test-${++databaseCounter}` });
    hosts.push(host);
    const workspace = await host.createWorkspace({ name: 'Bundle' });
    const exactContent = '\uFEFFfirst line\r\nsecond line\n';
    const expectedRevision = await sha256(utf8Bytes(exactContent));
    const prepared = await host.prepare(workspace.workspace, {
      operationId: 'bundle-op',
      workspaceId: workspace.workspace.workspaceId,
      baseWorkspaceRevision: workspace.workspace.sourceRevision,
      reads: [{ path: 'notes.txt', revision: null }],
      writes: [{ path: 'notes.txt', content: exactContent, encoding: 'utf8' }],
      message: 'Preserve the bytes',
      kind: 'document'
    });
    await host.commit(workspace.workspace, prepared.preparedId, true);

    const bundle = await host.export(workspace.workspace.workspaceId);
    const imported = await host.importBundle(bundle, { workspaceId: 'bundle-copy', name: 'Bundle copy' });
    const file = await host.read(imported.workspace, { path: 'notes.txt' });
    expect(file).toMatchObject({ content: exactContent, revision: expectedRevision });
  });
});

async function emptyBundleSource(payloadCount: number) {
  const workspaceId = `zip64-${payloadCount}`;
  const bytes = new ArrayBuffer(0);
  const revision = await sha256(new Uint8Array(bytes));
  const files = Array.from({ length: payloadCount }, (_, index) => ({
    workspaceId,
    path: `entries/file-${String(index).padStart(6, '0')}.bin`,
    revision,
    bytes,
    contentType: 'application/octet-stream',
    updatedAt: new Date(0).toISOString()
  }));
  return { workspaceId, name: `ZIP64 ${payloadCount}`, sourceRevision: await workspaceRevision(files), files };
}

function makeZip64EntryCountArchive(entries: number): Uint8Array {
  const archive = new Uint8Array(98);
  const view = new DataView(archive.buffer);
  view.setUint32(0, 0x06064b50, true);
  view.setBigUint64(4, 44n, true);
  view.setUint16(12, 45, true);
  view.setUint16(14, 45, true);
  view.setBigUint64(24, BigInt(entries), true);
  view.setBigUint64(32, BigInt(entries), true);
  view.setUint32(56, 0x07064b50, true);
  view.setUint32(72, 1, true);
  view.setUint32(76, 0x06054b50, true);
  view.setUint16(84, 0xffff, true);
  view.setUint16(86, 0xffff, true);
  view.setUint32(88, 0xffffffff, true);
  view.setUint32(92, 0xffffffff, true);
  return archive;
}

function makeMalformedZipMetadata(): Uint8Array {
  const archive = new Uint8Array(22);
  const view = new DataView(archive.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint32(12, 1, true);
  return archive;
}

async function makeBundleArchive(
  workspaceId: string,
  name: string,
  files: Array<{ path: string; bytes: Uint8Array }>,
  level = 6
): Promise<Uint8Array> {
  const revisions = await Promise.all(files.map(async file => ({ path: file.path, revision: await sha256(file.bytes) })));
  const sourceRevision = await workspaceRevision(revisions);
  const zipEntries = Object.create(null) as Record<string, Uint8Array>;
  zipEntries['manifest.json'] = serializedManifestBytes(workspaceId, name, sourceRevision, files.map((file, index) => ({
    path: file.path,
    revision: revisions[index]!.revision,
    byteLength: file.bytes.byteLength
  })));
  for (const file of files) zipEntries[`workspace/${file.path}`] = file.bytes;
  return zipSync(zipEntries, { level });
}

function corruptStoredZipMember(archive: Uint8Array, memberName: string): Uint8Array {
  const corrupted = archive.slice();
  const view = new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength);
  let endOffset = -1;
  for (let offset = corrupted.byteLength - 22; offset >= Math.max(0, corrupted.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('ZIP end record was not found.');

  const entryCount = view.getUint16(endOffset + 10, true);
  let centralOffset = view.getUint32(endOffset + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(centralOffset, true) !== 0x02014b50) throw new Error('ZIP central entry was malformed.');
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const name = decoder.decode(corrupted.subarray(centralOffset + 46, centralOffset + 46 + nameLength));
    if (name === memberName) {
      const localOffset = view.getUint32(centralOffset + 42, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (view.getUint16(centralOffset + 10, true) !== 0 || dataOffset >= corrupted.byteLength) {
        throw new Error('Target ZIP member is not a nonempty stored member.');
      }
      corrupted[dataOffset] = corrupted[dataOffset]! ^ 0xff;
      return corrupted;
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP member ${memberName} was not found.`);
}
