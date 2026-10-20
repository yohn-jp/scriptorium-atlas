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
  constructor(readonly code: 'CLOSED' | 'CANCELLED' | 'STALE_RESULT' | 'WORKER_FAILED' | 'SNAPSHOT_NOT_READY', message: string) {
    super(message);
    this.name = 'GraphWorkerClientError';
  }
}

export interface GraphWorkerClientOptions {
  readonly workerFactory?: () => WorkerPort;
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
  readonly expectedSnapshotKey: string;
  readonly requireCurrentSnapshot: boolean;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
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
  let worker: WorkerPort | undefined;
  let loadedSnapshotKey: string | undefined;
  let loadingSnapshot: LoadingSnapshot | undefined;
  let desiredSnapshot: SnapshotCache | undefined;
  let nextRequestId = 1;
  let closed = false;
  let transitionTail: Promise<void> = Promise.resolve();
  const pending = new Map<number, PendingRequest<unknown>>();

  const onMessage = (event: MessageEvent<GraphWorkerResponse>): void => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return; // duplicate or late response after cancellation
    pending.delete(message.id);
    if (request.abortSignal && request.onAbort) request.abortSignal.removeEventListener('abort', request.onAbort);
    if (request.requireCurrentSnapshot && request.expectedSnapshotKey !== desiredSnapshot?.key) {
      request.reject(new GraphWorkerClientError('STALE_RESULT', 'Worker reply belongs to a stale graph snapshot'));
      return;
    }
    if (!message.ok) {
      const remote = message.error;
      const code = graphErrorCode(remote?.code);
      request.reject(code
        ? new GraphError(code, remote?.message ?? 'Graph Worker request failed')
        : new GraphWorkerClientError('WORKER_FAILED', remote?.message ?? 'Graph Worker request failed'));
      return;
    }
    if (message.snapshotKey !== request.expectedSnapshotKey) {
      request.reject(new GraphWorkerClientError('STALE_RESULT', 'Worker reply has a mismatched snapshot identity'));
      return;
    }
    request.resolve(message.value);
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
      if (request.abortSignal && request.onAbort) request.abortSignal.removeEventListener('abort', request.onAbort);
      request.reject(error);
    }
    pending.clear();
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

  function request<T>(
    message: GraphWorkerMessage,
    expectedKey: string,
    signal?: AbortSignal,
    requireCurrentSnapshot = true,
  ): Promise<T> {
    if (closed) return Promise.reject(new GraphWorkerClientError('CLOSED', 'Graph Worker client is closed'));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      let abortListener: (() => void) | undefined;
      if (signal) {
        abortListener = () => {
          const activeRequest = pending.get(id);
          if (!activeRequest) return;
          pending.delete(id);
          signal.removeEventListener('abort', abortListener!);
          reject(abortError());
          terminateWorkerForCancellation();
        };
      }
      pending.set(id, {
        expectedSnapshotKey: expectedKey,
        requireCurrentSnapshot,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(signal ? { abortSignal: signal } : {}),
        ...(abortListener ? { onAbort: abortListener } : {}),
      });
      if (signal && abortListener) signal.addEventListener('abort', abortListener, { once: true });
      try {
        ensureWorker().postMessage({ ...message, id } as GraphWorkerRequest);
      } catch (error) {
        pending.delete(id);
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
        reject(error instanceof Error ? error : new GraphWorkerClientError('WORKER_FAILED', String(error)));
      }
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
    const result = transitionTail.then(operation);
    transitionTail = result.then(() => undefined, () => undefined);
    return result;
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

  async function query<T>(makeMessage: (key: string) => GraphWorkerMessage, signal?: AbortSignal): Promise<T> {
    const snapshot = await currentSnapshot(signal);
    return request<T>(makeMessage(snapshot.key), snapshot.key, signal);
  }

  function replaceSnapshot(snapshot: SnapshotRef, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Promise<void> {
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
    const builder = new GraphSnapshotBuilder(snapshot);
    for (const page of nodePages) builder.addNodesPage(page);
    for (const page of edgePages) builder.addEdgesPage(page);
    const input = builder.buildInput();
    return replaceSnapshot(input.snapshot, input.nodes, input.edges);
  }

  function applyDelta(delta: GraphDelta, signal?: AbortSignal): Promise<void> {
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
