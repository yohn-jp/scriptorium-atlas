import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertBundleWorkspaceCapacity, MAX_BUNDLE_ARCHIVE_BYTES, MAX_BUNDLE_EXPANDED_BYTES, MAX_WORKSPACE_FILES, MAX_WORKSPACE_PAYLOAD_FILES, serializedManifestBytes, workspaceRevision } from '../src/bundle.js';
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
