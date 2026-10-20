import type { GraphWorkerRequest, GraphWorkerResponse } from './protocol.js';
import {
  GraphIndex,
  applyGraphDelta,
  neighbors,
  searchGraph,
  snapshotKey,
  shortestPath,
  weakComponents,
} from '../index.js';

const workerScope = globalThis as unknown as DedicatedWorkerGlobalScope;
let currentIndex: GraphIndex | undefined;
let currentSnapshotKey: string | null = null;

workerScope.addEventListener('message', (event: MessageEvent<GraphWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'replace') {
      const nextIndex = new GraphIndex({ snapshot: request.snapshot, nodes: request.nodes, edges: request.edges });
      currentIndex = nextIndex;
      currentSnapshotKey = snapshotKey(nextIndex.snapshot);
      respond({ id: request.id, snapshotKey: currentSnapshotKey, ok: true });
      return;
    }

    if (request.type === 'delta') {
      if (!currentIndex || currentSnapshotKey !== snapshotKey(request.delta.previousSnapshot)) {
        respond({ id: request.id, snapshotKey: currentSnapshotKey, ok: false, error: { code: 'RESYNC_REQUIRED', message: 'Delta base does not match the Worker snapshot' } });
        return;
      }
      const nextIndex = applyGraphDelta(currentIndex, request.delta);
      currentIndex = nextIndex;
      currentSnapshotKey = snapshotKey(nextIndex.snapshot);
      respond({ id: request.id, snapshotKey: currentSnapshotKey, ok: true });
      return;
    }

    if (!currentIndex || currentSnapshotKey !== request.snapshotKey) {
      respond({ id: request.id, snapshotKey: currentSnapshotKey, ok: false, error: { code: 'RESYNC_REQUIRED', message: 'Worker snapshot is missing or stale' } });
      return;
    }

    switch (request.type) {
      case 'search':
        respond({ id: request.id, snapshotKey: currentSnapshotKey, ok: true, value: searchGraph(currentIndex, request.options) });
        break;
      case 'neighbors':
        respond({ id: request.id, snapshotKey: currentSnapshotKey, ok: true, value: neighbors(currentIndex, request) });
        break;
      case 'shortestPath':
        respond({ id: request.id, snapshotKey: currentSnapshotKey, ok: true, value: shortestPath(currentIndex, request.options) });
        break;
      case 'weakComponents':
        respond({ id: request.id, snapshotKey: currentSnapshotKey, ok: true, value: weakComponents(currentIndex) });
        break;
    }
  } catch (error) {
    const graphError = error as { code?: string; message?: string };
    respond({
      id: request.id,
      snapshotKey: currentSnapshotKey,
      ok: false,
      error: { code: graphError.code ?? 'WORKER_FAILED', message: graphError.message ?? 'Graph operation failed' },
    });
  }
});

function respond(response: GraphWorkerResponse): void {
  workerScope.postMessage(response);
}
