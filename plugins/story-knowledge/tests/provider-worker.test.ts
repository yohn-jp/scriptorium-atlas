import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import type {
  PluginHostClient,
  ProviderOpenResult,
  ProviderPage,
  ProviderRequest,
  WorkspaceHandle,
  WorkspaceSnapshotPage,
} from "@scriptorium-atlas/contracts";
import { createStoryProvider } from "../src/provider.js";
import type { StoryIndexWorkerRequest, StoryIndexWorkerResponse } from "../src/domain/index.worker.js";
import type { StoryWorkerFactory, StoryWorkerLike } from "../src/worker-client.js";

class RealStoryWorkerThread implements StoryWorkerLike {
  private readonly worker = new Worker(new URL("./story-index-worker-harness.mjs", import.meta.url), {
    execArgv: ["--import=tsx"],
  });
  private readonly wrappers = new Map<Function, (...args: unknown[]) => void>();
  private termination?: Promise<number>;

  addEventListener(type: "message", listener: (event: MessageEvent<StoryIndexWorkerResponse>) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: ((event: MessageEvent<StoryIndexWorkerResponse>) => void) | ((event: Event) => void)): void {
    const wrapper = type === "message"
      ? (data: unknown) => (listener as (event: MessageEvent<StoryIndexWorkerResponse>) => void)({ data: data as StoryIndexWorkerResponse } as MessageEvent<StoryIndexWorkerResponse>)
      : (error: unknown) => (listener as (event: Event) => void)(error as Event);
    this.wrappers.set(listener, wrapper);
    this.worker.on(type, wrapper as (...args: never[]) => void);
  }

  removeEventListener(type: "message", listener: (event: MessageEvent<StoryIndexWorkerResponse>) => void): void;
  removeEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: ((event: MessageEvent<StoryIndexWorkerResponse>) => void) | ((event: Event) => void)): void {
    const wrapper = this.wrappers.get(listener);
    if (!wrapper) return;
    this.worker.off(type, wrapper as (...args: never[]) => void);
    this.wrappers.delete(listener);
  }

  postMessage(message: StoryIndexWorkerRequest): void {
    this.worker.postMessage(message);
  }

  terminate(): void {
    this.termination ??= this.worker.terminate();
  }

  async waitForTermination(): Promise<void> {
    await this.termination;
  }
}

function workspace(sourceRevision: string): WorkspaceHandle {
  return { workspaceId: "workspace-worker-recovery", sourceRevision, epoch: 4 };
}

function sourceFile(workspaceId: string, id: string) {
  return {
    workspaceId,
    path: `bible/characters/${id}.yaml`,
    revision: `revision-${id}`,
    content: `id: ${id}\ntype: character\nname: ${id}\n`,
    encoding: "utf8" as const,
    contentType: "text/yaml",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
}

function page(
  snapshot: WorkspaceHandle,
  files: WorkspaceSnapshotPage["files"],
  nextCursor: string | null,
  complete: boolean,
): WorkspaceSnapshotPage {
  return { workspace: snapshot, files, nextCursor, complete };
}

async function providerRevision(sourceRevision: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceRevision));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `story-v1:${hex}`;
}

function openRequest(snapshot: WorkspaceHandle, revision: string): Extract<ProviderRequest, { method: "open" }> {
  return {
    method: "open",
    params: {
      workspaceId: snapshot.workspaceId,
      requestedSnapshot: {
        ...snapshot,
        providerRevision: revision,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Story Provider recovery with its production Worker", () => {
  it("cleans a canceled partial open while preserving an existing lease and accepting a later open", async () => {
    const first = workspace("source-first");
    const interrupted = workspace("source-interrupted");
    const later = workspace("source-later");
    const stalledPageRequested = deferred<void>();
    let snapshotStarts = 0;
    const snapshot = async (query?: { cursor?: string }): Promise<WorkspaceSnapshotPage> => {
      if (query?.cursor === "stall-second-open") {
        stalledPageRequested.resolve();
        return new Promise<WorkspaceSnapshotPage>(() => undefined);
      }
      snapshotStarts += 1;
      if (snapshotStarts === 1) return page(first, [sourceFile(first.workspaceId, "char-first")], null, true);
      if (snapshotStarts === 2) return page(interrupted, [sourceFile(interrupted.workspaceId, "char-partial")], "stall-second-open", false);
      if (snapshotStarts === 3) return page(later, [sourceFile(later.workspaceId, "char-later")], null, true);
      throw new Error("Unexpected Story snapshot request.");
    };
    const host = { snapshot } as unknown as PluginHostClient;
    const worker = new RealStoryWorkerThread();
    const createWorker: StoryWorkerFactory = () => worker;
    const provider = createStoryProvider(host, { createWorker });

    try {
      const firstLease = await provider.dispatch(openRequest(first, await providerRevision(first.sourceRevision))) as ProviderOpenResult;
      const controller = new AbortController();
      const canceledOpen = provider.dispatch(openRequest(interrupted, await providerRevision(interrupted.sourceRevision)), controller.signal);
      await stalledPageRequested.promise;
      controller.abort();
      await expect(canceledOpen).rejects.toMatchObject({ code: "CANCELED" });

      const firstNodes = await provider.dispatch({ method: "listNodes", params: { handle: firstLease.handle, limit: 20 } }) as ProviderPage;
      expect(firstNodes.items.map((node) => node.ref.localId)).toEqual(["char-first"]);

      const laterLease = await provider.dispatch(openRequest(later, await providerRevision(later.sourceRevision))) as ProviderOpenResult;
      const laterNodes = await provider.dispatch({ method: "listNodes", params: { handle: laterLease.handle, limit: 20 } }) as ProviderPage;
      expect(laterNodes.items.map((node) => node.ref.localId)).toEqual(["char-later"]);

      await provider.dispatch({ method: "close", params: { handle: firstLease.handle } });
      await provider.dispatch({ method: "close", params: { handle: laterLease.handle } });
      await worker.waitForTermination();
    } finally {
      provider.dispose();
      await worker.waitForTermination();
    }
  }, 15_000);
});
