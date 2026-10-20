import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { assertBundleWorkspaceCapacity, MAX_BUNDLE_EXPANDED_BYTES, MAX_WORKSPACE_FILES, serializedManifestBytes } from '../src/bundle.js';
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
    const files = Array.from({ length: MAX_WORKSPACE_FILES }, (_, index) => ({
      path: `file-${index}.bin`,
      revision: 'c'.repeat(64),
      byteLength: 0
    }));
    expect(() => assertBundleWorkspaceCapacity('file-cap', 'File cap', 'd'.repeat(64), files)).not.toThrow();
    expect(() => assertBundleWorkspaceCapacity('file-cap', 'File cap', 'd'.repeat(64), [...files, {
      path: 'file-extra.bin', revision: 'e'.repeat(64), byteLength: 0
    }])).toThrow();
  });

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
