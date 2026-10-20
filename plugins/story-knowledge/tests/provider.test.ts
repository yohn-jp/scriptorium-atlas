import { describe, expect, it, vi } from "vitest";
import type {
  GraphDeltaPage,
  GraphEdgePage,
  NeighborPage,
  PluginHostClient,
  ProviderOpenResult,
  ProviderPage,
  ProviderRequest,
  VersionedFile,
  WorkspaceHandle,
  WorkspaceSnapshotPage,
} from "@scriptorium-atlas/contracts";
import type { StoryIndex } from "../src/domain/types.js";
import { getStoryNodes, listStoryEdges, listStoryNodes, projectStoryGraph, storyDiff, storyNeighbors } from "../src/domain/graph.js";
import { buildStoryIndex } from "../src/domain/index.js";
import { createStoryProvider } from "../src/provider.js";
import type { StoryIndexWorkerRequest, StoryIndexWorkerResponse } from "../src/domain/index.worker.js";
import type { StoryWorkerFactory, StoryWorkerLike } from "../src/worker-client.js";

const WORKSPACE: WorkspaceHandle = { workspaceId: "workspace-provider-test", sourceRevision: "source-revision-provider-test", epoch: 12 };
const STORY_CONTENT = "id: char-a\ntype: character\nname: 青木\nappears: char-missing\n";

function providerRevision(sourceRevision: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceRevision)).then((digest) =>
    `story-v1:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
}

function openedRequest(providerRevisionValue: string, workspace: WorkspaceHandle = WORKSPACE): Extract<ProviderRequest, { method: "open" }> {
  return {
    method: "open",
    params: {
      workspaceId: workspace.workspaceId,
      requestedSnapshot: {
        workspaceId: workspace.workspaceId,
        sourceRevision: workspace.sourceRevision,
        providerRevision: providerRevisionValue,
        epoch: workspace.epoch,
      },
      grants: [
        { capability: "workspace.files.metadata", paths: ["bible/", "plot/", "manuscript/"] },
        { capability: "workspace.files.read", paths: ["bible/", "plot/", "manuscript/"] },
        { capability: "graph.read" },
      ],
      deadline: Date.now() + 15_000,
    },
  };
}

class FakeStoryWorker implements StoryWorkerLike {
  readonly sent: StoryIndexWorkerRequest[] = [];
  terminated = false;
  private messageListeners = new Set<(event: MessageEvent<StoryIndexWorkerResponse>) => void>();
  private errorListeners = new Set<(event: Event) => void>();
  private staging?: { handle: string; expected: { workspaceId: string; sourceRevision: string; epoch: number }; files: Array<{ path: string; revision: string; content: string }>; unavailableFiles: Array<{ path: string; revision: string; byteLength: number; contentType: string }> };
  private snapshots = new Map<string, { index: StoryIndex; projection: ReturnType<typeof projectStoryGraph> }>();
  private leases = new Map<string, string>();
  private latestIndex?: StoryIndex;

  addEventListener(type: "message", listener: (event: MessageEvent<StoryIndexWorkerResponse>) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: ((event: MessageEvent<StoryIndexWorkerResponse>) => void) | ((event: Event) => void)): void {
    if (type === "message") this.messageListeners.add(listener as (event: MessageEvent<StoryIndexWorkerResponse>) => void);
    else this.errorListeners.add(listener as (event: Event) => void);
  }

  removeEventListener(type: "message", listener: (event: MessageEvent<StoryIndexWorkerResponse>) => void): void;
  removeEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: ((event: MessageEvent<StoryIndexWorkerResponse>) => void) | ((event: Event) => void)): void {
    if (type === "message") this.messageListeners.delete(listener as (event: MessageEvent<StoryIndexWorkerResponse>) => void);
    else this.errorListeners.delete(listener as (event: Event) => void);
  }

  postMessage(request: StoryIndexWorkerRequest): void {
    this.sent.push(request);
    void this.respond(request).then((response) => {
      if (this.terminated) return;
      for (const listener of this.messageListeners) listener({ data: response } as MessageEvent<StoryIndexWorkerResponse>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  private async respond(request: StoryIndexWorkerRequest): Promise<StoryIndexWorkerResponse> {
    try {
      let result: unknown = null;
      switch (request.method) {
        case "begin":
          this.staging = { handle: request.handle, expected: request.params, files: [], unavailableFiles: [] };
          break;
        case "append":
          if (!this.staging) throw new Error("Missing snapshot staging");
          this.staging.files.push(...request.params.files);
          this.staging.unavailableFiles.push(...request.params.unavailableFiles);
          break;
        case "finish": {
          if (!this.staging || this.staging.handle !== request.handle) throw new Error("Missing expected snapshot");
          const staging = this.staging;
          this.staging = undefined;
          const index = await buildStoryIndex({ ...staging.expected, files: staging.files, unavailableFiles: staging.unavailableFiles }, this.latestIndex);
          const projection = projectStoryGraph(index);
          const key = JSON.stringify(projection.snapshot);
          this.snapshots.set(key, { index, projection });
          this.leases.set(request.handle, key);
          this.latestIndex = index;
          result = projection.snapshot;
          break;
        }
        case "listNodes": result = listStoryNodes(this.requireProjection(request.handle), request.handle, request.params); break;
        case "listEdges": result = listStoryEdges(this.requireProjection(request.handle), request.handle, request.params); break;
        case "getNodes": result = getStoryNodes(this.requireProjection(request.handle), request.params.refs); break;
        case "neighbors": result = storyNeighbors(this.requireProjection(request.handle), request.handle, request.params); break;
        case "diff": {
          const current = this.requireProjection(request.handle);
          const previous = this.snapshots.get(JSON.stringify(request.params.previousSnapshot))?.projection;
          if (!previous) throw Object.assign(new Error("resync required"), { code: "RESYNC_REQUIRED" });
          result = storyDiff(current, previous, request.handle, request.params);
          break;
        }
        case "close": this.leases.delete(request.handle); break;
      }
      return { id: request.id, ok: true, result };
    } catch (error) {
      const candidate = error as Error & { code?: string };
      return { id: request.id, ok: false, error: { code: candidate.code ?? "PROVIDER_FAILED", message: candidate.message } };
    }
  }

  private requireProjection(handle: string): ReturnType<typeof projectStoryGraph> {
    const key = this.leases.get(handle);
    const snapshot = key ? this.snapshots.get(key) : undefined;
    if (!snapshot) throw new Error("Story graph is not open");
    return snapshot.projection;
  }
}

function createHost(pages: WorkspaceSnapshotPage[], readFile?: VersionedFile) {
  const snapshot = vi.fn(async (query?: { cursor?: string }) => query?.cursor ? pages[1]! : pages[0]!);
  const read = vi.fn(async () => {
    if (!readFile) throw new Error("Unexpected source read");
    return readFile;
  });
  const host = { snapshot, read } as unknown as PluginHostClient;
  return { host, snapshot, read };
}

function page(files: WorkspaceSnapshotPage["files"], nextCursor: string | null, complete: boolean, workspace: WorkspaceHandle = WORKSPACE): WorkspaceSnapshotPage {
  return { workspace, files, nextCursor, complete };
}

describe("Story Graph Provider host boundary", () => {
  it("returns a contract-valid empty edge page for disconnected Story characters", async () => {
    const firstFile: VersionedFile = {
      workspaceId: WORKSPACE.workspaceId,
      path: "bible/characters/a.yaml",
      revision: "revision-character-a",
      content: "id: char-a\ntype: character\nname: A\n",
      encoding: "utf8",
      contentType: "text/yaml",
      updatedAt: "2026-10-21T00:00:00.000Z",
    };
    const secondFile: VersionedFile = {
      ...firstFile,
      path: "bible/characters/b.yaml",
      revision: "revision-character-b",
      content: "id: char-b\ntype: character\nname: B\n",
    };
    const { host } = createHost([page([firstFile, secondFile], null, true)]);
    const worker = new FakeStoryWorker();
    const provider = createStoryProvider(host, { createWorker: () => worker });
    const opened = await provider.dispatch(openedRequest(await providerRevision(WORKSPACE.sourceRevision))) as ProviderOpenResult;

    const nodes = await provider.dispatch({ method: "listNodes", params: { handle: opened.handle, limit: 500 } }) as ProviderPage;
    expect(nodes.items.map((node) => node.ref.localId)).toEqual(["char-a", "char-b"]);

    const edges = await provider.dispatch({ method: "listEdges", params: { handle: opened.handle, limit: 500 } }) as GraphEdgePage;
    expect(edges).toEqual({ snapshot: opened.actualSnapshot, items: [], nextCursor: null, complete: true });

    provider.dispose();
  });

  it("does not spawn a worker before open; pages Host input and serves a pinned lease until close", async () => {
    const revision = `rev-${"a".repeat(64)}`;
    const sourceFile: VersionedFile = {
      workspaceId: WORKSPACE.workspaceId,
      path: "bible/characters/a.yaml",
      revision,
      content: STORY_CONTENT,
      encoding: "utf8",
      contentType: "text/yaml",
      updatedAt: "2026-10-21T00:00:00.000Z",
    };
    const { host, snapshot } = createHost([
      page([sourceFile], "page-2", false),
      page([], null, true),
    ]);
    const worker = new FakeStoryWorker();
    let workerCreations = 0;
    const createWorker: StoryWorkerFactory = () => { workerCreations += 1; return worker; };
    const provider = createStoryProvider(host, { createWorker });

    expect(workerCreations).toBe(0);
    const opened = await provider.dispatch(openedRequest(await providerRevision(WORKSPACE.sourceRevision))) as ProviderOpenResult;
    expect(workerCreations).toBe(1);
    expect(opened.actualSnapshot).toEqual({
      workspaceId: WORKSPACE.workspaceId,
      sourceRevision: WORKSPACE.sourceRevision,
      providerRevision: await providerRevision(WORKSPACE.sourceRevision),
      epoch: WORKSPACE.epoch,
    });
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(worker.sent.map((request) => request.method)).toEqual(["begin", "append", "append", "finish"]);

    const nodes = await provider.dispatch({ method: "listNodes", params: { handle: opened.handle, limit: 10 } }) as ProviderPage;
    expect(nodes.snapshot).toEqual(opened.actualSnapshot);
    expect(nodes.items.map((node) => node.ref.localId)).toEqual(["char-a", "char-missing"]);
    expect(nodes.items.find((node) => node.ref.localId === "char-missing")).toMatchObject({ status: "unresolved", kind: "story.unresolved" });
    const edges = await provider.dispatch({ method: "listEdges", params: { handle: opened.handle } }) as GraphEdgePage;
    expect(edges.items[0]).toMatchObject({ from: { localId: "char-a" }, to: { localId: "char-missing" }, directed: true });
    expect(await provider.dispatch({ method: "close", params: { handle: opened.handle } })).toBeNull();
    expect(worker.terminated).toBe(true);
    await expect(provider.dispatch({ method: "listNodes", params: { handle: opened.handle } })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    provider.dispose();
  });

  it("reads a metadata-only in-scope text source at its pinned revision", async () => {
    const revision = "revision-metadata-only";
    const sourceFile: VersionedFile = {
      workspaceId: WORKSPACE.workspaceId,
      path: "bible/characters/a.yaml",
      revision,
      content: STORY_CONTENT,
      encoding: "utf8",
      contentType: "text/yaml",
      updatedAt: "2026-10-21T00:00:00.000Z",
    };
    const metadata = {
      workspaceId: WORKSPACE.workspaceId,
      path: sourceFile.path,
      revision,
      contentType: sourceFile.contentType,
      updatedAt: sourceFile.updatedAt,
      byteLength: new TextEncoder().encode(STORY_CONTENT).byteLength,
      encoding: "utf8" as const,
    };
    const { host, read } = createHost([page([metadata], null, true)], sourceFile);
    const worker = new FakeStoryWorker();
    const provider = createStoryProvider(host, { createWorker: () => worker });
    const opened = await provider.dispatch(openedRequest(await providerRevision(WORKSPACE.sourceRevision))) as ProviderOpenResult;
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ path: sourceFile.path, expectedRevision: revision, maxBytes: 2 * 1024 * 1024 }));
    expect((await provider.dispatch({ method: "listNodes", params: { handle: opened.handle } }) as ProviderPage).items[0]?.label).toBe("青木");
    provider.dispose();
  });

  it("reuses one Worker across leases, pins old snapshots, and diffs from a retained prior snapshot", async () => {
    const beforeWorkspace: WorkspaceHandle = { ...WORKSPACE, sourceRevision: "source-before" };
    const afterWorkspace: WorkspaceHandle = { ...WORKSPACE, sourceRevision: "source-after" };
    const beforeA: VersionedFile = {
      workspaceId: WORKSPACE.workspaceId,
      path: "bible/characters/a.yaml",
      revision: "a-rev-1",
      content: "id: char-a\ntype: character\nname: 青木\n",
      encoding: "utf8",
      contentType: "text/yaml",
      updatedAt: "2026-10-21T00:00:00.000Z",
    };
    const beforeDeleted: VersionedFile = {
      ...beforeA,
      path: "bible/characters/deleted.yaml",
      revision: "deleted-rev-1",
      content: "id: char-deleted\ntype: character\nname: 削除対象\n",
    };
    const afterA: VersionedFile = { ...beforeA, revision: "a-rev-2", content: "id: char-a\ntype: character\nname: 青木・改\n" };
    const pages = [page([beforeA, beforeDeleted], null, true, beforeWorkspace)];
    const { host } = createHost(pages);
    const worker = new FakeStoryWorker();
    let workerCreations = 0;
    const provider = createStoryProvider(host, { createWorker: () => { workerCreations += 1; return worker; } });

    const before = await provider.dispatch(openedRequest(await providerRevision(beforeWorkspace.sourceRevision), beforeWorkspace)) as ProviderOpenResult;
    pages[0] = page([afterA], null, true, afterWorkspace);
    const after = await provider.dispatch(openedRequest(await providerRevision(afterWorkspace.sourceRevision), afterWorkspace)) as ProviderOpenResult;
    expect(workerCreations).toBe(1);
    expect(worker.sent.filter((request) => request.method === "begin")).toHaveLength(2);

    const pinned = await provider.dispatch({ method: "listNodes", params: { handle: before.handle } }) as ProviderPage;
    expect(pinned.items.find((node) => node.ref.localId === "char-a")?.label).toBe("青木");
    expect(pinned.items.map((node) => node.ref.localId)).toContain("char-deleted");
    await provider.dispatch({ method: "close", params: { handle: before.handle } });

    const delta = await provider.dispatch({ method: "diff", params: { handle: after.handle, previousSnapshot: before.actualSnapshot } }) as GraphDeltaPage;
    expect(delta.items.flatMap((item) => item.changedNodes ?? []).map((node) => node.ref.localId)).toContain("char-a");
    expect(delta.items.flatMap((item) => item.removedNodes ?? []).map((node) => node.localId)).toEqual(["char-deleted"]);
    expect(delta.snapshot).toEqual(after.actualSnapshot);
    await provider.dispatch({ method: "close", params: { handle: after.handle } });
    expect(worker.terminated).toBe(true);
    provider.dispose();
  });

  it("aborts a pending Host snapshot read promptly and terminates its lease worker", async () => {
    const pending = new Promise<WorkspaceSnapshotPage>(() => {});
    const host = { snapshot: vi.fn(() => pending) } as unknown as PluginHostClient;
    const worker = new FakeStoryWorker();
    const provider = createStoryProvider(host, { createWorker: () => worker });
    const controller = new AbortController();
    const opening = provider.dispatch(openedRequest(await providerRevision(WORKSPACE.sourceRevision)), controller.signal);
    await vi.waitFor(() => expect(host.snapshot).toHaveBeenCalled());
    controller.abort();
    await expect(opening).rejects.toMatchObject({ code: "CANCELED" });
    expect(worker.terminated).toBe(true);
    provider.dispose();
  });

  it("refuses incomplete Host pagination instead of publishing an incomplete inventory as complete", async () => {
    const { host } = createHost([page([], null, false)]);
    const worker = new FakeStoryWorker();
    const provider = createStoryProvider(host, { createWorker: () => worker });
    await expect(provider.dispatch(openedRequest(await providerRevision(WORKSPACE.sourceRevision)))).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
    expect(worker.terminated).toBe(true);
    provider.dispose();
  });
});
