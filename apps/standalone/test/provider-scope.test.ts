import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge, GraphNode, ProviderGrant, SnapshotRef } from '@scriptorium-atlas/contracts';
import { assertProviderRequestScope, assertProviderResultScope } from '../src/provider-scope.js';

const providerId = 'test.provider';
const snapshot: SnapshotRef = { workspaceId: 'test-workspace', sourceRevision: 'source-1', providerRevision: 'provider-1', epoch: 2 };
const grants: ProviderGrant[] = [{ capability: 'graph.read' }, { capability: 'workspace.files.read', paths: ['bible/'] }];
const scope = { providerId, snapshot, grants, foreignProviderAllowed: (id: string) => id === 'test.allowed' };
const node: GraphNode = { ref: { providerId, localId: 'alice' }, kind: 'test.entity', label: 'Alice',
  source: { workspaceId: snapshot.workspaceId, path: 'bible/alice.yaml', revision: 'file-1' } };
const page = (items: unknown[]) => ({ snapshot, items, nextCursor: null, complete: true });

test('provider source refs stay in its granted workspace and safe path scope', () => {
  const request = { method: 'listNodes', params: {} } as const;
  assertProviderResultScope(scope, request, page([node]));
  for (const source of [
    { ...node.source!, workspaceId: 'other-workspace' },
    { ...node.source!, path: 'manuscript/private.md' },
    { ...node.source!, path: 'bible/../private.yaml' },
    { ...node.source!, path: 'bible-other/alice.yaml' },
  ]) assert.throws(() => assertProviderResultScope(scope, request, page([{ ...node, source }])), /PROTOCOL_INVALID/);
});

test('provider cannot claim another provider node identity or route a foreign node query', () => {
  assert.throws(() => assertProviderResultScope(scope, { method: 'listNodes', params: {} }, page([{ ...node, ref: { providerId: 'test.other', localId: 'alice' } }])), /identity/);
  assert.throws(() => assertProviderRequestScope(providerId, { method: 'getNodes', params: { refs: [{ providerId: 'test.other', localId: 'alice' }] } }), /PERMISSION_DENIED/);
  assert.throws(() => assertProviderRequestScope(providerId, { method: 'neighbors', params: { from: { providerId: 'test.other', localId: 'alice' }, depth: 1, direction: 'both', limit: 10 } }), /PERMISSION_DENIED/);
});

test('only authorized cross-provider edge endpoints survive, including unresolved local targets', () => {
  const edge: GraphEdge = { ref: { providerId, localId: 'edge-1' }, from: node.ref, to: { providerId, localId: 'missing' }, kind: 'test.link', directed: true };
  const request = { method: 'listEdges', params: {} } as const;
  assertProviderResultScope(scope, request, page([edge]));
  assertProviderResultScope(scope, request, page([{ ...edge, to: { providerId: 'test.allowed', localId: 'missing' } }]));
  assert.throws(() => assertProviderResultScope(scope, request, page([{ ...edge, to: { providerId: 'test.denied', localId: 'missing' } }])), /Cross-provider/);
  assert.throws(() => assertProviderResultScope(scope, request, page([{ ...edge, ref: { providerId: 'test.allowed', localId: 'edge-1' } }])), /identity/);
  assert.throws(() => assertProviderResultScope(scope, request, page([{ ...edge, provenance: [{ path: 'private/alice.yaml', revision: 'r1', field: 'links' }] }])), /Path/);
});

test('neighbor and delta payloads enforce the same scope and exact transition', () => {
  const query = { method: 'neighbors', params: { from: node.ref, depth: 1, direction: 'both', limit: 10 } } as const;
  assertProviderResultScope(scope, query, page([{ node, edges: [] }]));
  assert.throws(() => assertProviderResultScope(scope, query, page([{ node: { ...node, ref: { providerId: 'test.other', localId: 'alice' } }, edges: [] }])), /identity/);
  const previousSnapshot = { ...snapshot, sourceRevision: 'source-0', providerRevision: 'provider-0' };
  const request = { method: 'diff', params: { previousSnapshot, limit: 10 } } as const;
  const delta = { snapshot, previousSnapshot, changedNodes: [node], removedNodes: [{ providerId, localId: 'removed' }] };
  assertProviderResultScope(scope, request, page([delta]));
  assert.throws(() => assertProviderResultScope(scope, request, page([{ ...delta, removedNodes: [{ providerId: 'test.other', localId: 'removed' }] }])), /identity/);
  assert.throws(() => assertProviderResultScope(scope, request, page([{ ...delta, previousSnapshot: { ...previousSnapshot, sourceRevision: 'wrong' } }])), /Snapshot/);
});
