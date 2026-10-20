import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { openIndexedDbHost, validateRelativePath } from '../src/host.js';
import { sha256, bytesToBase64, copyArrayBuffer, utf8Bytes } from '../src/bytes.js';
import { workspaceRevision } from '../src/bundle.js';

const hosts: Array<Awaited<ReturnType<typeof openIndexedDbHost>>> = [];
let databaseCounter = 0;

async function open() {
  const host = await openIndexedDbHost({ databaseName: `atlas-persistence-test-${++databaseCounter}` });
  hosts.push(host);
  return host;
}

function change(
  workspaceId: string,
  baseWorkspaceRevision: string,
  operationId: string,
  path: string,
  content: string | null,
  revision: string | null
) {
  return {
    operationId,
    workspaceId,
    baseWorkspaceRevision,
    reads: [{ path, revision }],
    writes: [{ path, content, encoding: 'utf8' as const }],
    message: 'Test author proposal',
    kind: 'document' as const
  };
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
});

describe('IndexedDB Host persistence', () => {
  it('exports the canonical relative-path validator from the Host entry', () => {
    expect(validateRelativePath('provider/source.yaml')).toBe('provider/source.yaml');
    expect(() => validateRelativePath('../outside.yaml')).toThrowError();
  });

  it('durably prepares a full review, requires author approval, and commits idempotently', async () => {
    const host = await open();
    const workspace = await host.createWorkspace({ name: 'Draft' });
    const proposal = change(workspace.workspace.workspaceId, workspace.workspace.sourceRevision, 'op-create', 'notes/first.txt', 'hello\n', null);
    const prepared = await host.prepare(workspace.workspace, proposal);
    expect(prepared.durableAck.operationId).toBe('op-create');
    expect(prepared.durableAck.journalSequence).toBe(1);
    const review = await host.getPrepared(prepared.preparedId);
    expect(review?.files[0]?.before).toBeNull();
    expect(review?.files[0]?.after?.content).toBe('hello\n');
    await expect(host.commit(workspace.workspace, prepared.preparedId, false)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const receipt = await host.commit(workspace.workspace, prepared.preparedId, true);
    expect(receipt.files).toEqual([{ path: 'notes/first.txt', revision: await sha256(utf8Bytes('hello\n')) }]);
    expect(await host.commit(workspace.workspace, prepared.preparedId, true)).toEqual(receipt);
    const current = await host.getWorkspaceHandle(workspace.workspace.workspaceId);
    await expect(host.read(current, { path: 'notes/first.txt' })).resolves.toMatchObject({ content: 'hello\n' });
    await expect(host.recover(workspace.workspace.workspaceId)).resolves.toMatchObject({ pendingOperationIds: [], unknownCommitIds: [] });
  });

  it('recovers durable proposals after reopening and rejects stale read sets atomically', async () => {
    const first = await open();
    const workspace = await first.createWorkspace({ name: 'Recovery' });
    const pending = change(workspace.workspace.workspaceId, workspace.workspace.sourceRevision, 'op-pending', 'a.txt', 'A', null);
    const prepared = await first.prepare(workspace.workspace, pending);
    const databaseName = `atlas-persistence-test-${databaseCounter}`;
    first.close();

    const second = await openIndexedDbHost({ databaseName });
    hosts.push(second);
    await expect(second.listPending(workspace.workspace.workspaceId)).resolves.toMatchObject([
      { prepared: { preparedId: prepared.preparedId }, files: [{ after: { content: 'A' } }] }
    ]);
    const competing = change(workspace.workspace.workspaceId, workspace.workspace.sourceRevision, 'op-competing', 'b.txt', 'B', null);
    const competingPrepared = await second.prepare(workspace.workspace, competing);
    await second.commit(workspace.workspace, prepared.preparedId, true);
    await expect(second.prepare(workspace.workspace, pending)).resolves.toMatchObject({ preparedId: prepared.preparedId });
    await expect(second.commit(workspace.workspace, competingPrepared.preparedId, true)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const current = await second.getWorkspaceHandle(workspace.workspace.workspaceId);
    await expect(second.list(current)).resolves.toMatchObject({ files: [{ path: 'a.txt' }] });
  });

  it('rejects operation ID reuse, reserved manifest paths, and unreviewed writes', async () => {
    const host = await open();
    const workspace = await host.createWorkspace({ name: 'Validation' });
    const first = change(workspace.workspace.workspaceId, workspace.workspace.sourceRevision, 'op-reuse', 'a.txt', 'A', null);
    await host.prepare(workspace.workspace, first);
    const reused = change(workspace.workspace.workspaceId, workspace.workspace.sourceRevision, 'op-reuse', 'a.txt', 'B', null);
    await expect(host.prepare(workspace.workspace, reused)).rejects.toMatchObject({ code: 'OPERATION_ID_REUSED' });

    const reserved = change(workspace.workspace.workspaceId, workspace.workspace.sourceRevision, 'op-manifest', 'manifest.json', '{}', null);
    await expect(host.prepare(workspace.workspace, reserved)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    const missingRead = {
      ...first,
      operationId: 'op-unread',
      writes: [{ path: 'b.txt', content: 'B', encoding: 'utf8' as const }]
    };
    await expect(host.prepare(workspace.workspace, missingRead)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects case-folded aliases against files already in the workspace', async () => {
    const host = await open();
    const workspace = await host.createWorkspace({ name: 'Paths' });
    const initial = change(workspace.workspace.workspaceId, workspace.workspace.sourceRevision, 'op-upper', 'Notes.txt', 'one', null);
    const prepared = await host.prepare(workspace.workspace, initial);
    await host.commit(workspace.workspace, prepared.preparedId, true);
    const current = await host.getWorkspaceHandle(workspace.workspace.workspaceId);
    const alias = change(workspace.workspace.workspaceId, current.sourceRevision, 'op-lower', 'notes.txt', 'two', null);
    await expect(host.prepare(current, alias)).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('keeps a legacy reserved manifest visible and permits only explicit deletion', async () => {
    const host = await open();
    const workspace = await host.createWorkspace({ name: 'Legacy path' });
    const workspaceId = workspace.workspace.workspaceId;
    const databaseName = `atlas-persistence-test-${databaseCounter}`;
    const bytes = utf8Bytes('{"legacy":true}');
    const revision = await sha256(bytes);
    const sourceRevision = await workspaceRevision([{ path: 'manifest.json', revision }]);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['workspaces', 'files'], 'readwrite', { durability: 'strict' });
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    const workspaceRequest = transaction.objectStore('workspaces').get(workspaceId) as IDBRequest<Record<string, unknown> | undefined>;
    workspaceRequest.onsuccess = () => {
      transaction.objectStore('workspaces').put({ ...workspaceRequest.result, sourceRevision, generation: 1 });
      transaction.objectStore('files').put({
        workspaceId,
        path: 'manifest.json',
        revision,
        bytes: copyArrayBuffer(bytes),
        contentType: 'application/json',
        updatedAt: new Date(0).toISOString()
      });
    };
    await done;
    database.close();

    const current = await host.getWorkspaceHandle(workspaceId);
    await expect(host.read(current, { path: 'manifest.json' })).resolves.toMatchObject({ content: '{"legacy":true}' });
    await expect(host.export(workspaceId)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    const prepared = await host.prepare(current, change(workspaceId, current.sourceRevision, 'op-delete-reserved', 'manifest.json', null, revision));
    await host.commit(current, prepared.preparedId, true);
    await expect(host.export(workspaceId)).resolves.toBeInstanceOf(Blob);
  });

  it('stages large image bytes in durable idempotent chunks and promotes them through review', async () => {
    const host = await open();
    const workspace = await host.createWorkspace({ name: 'Image' });
    const bytes = new Uint8Array(9 * 1024 * 1024);
    bytes.set([137, 80, 78, 71], 0);
    const operationId = 'op-image';
    const upload = await host.beginAsset(workspace.workspace, {
      operationId,
      workspaceId: workspace.workspace.workspaceId,
      baseWorkspaceRevision: workspace.workspace.sourceRevision,
      path: 'assets/image.png',
      sha256: await sha256(bytes),
      totalBytes: bytes.byteLength,
      contentType: 'image/png'
    });
    const chunkSize = 1024 * 1024;
    let lastReceipt;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const content = bytesToBase64(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
      lastReceipt = await host.appendAsset(workspace.workspace, { uploadId: upload.uploadId, offset, content });
      if (offset === 0) {
        await expect(host.appendAsset(workspace.workspace, { uploadId: upload.uploadId, offset, content })).resolves.toEqual(lastReceipt && {
          ...lastReceipt,
          nextOffset: chunkSize,
          receivedBytes: chunkSize
        });
      }
    }
    expect(lastReceipt?.receivedBytes).toBe(bytes.byteLength);
    const proposal = {
      operationId,
      workspaceId: workspace.workspace.workspaceId,
      baseWorkspaceRevision: workspace.workspace.sourceRevision,
      reads: [{ path: 'assets/image.png', revision: null }],
      writes: [],
      message: 'Add the reviewed image asset',
      kind: 'asset' as const
    };
    const prepared = await host.prepareAsset(workspace.workspace, upload.uploadId, proposal);
    expect(prepared.changes).toMatchObject([{ path: 'assets/image.png', operation: 'create', bytes: bytes.byteLength }]);
    expect((await host.getPrepared(prepared.preparedId))?.files[0]?.after?.content.length).toBeGreaterThan(bytes.byteLength);
    const receipt = await host.commit(workspace.workspace, prepared.preparedId, true);
    const current = await host.getWorkspaceHandle(workspace.workspace.workspaceId);
    const chunk = await host.read(current, { path: 'assets/image.png', offset: 0, limit: 8 });
    expect(chunk).toMatchObject({ encoding: 'base64', complete: false, nextOffset: 8 });
    expect(receipt.sourceRevision).not.toBe(workspace.workspace.sourceRevision);
  });

  it('lists incomplete durable asset uploads after a Host reload', async () => {
    const first = await open();
    const workspace = await first.createWorkspace({ name: 'Upload recovery' });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const upload = await first.beginAsset(workspace.workspace, {
      operationId: 'op-upload-recovery',
      workspaceId: workspace.workspace.workspaceId,
      baseWorkspaceRevision: workspace.workspace.sourceRevision,
      path: 'assets/recover.png',
      sha256: await sha256(bytes),
      totalBytes: bytes.byteLength,
      contentType: 'image/png'
    });
    const databaseName = `atlas-persistence-test-${databaseCounter}`;
    first.close();
    const reopened = await openIndexedDbHost({ databaseName });
    hosts.push(reopened);
    await expect(reopened.listPendingAssets(workspace.workspace.workspaceId)).resolves.toEqual([upload]);
    await expect(reopened.recover(workspace.workspace.workspaceId)).resolves.toMatchObject({ pendingOperationIds: ['op-upload-recovery'] });
  });
});
