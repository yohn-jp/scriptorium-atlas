import { describe, expect, it } from 'vitest';
import { createGraphIndex } from '@scriptorium-atlas/graph';
import type { GraphNode, SnapshotRef } from '@scriptorium-atlas/contracts';
import { assembleProviderSnapshot, hasMoreProviderPages, providerPagesAreComplete, type ConnectedProvider } from './provider-snapshot.js';

const workspaceId = 'provider-refresh-test';
const sourceRevision = 'source-v1';

function entry(providerId: string, epoch: number, label: string): ConnectedProvider {
  const snapshot: SnapshotRef = { workspaceId, sourceRevision, providerRevision: `${providerId}-revision`, epoch };
  const node: GraphNode = { ref: { providerId, localId: 'alice' }, kind: 'story.character', label };
  return { providerId, leaseId: `${providerId}-lease`, complete: true, snapshot, nodes: [node], edges: [] };
}

describe('Provider pagination and source completeness', () => {
  it('consumes a terminal page even when the source inventory is incomplete', () => {
    expect(hasMoreProviderPages({ nextCursor: null })).toBe(false);
    expect(providerPagesAreComplete([{ complete: false, nextCursor: null }])).toBe(false);
    expect(providerPagesAreComplete([{ complete: true, nextCursor: 'next' }, { complete: true, nextCursor: null }])).toBe(true);
    expect(providerPagesAreComplete([{ complete: false, nextCursor: 'next' }, { complete: true, nextCursor: null }])).toBe(false);
    expect(hasMoreProviderPages({ nextCursor: 'next' })).toBe(true);
    expect(providerPagesAreComplete([{ complete: true, nextCursor: 'next' }])).toBe(false);
    expect(providerPagesAreComplete([])).toBe(false);
  });

  it('retains healthy nodes and identifies incomplete providers in a mixed graph', async () => {
    const healthy = entry('scriptorium.healthy', 1, 'Healthy');
    const partial = { ...entry('scriptorium.partial', 2, 'Usable'), complete: false };
    const graph = await assembleProviderSnapshot(new Map([[healthy.providerId, healthy], [partial.providerId, partial]]));
    expect(graph.nodes.map((node) => node.label)).toEqual(['Healthy', 'Usable']);
    expect(graph.incompleteProviderIds).toEqual(['scriptorium.partial']);
  });
});

describe('assembleProviderSnapshot', () => {
  it('accepts independent provider epochs and keeps identical local IDs distinct', async () => {
    const first = entry('scriptorium.story-alpha', 3, 'Alice from Alpha');
    const second = entry('scriptorium.story-beta', 17, 'Alice from Beta');
    const combined = await assembleProviderSnapshot(new Map([
      [second.providerId, second],
      [first.providerId, first],
    ]));
    const index = createGraphIndex({ snapshot: combined.snapshot, nodes: combined.nodes, edges: combined.edges });

    expect(combined.providerIds).toEqual(['scriptorium.story-alpha', 'scriptorium.story-beta']);
    expect(combined.nodes).toHaveLength(2);
    expect(index.nodes).toHaveLength(2);
    expect(index.getNode({ providerId: first.providerId, localId: 'alice' })?.label).toBe('Alice from Alpha');
    expect(index.getNode({ providerId: second.providerId, localId: 'alice' })?.label).toBe('Alice from Beta');
    expect(Number.isSafeInteger(combined.snapshot.epoch)).toBe(true);
  });

  it('derives a deterministic composite identity from provider ID, revision, and epoch', async () => {
    const first = entry('scriptorium.story-alpha', 3, 'Alice');
    const second = entry('scriptorium.story-beta', 17, 'Alice');
    const reversed = new Map([
      [first.providerId, first],
      [second.providerId, second],
    ]);
    const forward = await assembleProviderSnapshot(new Map([
      [second.providerId, second],
      [first.providerId, first],
    ]));
    const reordered = await assembleProviderSnapshot(reversed);
    const restarted = await assembleProviderSnapshot(new Map([
      [first.providerId, first],
      [second.providerId, { ...second, snapshot: { ...second.snapshot, epoch: 18 } }],
    ]));

    expect(reordered.snapshot).toEqual(forward.snapshot);
    expect(restarted.snapshot.providerRevision).not.toBe(forward.snapshot.providerRevision);
    expect(restarted.snapshot.epoch).not.toBe(forward.snapshot.epoch);
  });

  it('rejects providers from different source revisions', async () => {
    const first = entry('scriptorium.story-alpha', 3, 'Alice');
    const second = entry('scriptorium.story-beta', 17, 'Alice');
    const mismatched = { ...second, snapshot: { ...second.snapshot, sourceRevision: 'source-v2' } };

    await expect(assembleProviderSnapshot(new Map([
      [first.providerId, first],
      [second.providerId, mismatched],
    ]))).rejects.toThrow('異なるワークスペースまたはソースリビジョン');
  });
});
