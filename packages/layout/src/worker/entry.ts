import type { LayoutWorkerRequest, LayoutWorkerResponse } from './protocol.js';
import { calculateLayout } from '../compute.js';

const workerScope = globalThis as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener('message', (event: MessageEvent<LayoutWorkerRequest>) => {
  const request = event.data;
  void calculateLayout(request.input).then(
    (result) => respond({
      requestId: request.requestId,
      generation: request.generation,
      snapshotKey: request.snapshotKey,
      boardRevision: request.boardRevision,
      ok: true,
      result,
    }),
    (error) => {
      const layoutError = error as { code?: string; message?: string };
      respond({
        requestId: request.requestId,
        generation: request.generation,
        snapshotKey: request.snapshotKey,
        boardRevision: request.boardRevision,
        ok: false,
        error: { code: layoutError.code ?? 'WORKER_FAILED', message: layoutError.message ?? 'Layout calculation failed' },
      });
    },
  );
});

function respond(response: LayoutWorkerResponse): void {
  workerScope.postMessage(response);
}
