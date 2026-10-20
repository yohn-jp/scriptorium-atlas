import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GraphError,
  applyGraphDelta,
  applyGraphDeltaPages,
  beginGraphSnapshot,
  createGraphIndex,
  nodeKey,
  neighbors,
  searchGraph,
  shortestPath,
  weakComponents,
} from '../index.js';
import type { GraphDelta, GraphEdge, GraphNode, NodeRef, SnapshotRef } from '@scriptorium-atlas/contracts';

const snapshot: SnapshotRef = { workspaceId: 'workspace', sourceRevision: 'source-1', providerRevision: 'provider-1', epoch: 1 };
const provider = 'story.test';

function ref(localId: string, providerId = provider): NodeRef {
  return { providerId, localId };
}

function node(localId: string, patch: Partial<GraphNode> = {}, providerId = provider): GraphNode {
  return {
    ref: ref(localId, providerId),
    kind: 'story.character',
    label: localId,
    ...patch,
  };
}

function edge(localId: string, from: NodeRef, to: NodeRef, directed = true): GraphEdge {
  return { ref: ref(localId), from, to, kind: 'story.knows', directed };
}

function graph(nodes: GraphNode[], edges: GraphEdge[] = [], at = snapshot) {
  return createGraphIndex({ snapshot: at, nodes, edges });
}

function errorCode(operation: () => unknown, expected: string): void {
  assert.throws(operation, (error: unknown) => error instanceof GraphError && error.code === expected);
}

test('NodeRef identity uses both provider and local id without delimiter collisions', () => {
  assert.equal(nodeKey(ref('alice', 'provider.one')), JSON.stringify(['provider.one', 'alice']));
  assert.notEqual(nodeKey(ref('alice', 'provider.one')), nodeKey(ref('alice', 'provider.two')));
  assert.notEqual(nodeKey(ref('a:b', 'provider')), nodeKey(ref('b', 'provider:a')));
  assert.equal(graph([node('alice', {}, 'provider.one'), node('alice', {}, 'provider.two')]).nodes.length, 2);
});

test('edge identities use both provider and local edge id and reject duplicates', () => {
  const from = ref('alice', 'provider.one');
  const to = ref('alice', 'provider.two');
  const first = edge('relation', from, to);
  const second = { ...first, ref: ref('relation', 'provider.two') };
  assert.equal(graph([node('alice', {}, 'provider.one'), node('alice', {}, 'provider.two')], [first, second]).edges.length, 2);
  errorCode(() => graph([], [first, first]), 'DUPLICATE_EDGE');
});

test('search indexes Japanese substrings across every contracted searchable field', () => {
  const indexed = graph([
    node('amayadori', {
      label: '雨宿りの夜',
      aliases: ['青い鳥'],
      tags: ['伏線', '第一章'],
      kind: 'story.character',
      source: { workspaceId: 'workspace', path: 'bible/人物/澪.yaml', revision: 'r1' },
    }),
    node('other', { label: '別の人物', kind: 'story.location' }),
  ]);

  assert.deepEqual(searchGraph(indexed, { query: '雨宿り' }).items.map((item) => item.matchedFields), [['name']]);
  assert.deepEqual(searchGraph(indexed, { query: 'AMAYADORI' }).items[0]?.matchedFields, ['id']);
  assert.deepEqual(searchGraph(indexed, { query: '青い' }).items[0]?.matchedFields, ['alias']);
  assert.deepEqual(searchGraph(indexed, { query: '伏線' }).items[0]?.matchedFields, ['tag']);
  assert.deepEqual(searchGraph(indexed, { query: 'character' }).items[0]?.matchedFields, ['type']);
  assert.deepEqual(searchGraph(indexed, { query: '人物/澪' }).items[0]?.matchedFields, ['path']);
  assert.equal(searchGraph(indexed, { query: '', kinds: ['story.location'] }).items[0]?.node.ref.localId, 'other');
});

test('snapshot page streams require complete node and edge pages from one exact snapshot', () => {
  const next = { ...snapshot, providerRevision: 'provider-2' };
  const builder = beginGraphSnapshot(snapshot);
  builder.addNodesPage({ snapshot, items: [node('a')], nextCursor: 'nodes-next', complete: false });
  builder.addNodesPage({ snapshot, items: [node('b')], nextCursor: null, complete: true });
  builder.addEdgesPage({ snapshot, items: [], nextCursor: null, complete: true });
  assert.deepEqual(builder.build().nodes.map((item) => item.ref.localId), ['a', 'b']);

  const incomplete = beginGraphSnapshot(snapshot);
  incomplete.addNodesPage({ snapshot, items: [], nextCursor: 'more-nodes', complete: false });
  errorCode(() => incomplete.build(), 'INCOMPLETE_SNAPSHOT');

  const mixed = beginGraphSnapshot(snapshot);
  errorCode(() => mixed.addNodesPage({ snapshot: next, items: [], nextCursor: null, complete: true }), 'SNAPSHOT_MISMATCH');

  const duplicate = beginGraphSnapshot(snapshot);
  duplicate.addNodesPage({ snapshot, items: [node('a')], nextCursor: 'page-2', complete: false });
  duplicate.addNodesPage({ snapshot, items: [node('a')], nextCursor: null, complete: true });
  duplicate.addEdgesPage({ snapshot, items: [], nextCursor: null, complete: true });
  errorCode(() => duplicate.build(), 'DUPLICATE_NODE');
});

test('page cursors are unique, terminal pages stay terminal, and every snapshot field including epoch must match', () => {
  const builder = beginGraphSnapshot(snapshot);
  builder.addNodesPage({ snapshot, items: [], nextCursor: 'next', complete: false });
  errorCode(() => builder.addNodesPage({ snapshot, items: [], nextCursor: 'next', complete: false }), 'CURSOR_LOOP');

  for (const mismatch of [
    { workspaceId: 'other-workspace' },
    { sourceRevision: 'source-2' },
    { providerRevision: 'provider-2' },
    { epoch: snapshot.epoch + 1 },
  ]) {
    const mismatched = beginGraphSnapshot(snapshot);
    errorCode(() => mismatched.addNodesPage({ snapshot: { ...snapshot, ...mismatch }, items: [], nextCursor: null, complete: true }), 'SNAPSHOT_MISMATCH');
  }

  const terminal = beginGraphSnapshot(snapshot);
  terminal.addNodesPage({ snapshot, items: [], nextCursor: null, complete: true });
  errorCode(() => terminal.addNodesPage({ snapshot, items: [], nextCursor: null, complete: true }), 'INCOMPLETE_SNAPSHOT');

  const partialEdges = beginGraphSnapshot(snapshot);
  partialEdges.addNodesPage({ snapshot, items: [], nextCursor: null, complete: true });
  partialEdges.addEdgesPage({ snapshot, items: [], nextCursor: 'edge-page-2', complete: false });
  errorCode(() => partialEdges.build(), 'INCOMPLETE_SNAPSHOT');
});

test('neighbors respect direction and hop depth, retaining unresolved endpoints', () => {
  const a = ref('a');
  const b = ref('b');
  const c = ref('c');
  const unknown = ref('missing');
  const indexed = graph([node('a'), node('b'), node('c')], [
    edge('ab', a, b),
    edge('bc', b, c),
    edge('cm', c, unknown),
  ]);

  assert.deepEqual(neighbors(indexed, { from: b, direction: 'out', depth: 1 }).nodes.map((item) => item.ref.localId), ['c']);
  assert.deepEqual(neighbors(indexed, { from: b, direction: 'in', depth: 1 }).nodes.map((item) => item.ref.localId), ['a']);
  const depthTwo = neighbors(indexed, { from: a, direction: 'out', depth: 2 });
  assert.deepEqual(depthTwo.nodes.map((item) => item.ref.localId), ['b', 'c']);
  const depthThree = neighbors(indexed, { from: a, direction: 'out', depth: 3 });
  assert.deepEqual(depthThree.unresolved.map((item) => item.localId), ['missing']);
  assert.equal(depthThree.edges.length, 3);
  errorCode(() => neighbors(indexed, { from: a, direction: 'both', depth: 4 }), 'INVALID_DEPTH');
});

test('shortest path is unweighted, directed by request, and reports bounded searches', () => {
  const a = ref('a');
  const b = ref('b');
  const c = ref('c');
  const d = ref('d');
  const indexed = graph([node('a'), node('b'), node('c'), node('d')], [
    edge('ab', a, b),
    edge('bc', b, c),
    edge('ac', a, c),
    edge('cd', c, d),
  ]);

  const direct = shortestPath(indexed, { from: a, to: c, direction: 'out' });
  assert.equal(direct.status, 'found');
  if (direct.status === 'found') {
    assert.equal(direct.hops, 1);
    assert.deepEqual(direct.refs.map((item) => item.localId), ['a', 'c']);
  }
  assert.equal(shortestPath(indexed, { from: d, to: a, direction: 'out' }).status, 'unreachable');
  assert.equal(shortestPath(indexed, { from: a, to: d, direction: 'out', maxHops: 1 }).status, 'bounded');
  assert.equal(shortestPath(indexed, { from: a, to: d, direction: 'out', maxVisited: 1 }).status, 'bounded');
});

test('weak components group direction-independent nodes and expose dangling references', () => {
  const a = ref('a');
  const b = ref('b');
  const c = ref('c');
  const missing = ref('missing');
  const indexed = graph([node('a'), node('b'), node('c')], [edge('ab', b, a), edge('cm', c, missing)]);
  const groups = weakComponents(indexed);
  assert.deepEqual(groups.map((group) => group.refs.map((item) => item.localId)), [['a', 'b'], ['c', 'missing']]);
  assert.deepEqual(groups[1]?.unresolved.map((item) => item.localId), ['missing']);
});

test('deltas apply atomically and gaps, epoch changes, duplicate changes, and missing removals require resync', () => {
  const a = ref('a');
  const b = ref('b');
  const indexed = graph([node('a'), node('b')], [edge('ab', a, b)]);
  const nextSnapshot = { ...snapshot, sourceRevision: 'source-2', providerRevision: 'provider-2' };
  const delta: GraphDelta = {
    previousSnapshot: snapshot,
    snapshot: nextSnapshot,
    changedNodes: [node('a', { label: 'changed' })],
    removedEdges: [ref('ab')],
  };
  const updated = applyGraphDelta(indexed, delta);
  assert.equal(updated.getNode(a)?.label, 'changed');
  assert.equal(updated.edges.length, 0);
  assert.equal(indexed.getNode(a)?.label, 'a');

  errorCode(() => applyGraphDelta(updated, delta), 'RESYNC_REQUIRED');
  errorCode(() => applyGraphDelta(indexed, { ...delta, previousSnapshot: { ...snapshot, epoch: 2 } }), 'RESYNC_REQUIRED');
  errorCode(() => applyGraphDelta(indexed, { ...delta, changedNodes: [node('a'), node('a')] }), 'DUPLICATE_DELTA_ITEM');
  errorCode(() => applyGraphDelta(indexed, { ...delta, removedNodes: [ref('missing')] }), 'RESYNC_REQUIRED');
});

test('complete delta pages combine only one consecutive snapshot transition', () => {
  const indexed = graph([node('a')]);
  const target = { ...snapshot, providerRevision: 'provider-2' };
  const pages = [
    { snapshot: target, items: [{ previousSnapshot: snapshot, snapshot: target, changedNodes: [node('b')] }], nextCursor: 'delta-page-2', complete: false },
    { snapshot: target, items: [{ previousSnapshot: snapshot, snapshot: target, changedNodes: [node('c')] }], nextCursor: null, complete: true },
  ];
  assert.deepEqual(applyGraphDeltaPages(indexed, pages).nodes.map((item) => item.ref.localId), ['a', 'b', 'c']);
  errorCode(() => applyGraphDeltaPages(indexed, [pages[0]!]), 'RESYNC_REQUIRED');
  errorCode(() => applyGraphDeltaPages(indexed, [{ ...pages[1]!, items: [{ previousSnapshot: target, snapshot: target }] }]), 'RESYNC_REQUIRED');
  errorCode(() => applyGraphDeltaPages(indexed, [
    { ...pages[0]!, nextCursor: 'repeat' },
    { ...pages[0]!, nextCursor: 'repeat' },
    pages[1]!,
  ]), 'CURSOR_LOOP');
});
