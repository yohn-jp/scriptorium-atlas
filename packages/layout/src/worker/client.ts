import type { SnapshotRef } from '@scriptorium-atlas/contracts';
import { LayoutError, type LayoutErrorCode, type LayoutInput, type LayoutResult, type LayoutRevision } from '../types.js';
import type { LayoutWorkerPort, LayoutWorkerResponse } from './protocol.js';

export interface LayoutWorkerClientOptions {
  readonly workerFactory?: () => LayoutWorkerPort;
}

export interface LayoutWorkerClient {
  calculate(input: LayoutInput, signal?: AbortSignal): Promise<LayoutResult>;
  updateRevision(revision: LayoutRevision): void;
  cancel(): void;
  close(): void;
}

interface ActiveCalculation {
  readonly requestId: number;
  readonly generation: number;
  readonly snapshotKey: string | null;
  readonly boardRevision: LayoutInput['boardRevision'];
  readonly resolve: (result: LayoutResult) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/** Creates the layout Worker only when a caller explicitly calculates a layout. */
export function createLayoutWorkerClient(options: LayoutWorkerClientOptions = {}): LayoutWorkerClient {
  const createWorker = options.workerFactory ?? defaultWorkerFactory;
  let worker: LayoutWorkerPort | undefined;
  let active: ActiveCalculation | undefined;
  let activeRevisionKey = JSON.stringify([null, null]);
  let nextRequestId = 1;
  let generation = 0;
  let closed = false;

  const detachWorker = (): void => {
    const current = worker;
    worker = undefined;
    current?.removeEventListener('message', onMessage);
    current?.removeEventListener('error', onFailure);
    current?.removeEventListener('messageerror', onFailure);
    current?.terminate();
  };

  const clearActive = (): ActiveCalculation | undefined => {
    const previous = active;
    active = undefined;
    if (previous?.signal && previous.onAbort) previous.signal.removeEventListener('abort', previous.onAbort);
    return previous;
  };

  const onMessage = (event: MessageEvent<LayoutWorkerResponse>): void => {
    const response = event.data;
    const calculation = active;
    if (!calculation || response.requestId !== calculation.requestId) return; // duplicate or stale reply
    if (
      response.generation !== calculation.generation ||
      response.generation !== generation ||
      response.snapshotKey !== calculation.snapshotKey ||
      response.boardRevision !== calculation.boardRevision ||
      makeRevisionKey(response.snapshotKey, response.boardRevision) !== activeRevisionKey
    ) {
      clearActive()?.reject(new LayoutError('STALE_RESULT', 'Layout reply belongs to a stale snapshot or request'));
      return;
    }
    clearActive();
    if (!response.ok) {
      detachWorker();
      calculation.reject(layoutError(response.error?.code, response.error?.message));
      return;
    }
    if (
      !response.result ||
      (response.result.snapshot ? makeSnapshotKey(response.result.snapshot) : null) !== calculation.snapshotKey ||
      response.result.boardRevision !== calculation.boardRevision
    ) {
      calculation.reject(new LayoutError('STALE_RESULT', 'Layout result snapshot identity does not match its request'));
      return;
    }
    calculation.resolve(response.result);
  };

  const onFailure = (): void => {
    detachWorker();
    const calculation = clearActive();
    calculation?.reject(new LayoutError('WORKER_FAILED', 'Layout Worker failed and was terminated'));
  };

  function ensureWorker(): LayoutWorkerPort {
    if (closed) throw new LayoutError('CLOSED', 'Layout Worker client is closed');
    if (!worker) {
      worker = createWorker();
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onFailure);
      worker.addEventListener('messageerror', onFailure);
    }
    return worker;
  }

  function cancelWith(error: LayoutError): void {
    const calculation = clearActive();
    detachWorker();
    generation += 1;
    calculation?.reject(error);
  }

  function updateRevision(revision: LayoutRevision): void {
    const nextSnapshotKey = revision.snapshot ? makeSnapshotKey(revision.snapshot) : null;
    const nextKey = makeRevisionKey(nextSnapshotKey, revision.boardRevision);
    if (nextKey === activeRevisionKey) return;
    activeRevisionKey = nextKey;
    if (active) cancelWith(new LayoutError('STALE_RESULT', 'Layout input snapshot changed'));
    else detachWorker();
  }

  function calculate(input: LayoutInput, signal?: AbortSignal): Promise<LayoutResult> {
    if (closed) return Promise.reject(new LayoutError('CLOSED', 'Layout Worker client is closed'));
    if (signal?.aborted) return Promise.reject(abortError());
    updateRevision(input);
    if (active) cancelWith(new LayoutError('STALE_RESULT', 'A newer layout calculation replaced this result'));
    const requestId = nextRequestId++;
    const requestGeneration = ++generation;
    const currentSnapshotKey = input.snapshot ? makeSnapshotKey(input.snapshot) : null;
    const currentRevision = input.boardRevision;

    return new Promise<LayoutResult>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      if (signal) {
        onAbort = () => {
          if (active?.requestId === requestId) cancelWith(abortError() as LayoutError);
        };
      }
      active = { requestId, generation: requestGeneration, snapshotKey: currentSnapshotKey, boardRevision: currentRevision, resolve, reject, ...(signal ? { signal } : {}), ...(onAbort ? { onAbort } : {}) };
      if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });
      try {
        ensureWorker().postMessage({ requestId, generation: requestGeneration, snapshotKey: currentSnapshotKey, boardRevision: currentRevision, input });
      } catch (error) {
        clearActive();
        reject(error instanceof Error ? error : new LayoutError('WORKER_FAILED', String(error)));
      }
    });
  }

  function cancel(): void {
    cancelWith(new LayoutError('CANCELLED', 'Layout calculation was cancelled by terminating its Worker'));
  }

  function close(): void {
    if (closed) return;
    closed = true;
    cancelWith(new LayoutError('CLOSED', 'Layout Worker client is closed'));
  }

  return { calculate, updateRevision, cancel, close };
}

function abortError(): LayoutError {
  const error = new LayoutError('CANCELLED', 'Layout calculation was aborted');
  error.name = 'AbortError';
  return error;
}

function defaultWorkerFactory(): LayoutWorkerPort {
  return new Worker(new URL('./entry.js', import.meta.url), { type: 'module' }) as unknown as LayoutWorkerPort;
}

function layoutError(code: string | undefined, message: string | undefined): LayoutError {
  const allowed = new Set<LayoutErrorCode>(['INVALID_INPUT', 'DUPLICATE_NODE', 'DUPLICATE_EDGE', 'INVALID_PIN', 'CANCELLED', 'STALE_RESULT', 'WORKER_FAILED', 'CLOSED']);
  return new LayoutError(allowed.has(code as LayoutErrorCode) ? code as LayoutErrorCode : 'WORKER_FAILED', message ?? 'Layout calculation failed');
}

function makeSnapshotKey(snapshot: SnapshotRef): string {
  return JSON.stringify([snapshot.workspaceId, snapshot.sourceRevision, snapshot.providerRevision, snapshot.epoch]);
}

function makeRevisionKey(snapshot: string | null, boardRevision: LayoutInput['boardRevision']): string {
  return JSON.stringify([snapshot, boardRevision]);
}
