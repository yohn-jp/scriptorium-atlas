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

function openedRequest(providerRevisionValue: string): Extract<ProviderRequest, { method: "open" }> {
  return {
    method: "open",
    params: {
      workspaceId: WORKSPACE.workspaceId,
      requestedSnapshot: {
        workspaceId: WORKSPACE.workspaceId,
        sourceRevision: WORKSPACE.sourceRevision,
        providerRevision: providerRevisionValue,
        epoch: WORKSPACE.epoch,
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
  private expected?: { workspaceId: string; sourceRevision: string; epoch: number };
  private files: Array<{ path: string; revision: string; content: string }> = [];
  private unavailableFiles: Array<{ path: string; revision: string; byteLength: number; contentType: string }> = [];
  private projection?: ReturnType<typeof projectStoryGraph>;

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
          this.expected = request.params;
          this.files = [];
          this.unavailableFiles = [];
          break;
        case "append":
          this.files.push(...request.params.files);
          this.unavailableFiles.push(...request.params.unavailableFiles);
          break;
        case "finish": {
          if (!this.expected) throw new Error("Missing expected snapshot");
          const index = await buildStoryIndex({ ...this.expected, files: this.files, unavailableFiles: this.unavailableFiles });
          this.projection = projectStoryGraph(index);
          result = this.projection.snapshot;
          break;
        }
        case "listNodes": result = listStoryNodes(this.requireProjection(), request.handle, request.params); break;
        case "listEdges": result = listStoryEdges(this.requireProjection(), request.handle, request.params); break;
        case "getNodes": result = getStoryNodes(this.requireProjection(), request.params.refs); break;
        case "neighbors": result = storyNeighbors(this.requireProjection(), request.handle, request.params); break;
        case "diff": result = storyDiff(this.requireProjection(), request.handle, request.params); break;
        case "close": this.terminate(); break;
      }
      return { id: request.id, ok: true, result };
    } catch (error) {
      const candidate = error as Error & { code?: string };
      return { id: request.id, ok: false, error: { code: candidate.code ?? "PROVIDER_FAILED", message: candidate.message } };
    }
  }

  private requireProjection(): ReturnType<typeof projectStoryGraph> {
    if (!this.projection) throw new Error("Story graph is not open");
    return this.projection;
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

function page(files: WorkspaceSnapshotPage["files"], nextCursor: string | null, complete: boolean): WorkspaceSnapshotPage {
  return { workspace: WORKSPACE, files, nextCursor, complete };
}

describe("Story Graph Provider host boundary", () => {
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
