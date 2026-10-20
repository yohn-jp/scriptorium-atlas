import type { GraphDeltaPage, GraphEdgePage, NeighborPage, ProviderPage, SnapshotRef } from "@scriptorium-atlas/contracts";
import type { StorySnapshotPageContents, StorySnapshotExpectation } from "./workspace.js";
import type { StoryIndexWorkerRequest, StoryIndexWorkerResponse } from "./domain/index.worker.js";

type WorkerRequestPayload = StoryIndexWorkerRequest extends infer Request
  ? Request extends { id: number } ? Omit<Request, "id"> : never
  : never;

export interface StoryWorkerLike {
  postMessage(message: StoryIndexWorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<StoryIndexWorkerResponse>) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<StoryIndexWorkerResponse>) => void): void;
  removeEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  terminate(): void;
}

export type StoryWorkerFactory = () => StoryWorkerLike;

export class StoryWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StoryWorkerError";
    this.code = code;
  }
}

export function browserStoryWorkerFactory(): StoryWorkerLike {
  if (typeof Worker === "undefined") throw new StoryWorkerError("UNAVAILABLE", "Web Workers are not available in this browser.");
  return new Worker(new URL("./domain/index.worker.js", import.meta.url), {
    type: "module",
    name: "scriptorium-story-index",
  }) as unknown as StoryWorkerLike;
}

export class StoryIndexWorkerClient {
  private nextId = 1;
  private terminated = false;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(private readonly worker: StoryWorkerLike) {
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onWorkerError);
    worker.addEventListener("messageerror", this.onWorkerError);
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  private readonly onMessage = (event: MessageEvent<StoryIndexWorkerResponse>): void => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new StoryWorkerError(response.error.code, response.error.message));
  };

  private readonly onWorkerError = (): void => {
    this.failAll(new StoryWorkerError("PROVIDER_FAILED", "Story index worker stopped unexpectedly."), true);
  };

  private failAll(error: Error, terminate: boolean): void {
    if (this.terminated) return;
    this.terminated = true;
    if (terminate) this.worker.terminate();
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onWorkerError);
    this.worker.removeEventListener("messageerror", this.onWorkerError);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request<T>(request: WorkerRequestPayload, signal?: AbortSignal): Promise<T> {
    if (this.terminated) return Promise.reject(new StoryWorkerError("UNAVAILABLE", "Story index worker is no longer available."));
    if (signal?.aborted) return Promise.reject(new StoryWorkerError("CANCELED", "Story provider request was canceled."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal?.removeEventListener("abort", onAbort);
        this.failAll(new StoryWorkerError("CANCELED", "Story provider request was canceled."), true);
      };
      const resolveOnce = (value: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value as T);
      };
      const rejectOnce = (error: Error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      this.pending.set(id, { resolve: resolveOnce, reject: rejectOnce });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.worker.postMessage({ ...request, id } as StoryIndexWorkerRequest);
      } catch (error) {
        this.pending.delete(id);
        rejectOnce(error instanceof Error ? error : new StoryWorkerError("PROVIDER_FAILED", "Story index worker rejected a request."));
      }
    });
  }

  async begin(expectation: StorySnapshotExpectation, signal?: AbortSignal): Promise<void> {
    await this.request<null>({ method: "begin", params: expectation }, signal);
  }

  async append(contents: StorySnapshotPageContents, signal?: AbortSignal): Promise<void> {
    await this.request<null>({ method: "append", params: contents }, signal);
  }

  finish(signal?: AbortSignal): Promise<SnapshotRef> {
    return this.request<SnapshotRef>({ method: "finish" }, signal);
  }

  listNodes(handle: string, params: Omit<Extract<StoryIndexWorkerRequest, { method: "listNodes" }>['params'], never>, signal?: AbortSignal): Promise<ProviderPage> {
    return this.request<ProviderPage>({ method: "listNodes", handle, params }, signal);
  }

  listEdges(handle: string, params: Omit<Extract<StoryIndexWorkerRequest, { method: "listEdges" }>['params'], never>, signal?: AbortSignal): Promise<GraphEdgePage> {
    return this.request<GraphEdgePage>({ method: "listEdges", handle, params }, signal);
  }

  getNodes(params: Extract<StoryIndexWorkerRequest, { method: "getNodes" }>['params'], signal?: AbortSignal): Promise<ProviderPage> {
    return this.request<ProviderPage>({ method: "getNodes", params }, signal);
  }

  neighbors(handle: string, params: Extract<StoryIndexWorkerRequest, { method: "neighbors" }>['params'], signal?: AbortSignal): Promise<NeighborPage> {
    return this.request<NeighborPage>({ method: "neighbors", handle, params }, signal);
  }

  diff(handle: string, params: Extract<StoryIndexWorkerRequest, { method: "diff" }>['params'], signal?: AbortSignal): Promise<GraphDeltaPage> {
    return this.request<GraphDeltaPage>({ method: "diff", handle, params }, signal);
  }

  close(): void {
    this.failAll(new StoryWorkerError("CANCELED", "Story provider lease was closed."), true);
  }
}
