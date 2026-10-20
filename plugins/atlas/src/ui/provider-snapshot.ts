import type { GraphEdge, GraphNode, SnapshotRef } from '@scriptorium-atlas/contracts';
import { sha256Hex } from './host-utils.js';

export type ProviderSnapshot = {
  providerId: string;
  providerIds: string[];
  /** Providers whose available graph is only a partial view of the source inventory. */
  incompleteProviderIds: string[];
  snapshot: SnapshotRef;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type ConnectedProvider = {
  providerId: string;
  leaseId: string;
  /** Source-data completeness, independent of whether the last page was reached. */
  complete: boolean;
  snapshot: SnapshotRef;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

/** A null cursor ends pagination even when the provider's source inventory is incomplete. */
export function hasMoreProviderPages(page: { readonly nextCursor: string | null }): boolean {
  return page.nextCursor !== null;
}

/** Page exhaustion and source completeness are distinct; both are required for a complete graph. */
export function providerPagesAreComplete(pages: readonly { readonly nextCursor: string | null; readonly complete: boolean }[]): boolean {
  return pages.length > 0
    && !hasMoreProviderPages(pages[pages.length - 1]!)
    && pages.every((page) => page.complete);
}

export async function assembleProviderSnapshot(entries: ReadonlyMap<string, ConnectedProvider>): Promise<ProviderSnapshot> {
  const ordered = [...entries.values()].sort((left, right) => left.providerId < right.providerId ? -1 : left.providerId > right.providerId ? 1 : 0);
  const first = ordered[0];
  if (!first) throw new Error('Providerスナップショットが1つ以上必要です。');
  for (const entry of ordered.slice(1)) {
    if (entry.snapshot.workspaceId !== first.snapshot.workspaceId
      || entry.snapshot.sourceRevision !== first.snapshot.sourceRevision) {
      throw new Error('Providerから異なるワークスペースまたはソースリビジョンのスナップショットが返されました。');
    }
  }
  const snapshot: SnapshotRef = ordered.length === 1
    ? first.snapshot
    : {
        workspaceId: first.snapshot.workspaceId,
        sourceRevision: first.snapshot.sourceRevision,
        providerRevision: `atlas-composite-v1:${await sha256Hex(new TextEncoder().encode(JSON.stringify(ordered.map((item) => [item.providerId, item.snapshot.providerRevision, item.snapshot.epoch]))))}`,
        epoch: stableCompositeEpoch(ordered.map((item) => [item.providerId, item.snapshot.epoch])),
      };
  return {
    providerId: ordered.map((item) => item.providerId).join(' + '),
    providerIds: ordered.map((item) => item.providerId),
    incompleteProviderIds: ordered.filter((item) => !item.complete).map((item) => item.providerId),
    snapshot,
    nodes: ordered.flatMap((item) => item.nodes),
    edges: ordered.flatMap((item) => item.edges),
  };
}

function stableCompositeEpoch(entries: readonly (readonly [string, number])[]): number {
  const input = JSON.stringify(entries);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}
