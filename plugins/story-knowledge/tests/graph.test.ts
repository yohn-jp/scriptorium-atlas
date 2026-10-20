import { describe, expect, it } from "vitest";
import { buildStoryIndex } from "../src/domain/index.js";
import {
  getStoryNodes,
  listStoryEdges,
  listStoryNodes,
  projectStoryGraph,
  storyDiff,
  storyNeighbors,
} from "../src/domain/graph.js";
import { STORY_PROVIDER_ID, type StorySnapshotInput } from "../src/domain/types.js";

const SOURCE_REVISION = "workspace-revision-graph-test";

function source(path: string, id: string, name: string, extra = "") {
  return {
    path,
    revision: `revision-${id}`,
    content: `id: ${id}\ntype: character\nname: ${name}\n${extra}`,
  };
}

async function graph(files: StorySnapshotInput["files"]) {
  return projectStoryGraph(await buildStoryIndex({
    workspaceId: "workspace-graph-test",
    sourceRevision: SOURCE_REVISION,
    epoch: 3,
    files,
  }));
}

describe("Story graph projection and provider queries", () => {
  it("publishes namespaced nodes, directed edges, source references, and full edge provenance", async () => {
    const projection = await graph([
      source("bible/characters/a.yaml", "char-a", "青木", [
        "relations:",
        "  - id: edge-a-b",
        "    target: char-b",
        "    kind: mentor",
        "    note: 物語の記録",
        "",
      ].join("\n")),
      source("bible/characters/b.yaml", "char-b", "花子"),
    ]);
    const alice = projection.nodesById.get("char-a");
    const edge = projection.edgesById.get("edge-a-b");
    expect(alice).toMatchObject({
      ref: { providerId: STORY_PROVIDER_ID, localId: "char-a" },
      kind: "story.character",
      label: "青木",
      source: { path: "bible/characters/a.yaml", revision: "revision-char-a" },
      status: "available",
    });
    expect(edge).toMatchObject({
      ref: { providerId: STORY_PROVIDER_ID, localId: "edge-a-b" },
      from: { providerId: STORY_PROVIDER_ID, localId: "char-a" },
      to: { providerId: STORY_PROVIDER_ID, localId: "char-b" },
      kind: "mentor",
      directed: true,
      source: { path: "bible/characters/a.yaml", revision: "revision-char-a" },
      provenance: [{ path: "bible/characters/a.yaml", revision: "revision-char-a", field: "relations" }],
    });
    expect(JSON.stringify(edge)).not.toContain("物語の記録");
  });

  it("keeps unresolved targets visible and paginates/filter results with handle-bound cursors", async () => {
    const projection = await graph([
      source("bible/characters/a.yaml", "char-a", "青木", "appears: char-missing\n"),
      source("bible/characters/b.yaml", "char-b", "花子"),
    ]);
    expect(projection.nodesById.get("char-missing")).toMatchObject({ kind: "story.unresolved", status: "unresolved" });
    const first = listStoryNodes(projection, "handle-one", { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = listStoryNodes(projection, "handle-one", { limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.ref.localId).not.toBe(first.items[0]?.ref.localId);
    expect(listStoryNodes(projection, "handle-one", { filter: { query: "花子" } }).items.map((item) => item.ref.localId)).toEqual(["char-b"]);
    expect(() => listStoryNodes(projection, "handle-two", { limit: 1, cursor: first.nextCursor! })).toThrow(/cursor/u);
    expect(listStoryEdges(projection, "handle-one", { filter: { kinds: ["appears"] } }).items).toHaveLength(1);
  });

  it("supports directed inbound/outbound bounded neighbors, getNodes identity checks, and explicit resync", async () => {
    const projection = await graph([
      source("bible/characters/a.yaml", "char-a", "青木", "relations:\n  - id: edge-a-b\n    target: char-b\n    kind: mentor\n"),
      source("bible/characters/b.yaml", "char-b", "花子"),
      source("bible/characters/c.yaml", "char-c", "真琴", "relations:\n  - id: edge-c-b\n    target: char-b\n    kind: friend\n"),
    ]);
    const out = storyNeighbors(projection, "handle", {
      from: { providerId: STORY_PROVIDER_ID, localId: "char-a" }, direction: "out", depth: 1, limit: 20,
    });
    expect(out.items.map((item) => item.node.ref.localId)).toEqual(["char-b"]);
    expect(out.items[0]?.edges.map((item) => item.ref.localId)).toEqual(["edge-a-b"]);
    const incoming = storyNeighbors(projection, "handle", {
      from: { providerId: STORY_PROVIDER_ID, localId: "char-b" }, direction: "in", depth: 1, limit: 20,
    });
    expect(incoming.items.map((item) => item.node.ref.localId)).toEqual(["char-a", "char-c"]);
    expect(getStoryNodes(projection, [{ providerId: STORY_PROVIDER_ID, localId: "char-a" }]).items).toHaveLength(1);
    expect(() => getStoryNodes(projection, [{ providerId: "other.provider", localId: "char-a" }])).toThrow(/Story provider/u);
    expect(storyDiff(projection, "handle", { previousSnapshot: projection.snapshot }).items).toEqual([]);
    expect(() => storyDiff(projection, "handle", { previousSnapshot: { ...projection.snapshot, sourceRevision: "older" } })).toThrow(/resync/u);
  });

  it("marks the listed graph incomplete when malformed inputs make the source inventory partial", async () => {
    const projection = await graph([
      source("bible/characters/a.yaml", "char-a", "青木"),
      { path: "bible/characters/b.yaml", revision: "broken", content: "id: char-b\nid: duplicate\ntype: character\n" },
    ]);
    expect(projection.complete).toBe(false);
    expect(listStoryNodes(projection, "handle", {}).complete).toBe(false);
  });
});
