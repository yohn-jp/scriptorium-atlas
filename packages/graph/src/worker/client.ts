import type {
  GraphDelta,
  GraphDeltaPage,
  GraphEdge,
  GraphEdgePage,
  GraphNode,
  NodeRef,
  ProviderPage,
  SnapshotRef,
} from '@scriptorium-atlas/contracts';
import {
  GraphError,
  GraphSnapshotBuilder,
  combineGraphDeltaPages,
  nodeKey,
  sameSnapshot,
  snapshotKey,
  type GraphSearchOptions,
  type GraphSearchResult,
  type GraphTraversalResult,
  type GraphErrorCode,
  type ShortestPathOptions,
  type ShortestPathResult,
  type WeakComponent,
} from '../index.js';
import type { GraphWorkerRequest, GraphWorkerResponse, WorkerPort } from './protocol.js';

type WorkerMessageWithoutId<T = GraphWorkerRequest> = T extends { readonly id: number } ? Omit<T, 'id'> : never;
type GraphWorkerMessage = WorkerMessageWithoutId;

export class GraphWorkerClientError extends Error {
  constructor(readonly code: 'CLOSED' | 'CANCELLED' | 'STALE_RESULT' | 'WORKER_FAILED' | 'SNAPSHOT_NOT_READY' | 'QUEUE_FULL' | 'TIMEOUT', message: string) {
    super(message);
    this.name = 'GraphWorkerClientError';
  }
}

export interface GraphWorkerClientOptions {
  readonly workerFactory?: () => WorkerPort;
  /** Maximum requests posted to the Worker at once. The hard maximum is four. */
  readonly maxInFlight?: number;
  /** Maximum requests waiting in the client queue. The hard maximum is 64. */
  readonly maxQueued?: number;
  /** Deadline for each Worker request, including time spent in its local request queue. */
  readonly timeoutMs?: number;
}

export interface GraphWorkerClient {
  replaceSnapshot(snapshot: SnapshotRef, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Promise<void>;
  replaceSnapshotFromPages(snapshot: SnapshotRef, nodePages: readonly ProviderPage[], edgePages: readonly GraphEdgePage[]): Promise<void>;
  applyDelta(delta: GraphDelta, signal?: AbortSignal): Promise<void>;
  applyDeltaPages(pages: readonly GraphDeltaPage[], signal?: AbortSignal): Promise<void>;
  search(options: GraphSearchOptions, signal?: AbortSignal): Promise<GraphSearchResult>;
  neighbors(options: { readonly from: NodeRef; readonly direction: 'in' | 'out' | 'both'; readonly depth: number; readonly limit?: number }, signal?: AbortSignal): Promise<GraphTraversalResult>;
  shortestPath(options: ShortestPathOptions, signal?: AbortSignal): Promise<ShortestPathResult>;
  weakComponents(signal?: AbortSignal): Promise<readonly WeakComponent[]>;
  cancelAll(): void;
  close(): void;
}

interface PendingRequest<T> {
  readonly id: number;
  readonly message: GraphWorkerMessage;
  readonly expectedSnapshotKey: string;
  readonly requireCurrentSnapshot: boolean;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abortSignal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface SnapshotCache {
  readonly snapshot: SnapshotRef;
  readonly nodes: Map<string, GraphNode>;
  readonly edges: Map<string, GraphEdge>;
  readonly key: string;
}

interface LoadingSnapshot {
  readonly key: string;
  readonly promise: Promise<void>;
}

/** Lazily creates one dedicated Worker and releases it on close or cancellation. */
export function createGraphWorkerClient(options: GraphWorkerClientOptions = {}): GraphWorkerClient {
  const createWorker = options.workerFactory ?? defaultWorkerFactory;
  const maxInFlight = boundedInteger(options.maxInFlight ?? 4, 1, 4, 'maxInFlight');
  const maxQueued = boundedInteger(options.maxQueued ?? 64, 0, 64, 'maxQueued');
  const timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 1, 300_000, 'timeoutMs');
  let worker: WorkerPort | undefined;
  let loadedSnapshotKey: string | undefined;
  let loadingSnapshot: LoadingSnapshot | undefined;
  let desiredSnapshot: SnapshotCache | undefined;
  let nextRequestId = 1;
  let closed = false;
  let transitionTail: Promise<void> = Promise.resolve();
  let transitionCount = 0;
  let queryCount = 0;
  const pending = new Map<number, PendingRequest<unknown>>();
  const requestQueue: number[] = [];
  const activeRequests = new Set<number>();

  const onMessage = (event: MessageEvent<GraphWorkerResponse>): void => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return; // duplicate or late response after cancellation
    detachRequest(request);
    if (request.requireCurrentSnapshot && request.expectedSnapshotKey !== desiredSnapshot?.key) {
      request.reject(new GraphWorkerClientError('STALE_RESULT', 'Worker reply belongs to a stale graph snapshot'));
      pumpRequests();
      return;
    }
    if (!message.ok) {
      const remote = message.error;
      const code = graphErrorCode(remote?.code);
      request.reject(code
        ? new GraphError(code, remote?.message ?? 'Graph Worker request failed')
        : new GraphWorkerClientError('WORKER_FAILED', remote?.message ?? 'Graph Worker request failed'));
      pumpRequests();
      return;
    }
    if (message.snapshotKey !== request.expectedSnapshotKey) {
      request.reject(new GraphWorkerClientError('STALE_RESULT', 'Worker reply has a mismatched snapshot identity'));
      pumpRequests();
      return;
    }
    request.resolve(message.value);
    pumpRequests();
  };

  const onFailure = (): void => {
    const active = worker;
    worker = undefined;
    loadedSnapshotKey = undefined;
    loadingSnapshot = undefined;
    active?.removeEventListener('message', onMessage);
    active?.removeEventListener('error', onFailure);
    active?.removeEventListener('messageerror', onFailure);
    active?.terminate();
    rejectAll(new GraphWorkerClientError('WORKER_FAILED', 'Graph Worker failed'));
  };

  function rejectAll(error: Error): void {
    for (const request of pending.values()) {
      clearRequest(request);
      request.reject(error);
    }
    pending.clear();
    requestQueue.length = 0;
    activeRequests.clear();
  }

  function ensureWorker(): WorkerPort {
    if (closed) throw new GraphWorkerClientError('CLOSED', 'Graph Worker client is closed');
    if (!worker) {
      worker = createWorker();
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onFailure);
      worker.addEventListener('messageerror', onFailure);
      loadedSnapshotKey = undefined;
    }
    return worker;
  }

  function clearRequest(request: PendingRequest<unknown>): void {
    clearTimeout(request.timer);
    if (request.abortSignal && request.onAbort) request.abortSignal.removeEventListener('abort', request.onAbort);
  }

  function detachRequest(request: PendingRequest<unknown>): void {
    pending.delete(request.id);
    activeRequests.delete(request.id);
    const queuedAt = requestQueue.indexOf(request.id);
    if (queuedAt >= 0) requestQueue.splice(queuedAt, 1);
    clearRequest(request);
  }

  function pumpRequests(): void {
    while (!closed && activeRequests.size < maxInFlight && requestQueue.length > 0) {
      const id = requestQueue.shift()!;
      const request = pending.get(id);
      if (!request) continue;
      activeRequests.add(id);
      try {
        ensureWorker().postMessage({ ...request.message, id } as GraphWorkerRequest);
      } catch (error) {
        detachRequest(request);
        request.reject(error instanceof Error ? error : new GraphWorkerClientError('WORKER_FAILED', String(error)));
      }
    }
  }

  function terminateWorkerForTimeout(timedOutRequest: PendingRequest<unknown>): void {
    const active = worker;
    worker = undefined;
    loadedSnapshotKey = undefined;
    loadingSnapshot = undefined;
    active?.removeEventListener('message', onMessage);
    active?.removeEventListener('error', onFailure);
    active?.removeEventListener('messageerror', onFailure);
    active?.terminate();
    detachRequest(timedOutRequest);
    timedOutRequest.reject(new GraphWorkerClientError('TIMEOUT', `Graph Worker request exceeded ${timeoutMs}ms`));
    rejectAll(new GraphWorkerClientError('WORKER_FAILED', 'Graph Worker was terminated after a request deadline expired'));
  }

  function request<T>(
    message: GraphWorkerMessage,
    expectedKey: string,
    signal?: AbortSignal,
    requireCurrentSnapshot = true,
  ): Promise<T> {
    if (closed) return Promise.reject(new GraphWorkerClientError('CLOSED', 'Graph Worker client is closed'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (activeRequests.size >= maxInFlight && requestQueue.length >= maxQueued) {
      return Promise.reject(new GraphWorkerClientError('QUEUE_FULL', `Graph Worker queue is full (${maxInFlight} active, ${maxQueued} queued)`));
    }
    const id = nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      let abortListener: (() => void) | undefined;
      if (signal) {
        abortListener = () => {
          const activeRequest = pending.get(id);
          if (!activeRequest) return;
          const wasActive = activeRequests.has(id);
          detachRequest(activeRequest);
          reject(abortError());
          if (wasActive) terminateWorkerForCancellation();
          else pumpRequests();
        };
      }
      const timer = setTimeout(() => {
        const timedOut = pending.get(id);
        if (!timedOut) return;
        if (activeRequests.has(id)) terminateWorkerForTimeout(timedOut);
        else {
          detachRequest(timedOut);
          timedOut.reject(new GraphWorkerClientError('TIMEOUT', `Graph Worker request exceeded ${timeoutMs}ms while queued`));
          pumpRequests();
        }
      }, timeoutMs);
      pending.set(id, {
        id,
        message,
        expectedSnapshotKey: expectedKey,
        requireCurrentSnapshot,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        ...(signal ? { abortSignal: signal } : {}),
        ...(abortListener ? { onAbort: abortListener } : {}),
      });
      if (signal && abortListener) signal.addEventListener('abort', abortListener, { once: true });
      requestQueue.push(id);
      pumpRequests();
    });
  }

  function terminateWorkerForCancellation(): void {
    const active = worker;
    worker = undefined;
    loadedSnapshotKey = undefined;
    loadingSnapshot = undefined;
    active?.removeEventListener('message', onMessage);
    active?.removeEventListener('error', onFailure);
    active?.removeEventListener('messageerror', onFailure);
    active?.terminate();
    rejectAll(new GraphWorkerClientError('CANCELLED', 'Graph Worker was terminated to cancel an operation'));
  }

  function enqueueTransition<T>(operation: () => Promise<T>): Promise<T> {
    if (transitionCount >= 64) return Promise.reject(new GraphWorkerClientError('QUEUE_FULL', 'Graph snapshot transition queue is full (64 pending)'));
    transitionCount += 1;
    const result = transitionTail.then(operation);
    transitionTail = result.then(() => undefined, () => undefined);
    return result.finally(() => { transitionCount -= 1; });
  }

  function ensureLoaded(cache: SnapshotCache, signal?: AbortSignal): Promise<void> {
    if (loadedSnapshotKey === cache.key) return Promise.resolve();
    if (loadingSnapshot?.key === cache.key) return loadingSnapshot.promise;
    const promise = request<void>({
      type: 'replace',
      snapshot: cache.snapshot,
      nodes: [...cache.nodes.values()],
      edges: [...cache.edges.values()],
    }, cache.key, signal).then(() => {
      if (desiredSnapshot?.key === cache.key) loadedSnapshotKey = cache.key;
    }).finally(() => {
      if (loadingSnapshot?.promise === promise) loadingSnapshot = undefined;
    });
    loadingSnapshot = { key: cache.key, promise };
    return promise;
  }

  async function currentSnapshot(signal?: AbortSignal): Promise<SnapshotCache> {
    await transitionTail;
    if (!desiredSnapshot) throw new GraphWorkerClientError('SNAPSHOT_NOT_READY', 'Load a complete graph snapshot before querying');
    const cache = desiredSnapshot;
    await ensureLoaded(cache, signal);
    if (desiredSnapshot !== cache) throw new GraphWorkerClientError('STALE_RESULT', 'Graph snapshot changed while preparing the Worker');
    return cache;
  }

  function query<T>(makeMessage: (key: string) => GraphWorkerMessage, signal?: AbortSignal): Promise<T> {
    if (queryCount >= maxInFlight + maxQueued) {
      return Promise.reject(new GraphWorkerClientError('QUEUE_FULL', `Graph Worker query queue is full (${maxInFlight + maxQueued} pending)`));
    }
    queryCount += 1;
    return (async () => {
      const snapshot = await currentSnapshot(signal);
      return request<T>(makeMessage(snapshot.key), snapshot.key, signal);
    })().finally(() => { queryCount -= 1; });
  }

  function replaceSnapshot(snapshot: SnapshotRef, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Promise<void> {
    if (transitionCount >= 64) return Promise.reject(new GraphWorkerClientError('QUEUE_FULL', 'Graph snapshot transition queue is full (64 pending)'));
    const cache = makeSnapshotCache(snapshot, nodes, edges);
    const previous = desiredSnapshot;
    desiredSnapshot = cache;
    loadedSnapshotKey = undefined;
    if (previous) rejectAll(new GraphWorkerClientError('STALE_RESULT', 'Graph snapshot was replaced'));
    return enqueueTransition(async () => {
      if (desiredSnapshot !== cache) throw new GraphWorkerClientError('STALE_RESULT', 'A newer graph snapshot replaced this request');
      await ensureLoaded(cache);
    });
  }

  function replaceSnapshotFromPages(
    snapshot: SnapshotRef,
    nodePages: readonly ProviderPage[],
    edgePages: readonly GraphEdgePage[],
  ): Promise<void> {
    if (transitionCount >= 64) return Promise.reject(new GraphWorkerClientError('QUEUE_FULL', 'Graph snapshot transition queue is full (64 pending)'));
    const builder = new GraphSnapshotBuilder(snapshot);
    for (const page of nodePages) builder.addNodesPage(page);
    for (const page of edgePages) builder.addEdgesPage(page);
    const input = builder.buildInput();
    return replaceSnapshot(input.snapshot, input.nodes, input.edges);
  }

  function applyDelta(delta: GraphDelta, signal?: AbortSignal): Promise<void> {
    if (transitionCount >= 64) return Promise.reject(new GraphWorkerClientError('QUEUE_FULL', 'Graph snapshot transition queue is full (64 pending)'));
    const stableDelta = structuredClone(delta);
    return enqueueTransition(async () => {
      const current = desiredSnapshot;
      if (!current || !sameSnapshot(current.snapshot, stableDelta.previousSnapshot)) {
        throw new GraphError('RESYNC_REQUIRED', 'Delta base does not match the active worker snapshot');
      }
      await ensureLoaded(current, signal);
      const nextKey = snapshotKey(stableDelta.snapshot);
      await request<void>({ type: 'delta', delta: stableDelta }, nextKey, signal, false);
      if (desiredSnapshot !== current) throw new GraphWorkerClientError('STALE_RESULT', 'Graph snapshot changed during delta application');
      applyRawDelta(current, stableDelta);
      desiredSnapshot = { ...current, snapshot: Object.freeze({ ...stableDelta.snapshot }), key: nextKey };
      loadedSnapshotKey = nextKey;
    });
  }

  function applyDeltaPages(pages: readonly GraphDeltaPage[], signal?: AbortSignal): Promise<void> {
    if (transitionCount >= 64) return Promise.reject(new GraphWorkerClientError('QUEUE_FULL', 'Graph snapshot transition queue is full (64 pending)'));
    return enqueueTransition(async () => {
      const current = desiredSnapshot;
      if (!current) throw new GraphWorkerClientError('SNAPSHOT_NOT_READY', 'Load a complete graph snapshot before applying a delta');
      const delta = structuredClone(combineGraphDeltaPages(current.snapshot, pages));
      await ensureLoaded(current, signal);
      const nextKey = snapshotKey(delta.snapshot);
      await request<void>({ type: 'delta', delta }, nextKey, signal, false);
      if (desiredSnapshot !== current) throw new GraphWorkerClientError('STALE_RESULT', 'Graph snapshot changed during delta application');
      applyRawDelta(current, delta);
      desiredSnapshot = { ...current, snapshot: Object.freeze({ ...delta.snapshot }), key: nextKey };
      loadedSnapshotKey = nextKey;
    });
  }

  function cancelAll(): void {
    if (!worker) {
      rejectAll(new GraphWorkerClientError('CANCELLED', 'Graph Worker operations were cancelled'));
      return;
    }
    terminateWorkerForCancellation();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    const active = worker;
    worker = undefined;
    loadedSnapshotKey = undefined;
    loadingSnapshot = undefined;
    desiredSnapshot = undefined;
    active?.removeEventListener('message', onMessage);
    active?.removeEventListener('error', onFailure);
    active?.removeEventListener('messageerror', onFailure);
    active?.terminate();
    rejectAll(new GraphWorkerClientError('CLOSED', 'Graph Worker client is closed'));
  }

  return {
    replaceSnapshot,
    replaceSnapshotFromPages,
    applyDelta,
    applyDeltaPages,
    search: (searchOptions, signal) => query((key) => ({ type: 'search', snapshotKey: key, options: searchOptions }), signal),
    neighbors: (neighborOptions, signal) => query((key) => ({ type: 'neighbors', snapshotKey: key, ...neighborOptions }), signal),
    shortestPath: (pathOptions, signal) => query((key) => ({ type: 'shortestPath', snapshotKey: key, options: pathOptions }), signal),
    weakComponents: (signal) => query((key) => ({ type: 'weakComponents', snapshotKey: key }), signal),
    cancelAll,
    close,
  };
}

function makeSnapshotCache(snapshot: SnapshotRef, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): SnapshotCache {
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  for (const node of nodes) {
    const key = nodeKey(node.ref);
    if (nodeMap.has(key)) throw new GraphError('DUPLICATE_NODE', `Duplicate node reference ${key}`);
    nodeMap.set(key, structuredClone(node));
  }
  for (const edge of edges) {
    const key = nodeKey(edge.ref);
    if (edgeMap.has(key)) throw new GraphError('DUPLICATE_EDGE', `Duplicate edge reference ${key}`);
    edgeMap.set(key, structuredClone(edge));
  }
  const stableSnapshot = Object.freeze({ ...snapshot });
  return { snapshot: stableSnapshot, nodes: nodeMap, edges: edgeMap, key: snapshotKey(stableSnapshot) };
}

function applyRawDelta(cache: SnapshotCache, delta: GraphDelta): void {
  for (const ref of delta.removedNodes ?? []) cache.nodes.delete(nodeKey(ref));
  for (const node of delta.changedNodes ?? []) cache.nodes.set(nodeKey(node.ref), structuredClone(node));
  for (const ref of delta.removedEdges ?? []) cache.edges.delete(nodeKey(ref));
  for (const edge of delta.changedEdges ?? []) cache.edges.set(nodeKey(edge.ref), structuredClone(edge));
}

function abortError(): Error {
  const error = new Error('Graph Worker operation was aborted');
  error.name = 'AbortError';
  return error;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function graphErrorCode(code: string | undefined): GraphErrorCode | undefined {
  const known: readonly GraphErrorCode[] = [
    'DUPLICATE_NODE',
    'DUPLICATE_EDGE',
    'DUPLICATE_DELTA_ITEM',
    'SNAPSHOT_MISMATCH',
    'RESYNC_REQUIRED',
    'INCOMPLETE_SNAPSHOT',
    'CURSOR_LOOP',
    'INVALID_DIRECTION',
    'INVALID_DEPTH',
    'INVALID_LIMIT',
    'NODE_NOT_FOUND',
  ];
  return known.includes(code as GraphErrorCode) ? code as GraphErrorCode : undefined;
}

function defaultWorkerFactory(): WorkerPort {
  return new Worker(new URL('./entry.js', import.meta.url), { type: 'module' }) as unknown as WorkerPort;
}
