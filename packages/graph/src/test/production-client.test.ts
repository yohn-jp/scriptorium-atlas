import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphDelta, GraphEdge, GraphEdgePage, GraphNode, NodeRef, ProviderPage, SnapshotRef } from '@scriptorium-atlas/contracts';
import { GraphError, nodeKey } from '../index.js';
import { GraphWorkerClientError, createGraphWorkerClient } from '../worker/client.js';
import { createGraphWorkerMessageHandler } from '../worker/engine.js';
import type { GraphWorkerRequest, GraphWorkerResponse, WorkerPort } from '../worker/protocol.js';

const initial: SnapshotRef = { workspaceId: 'workspace', sourceRevision: 'source-1', providerRevision: 'provider-1', epoch: 1 };

test('public Worker client runs the production engine across provider identities, missing refs, deltas, and full resync', async () => {
  const worker = new ProductionGraphWorkerPort();
  const client = createGraphWorkerClient({ workerFactory: () => worker });
  const aliceOne = ref('provider.one', 'alice');
  const aliceTwo = ref('provider.two', 'alice');
  const unresolved = ref('provider.three', 'missing');
  const bridge = makeEdge('provider.one', 'bridge', aliceOne, aliceTwo);
  const dangling = makeEdge('provider.two', 'dangling', aliceTwo, unresolved);

  await client.replaceSnapshotFromPages(
    initial,
    [
      { snapshot: initial, items: [makeNode(aliceOne, 'Alice one')], nextCursor: 'nodes-2', complete: false },
      { snapshot: initial, items: [makeNode(aliceTwo, 'Alice two')], nextCursor: null, complete: true },
    ],
    [
      { snapshot: initial, items: [bridge], nextCursor: 'edges-2', complete: false },
      { snapshot: initial, items: [dangling], nextCursor: null, complete: true },
    ],
  );

  const sameLocalId = await client.search({ query: 'Alice' });
  assert.deepEqual(sameLocalId.items.map(({ node }) => nodeKey(node.ref)).sort(), [nodeKey(aliceOne), nodeKey(aliceTwo)].sort());
  assert.equal(sameLocalId.totalMatches, 2);

  const acrossProviders = await client.shortestPath({ from: aliceOne, to: aliceTwo, direction: 'out', maxHops: 1 });
  assert.equal(acrossProviders.status, 'found');
  if (acrossProviders.status === 'found') assert.equal(acrossProviders.hops, 1);

  const missingTarget = await client.neighbors({ from: aliceTwo, direction: 'out', depth: 1 });
  assert.deepEqual(missingTarget.unresolved.map(nodeKey), [nodeKey(unresolved)]);
  assert.equal(missingTarget.nodes[0]?.node, undefined);

  const next: SnapshotRef = { ...initial, sourceRevision: 'source-2', providerRevision: 'provider-2' };
  const validDelta: GraphDelta = {
    previousSnapshot: initial,
    snapshot: next,
    changedNodes: [makeNode(aliceTwo, 'Alice renamed')],
  };
  await client.applyDelta(validDelta);
  assert.deepEqual((await client.search({ query: 'renamed' })).items.map(({ node }) => nodeKey(node.ref)), [nodeKey(aliceTwo)]);

  const gap: GraphDelta = {
    previousSnapshot: initial,
    snapshot: { ...next, providerRevision: 'provider-3' },
    changedNodes: [makeNode(aliceTwo, 'must not apply')],
  };
  await assert.rejects(client.applyDelta(gap), (error: unknown) => error instanceof GraphError && error.code === 'RESYNC_REQUIRED');
  assert.equal((await client.search({ query: 'renamed' })).items[0]?.node.label, 'Alice renamed');

  const resync: SnapshotRef = { workspaceId: initial.workspaceId, sourceRevision: 'source-3', providerRevision: 'provider-4', epoch: 2 };
  await client.replaceSnapshotFromPages(
    resync,
    [{ snapshot: resync, items: [makeNode(aliceTwo, 'Alice resynced')], nextCursor: null, complete: true }],
    [{ snapshot: resync, items: [], nextCursor: null, complete: true }],
  );
  assert.deepEqual((await client.search({ query: 'resynced' })).items.map(({ node }) => nodeKey(node.ref)), [nodeKey(aliceTwo)]);
  assert.equal(worker.terminateCount, 0);

  client.close();
  assert.equal(worker.terminateCount, 1, 'closing the public client terminates its production-engine Worker port');
  assert.equal(worker.listenerCount, 0, 'closing removes the client response listener');
});

test('public client rejects incomplete pages and duplicate edge IDs before replacing its current graph', async () => {
  const worker = new ProductionGraphWorkerPort();
  const client = createGraphWorkerClient({ workerFactory: () => worker });
  const refA = ref('provider.one', 'a');
  const refB = ref('provider.one', 'b');
  await client.replaceSnapshot(initial, [makeNode(refA, 'A')], []);

  const partialNodes: ProviderPage[] = [{ snapshot: initial, items: [makeNode(refB, 'B')], nextCursor: 'more', complete: false }];
  assert.throws(() => client.replaceSnapshotFromPages(initial, partialNodes, [
    { snapshot: initial, items: [], nextCursor: null, complete: true },
  ]), (error: unknown) => error instanceof GraphError && error.code === 'INCOMPLETE_SNAPSHOT');

  const duplicateEdge = makeEdge('provider.one', 'same-edge', refA, refB);
  const duplicateEdges: GraphEdgePage[] = [
    { snapshot: initial, items: [duplicateEdge], nextCursor: 'edges-2', complete: false },
    { snapshot: initial, items: [duplicateEdge], nextCursor: null, complete: true },
  ];
  assert.throws(() => client.replaceSnapshotFromPages(initial, [
    { snapshot: initial, items: [makeNode(refA, 'A'), makeNode(refB, 'B')], nextCursor: null, complete: true },
  ], duplicateEdges), (error: unknown) => error instanceof GraphError && error.code === 'DUPLICATE_EDGE');

  assert.deepEqual((await client.search({ query: 'A' })).items.map(({ node }) => nodeKey(node.ref)), [nodeKey(refA)], 'failed ingestion leaves the previous accepted graph available');
  client.close();
});

function ref(providerId: string, localId: string): NodeRef {
  return { providerId, localId };
}

function makeNode(nodeRef: NodeRef, label: string): GraphNode {
  return { ref: nodeRef, kind: 'test.entity', label };
}

function makeEdge(providerId: string, localId: string, from: NodeRef, to: NodeRef): GraphEdge {
  return { ref: ref(providerId, localId), from, to, kind: 'test.link', directed: true };
}

class ProductionGraphWorkerPort implements WorkerPort {
  terminateCount = 0;
  private readonly messageListeners = new Set<(event: MessageEvent<GraphWorkerResponse>) => void>();
  private readonly failureListeners = new Set<(event: Event) => void>();
  private readonly handle = createGraphWorkerMessageHandler((response) => {
    queueMicrotask(() => {
      if (this.terminateCount > 0) return;
      for (const listener of this.messageListeners) listener({ data: response } as MessageEvent<GraphWorkerResponse>);
    });
  });

  get listenerCount(): number {
    return this.messageListeners.size + this.failureListeners.size;
  }

  postMessage(message: GraphWorkerRequest): void {
    queueMicrotask(() => {
      if (this.terminateCount === 0) this.handle(message);
    });
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<GraphWorkerResponse>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: ((event: MessageEvent<GraphWorkerResponse>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.messageListeners.add(listener as (event: MessageEvent<GraphWorkerResponse>) => void);
    else this.failureListeners.add(listener as (event: Event) => void);
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent<GraphWorkerResponse>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: ((event: MessageEvent<GraphWorkerResponse>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.messageListeners.delete(listener as (event: MessageEvent<GraphWorkerResponse>) => void);
    else this.failureListeners.delete(listener as (event: Event) => void);
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}
