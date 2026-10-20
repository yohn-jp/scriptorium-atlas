import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderRequest, ProviderRpcResponse, SnapshotRef, WorkspaceHandle } from '@scriptorium-atlas/contracts';
import { acquireProvider, callProvider, registerProvider, registerProviderOwner, releaseOwner, releaseProvider, type FrameProviderConnection } from '../src/provider-broker.js';

const workspace: WorkspaceHandle = { workspaceId: 'test-workspace', sourceRevision: 'a'.repeat(64), epoch: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(providerId: string) {
  const requests: ProviderRequest[] = [];
  let snapshot: SnapshotRef;
  let openGate: Promise<void> | undefined;
  let queryGate: Promise<void> | undefined;
  let wrongSnapshot = false;
  let emptyPage = false;
  const connection: FrameProviderConnection = {
    epoch: 7, workspaceId: workspace.workspaceId,
    snapshot: async value => ({workspaceId:value.workspaceId,sourceRevision:value.sourceRevision,epoch:7,providerRevision:`${providerId}:r1`}),
    grants: [{capability:'graph.read'}],
    fail: () => {},
    async call(request) {
      requests.push(request);
      let result: unknown;
      if (request.method === 'open') {
        snapshot = request.params.requestedSnapshot;
        await openGate;
        result = { handle: 'private-handle', actualSnapshot: wrongSnapshot ? { ...snapshot, sourceRevision: 'wrong' } : snapshot, capabilities: ['listNodes'] };
      } else if (request.method === 'close') result = null;
      else {
        await queryGate;
        result = { snapshot, items: emptyPage ? [] : [{ ref: { providerId, localId: 'alice' }, kind: 'test.entity', label: providerId }], nextCursor: null, complete: true };
      }
      return { type: 'atlas.provider.response', protocolVersion: 'atlas.graph/v1', requestId: crypto.randomUUID(), providerId,
        epoch: 7, method: request.method, ok: true, result, ...('handle' in request.params ? { handle: request.params.handle } : {}) } as ProviderRpcResponse;
    }
  };
  const unregister = registerProvider(providerId, connection);
  const owner = `owner-${providerId}`;
  registerProviderOwner(owner);
  return { owner, requests, connection, unregister,
    blockOpen: (gate: Promise<void>) => { openGate = gate; },
    blockQuery: (gate: Promise<void>) => { queryGate = gate; },
    staleOpen: () => { wrongSnapshot = true; },
    emptyPage: () => { emptyPage = true; },
    cleanup: () => { releaseOwner(owner); unregister(); }
  };
}

test('broker isolates provider-local IDs and never exposes another owner lease', async () => {
  const a = fixture('test.provider-a'); const b = fixture('test.provider-b');
  try {
    const la = await acquireProvider(a.owner, 'test.provider-a', workspace);
    const lb = await acquireProvider(b.owner, 'test.provider-b', workspace);
    const pa = await callProvider(a.owner, la.leaseId, { method: 'listNodes', params: { limit: 10 } });
    const pb = await callProvider(b.owner, lb.leaseId, { method: 'listNodes', params: { limit: 10 } });
    assert.notDeepEqual(pa.items[0], pb.items[0]);
    await assert.rejects(callProvider(b.owner, la.leaseId, { method: 'listNodes', params: {} }), /PERMISSION_DENIED/);
    assert.equal(a.requests.at(-1)?.params.handle, 'private-handle');
    assert.throws(() => registerProvider('test.provider-a', a.connection), /重複/);
  } finally { a.cleanup(); b.cleanup(); }
});

test('broker accepts empty pages and validates results against the requested method', async () => {
  const f = fixture('test.method-result');
  try {
    const lease = await acquireProvider(f.owner, 'test.method-result', workspace);
    await assert.rejects(callProvider(f.owner, lease.leaseId, { method: 'listEdges', params: {} }), /Invalid Atlas contract: graphEdgePage/);
    f.emptyPage();
    for (const method of ['listNodes', 'listEdges'] as const) {
      const result = await callProvider(f.owner, lease.leaseId, { method, params: {} });
      assert.deepEqual(result.items, []);
      assert.equal(result.complete, true);
    }
  } finally { f.cleanup(); }
});

test('late open after owner shutdown closes the handle instead of publishing a lease', async () => {
  const f = fixture('test.late-open'); const gate = deferred<void>();
  try {
    f.blockOpen(gate.promise);
    const opening = acquireProvider(f.owner, 'test.late-open', workspace);
    // Opening hashes the pinned source before reaching the transport.
    while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 1));
    releaseOwner(f.owner); gate.resolve();
    await assert.rejects(opening, /CANCELED/);
    assert.equal(f.requests.at(-1)?.method, 'close');
  } finally { f.cleanup(); }
});

test('a stale open snapshot is rejected and its newly opened handle is closed', async () => {
  const f = fixture('test.stale-open');
  try {
    f.staleOpen();
    await assert.rejects(acquireProvider(f.owner, 'test.stale-open', workspace), /SNAPSHOT_STALE/);
    assert.equal(f.requests.at(-1)?.method, 'close');
  } finally { f.cleanup(); }
});

test('a query response arriving after lease release is discarded', async () => {
  const f = fixture('test.late-query'); const gate = deferred<void>();
  try {
    const lease = await acquireProvider(f.owner, 'test.late-query', workspace);
    f.blockQuery(gate.promise);
    const query = callProvider(f.owner, lease.leaseId, { method: 'listNodes', params: {} });
    await releaseProvider(f.owner, lease.leaseId); gate.resolve();
    await assert.rejects(query, /CANCELED/);
  } finally { f.cleanup(); }
});
