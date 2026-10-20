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

/** Creates the message handler used by the production Worker entry point. */
export function createGraphWorkerMessageHandler(
  postMessage: (response: GraphWorkerResponse) => void,
): (request: GraphWorkerRequest) => void {
  let currentIndex: GraphIndex | undefined;
  let currentSnapshotKey: string | null = null;

  return (request) => {
    try {
      if (request.type === 'replace') {
        const nextIndex = new GraphIndex({ snapshot: request.snapshot, nodes: request.nodes, edges: request.edges });
        currentIndex = nextIndex;
        currentSnapshotKey = snapshotKey(nextIndex.snapshot);
        postMessage({ id: request.id, snapshotKey: currentSnapshotKey, ok: true });
        return;
      }

      if (request.type === 'delta') {
        if (!currentIndex || currentSnapshotKey !== snapshotKey(request.delta.previousSnapshot)) {
          postMessage({ id: request.id, snapshotKey: currentSnapshotKey, ok: false, error: { code: 'RESYNC_REQUIRED', message: 'Delta base does not match the Worker snapshot' } });
          return;
        }
        const nextIndex = applyGraphDelta(currentIndex, request.delta);
        currentIndex = nextIndex;
        currentSnapshotKey = snapshotKey(nextIndex.snapshot);
        postMessage({ id: request.id, snapshotKey: currentSnapshotKey, ok: true });
        return;
      }

      if (!currentIndex || currentSnapshotKey !== request.snapshotKey) {
        postMessage({ id: request.id, snapshotKey: currentSnapshotKey, ok: false, error: { code: 'RESYNC_REQUIRED', message: 'Worker snapshot is missing or stale' } });
        return;
      }

      switch (request.type) {
        case 'search':
          postMessage({ id: request.id, snapshotKey: currentSnapshotKey, ok: true, value: searchGraph(currentIndex, request.options) });
          break;
        case 'neighbors':
          postMessage({ id: request.id, snapshotKey: currentSnapshotKey, ok: true, value: neighbors(currentIndex, request) });
          break;
        case 'shortestPath':
          postMessage({ id: request.id, snapshotKey: currentSnapshotKey, ok: true, value: shortestPath(currentIndex, request.options) });
          break;
        case 'weakComponents':
          postMessage({ id: request.id, snapshotKey: currentSnapshotKey, ok: true, value: weakComponents(currentIndex) });
          break;
      }
    } catch (error) {
      const graphError = error as { code?: string; message?: string };
      postMessage({
        id: request.id,
        snapshotKey: currentSnapshotKey,
        ok: false,
        error: { code: graphError.code ?? 'WORKER_FAILED', message: graphError.message ?? 'Graph operation failed' },
      });
    }
  };
}
