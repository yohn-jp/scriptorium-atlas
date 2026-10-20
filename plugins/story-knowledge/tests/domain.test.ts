import { describe, expect, it } from "vitest";
import { buildStoryIndex } from "../src/domain/index.js";
import { planCreateStoryEntity, planDeleteStoryEntity, planUpdateStoryEntity } from "../src/domain/operations.js";
import { editSourceFields, parseStorySourceFile } from "../src/domain/source.js";
import type { StorySnapshotInput } from "../src/domain/types.js";

const WORKSPACE_ID = "workspace-story-test";
const REVISION = "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function file(path: string, content: string, revision = `rev-${path.replaceAll("/", "-")}`) {
  return { path, content, revision };
}

function yamlEntity(id: string, type: string, extra = ""): string {
  return `id: ${id}\ntype: ${type}\nname: ${id}\n${extra}`;
}

function snapshot(files: ReturnType<typeof file>[]): StorySnapshotInput {
  return { workspaceId: WORKSPACE_ID, sourceRevision: REVISION, epoch: 7, files };
}

function hierarchyFiles() {
  return [
    file("plot/volumes/vol-1/volume.yaml", yamlEntity("vol-1", "volume", "order: 0\n")),
    file("plot/volumes/vol-1/chapters/ch-1/chapter.yaml", yamlEntity("ch-1", "chapter", "volume: vol-1\norder: 0\n")),
    file("plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml", yamlEntity("scene-1", "scene", [
      "volume: vol-1",
      "chapter: ch-1",
      "manuscript: manuscript/scene-1.md",
      "location: loc-1",
      "pov: char-1",
      "appears:",
      "  - char-1",
      "threads:",
      "  plants:",
      "    - thread-1",
      "order: 1",
      "",
    ].join("\n"))),
    file("bible/characters/char-1/profile.yaml", yamlEntity("char-1", "character", "aliases: [Alice]\ntags: [main]\n")),
    file("bible/locations/loc-1.yaml", yamlEntity("loc-1", "location")),
    file("plot/threads/thread-1.yaml", yamlEntity("thread-1", "thread", "planted: [scene-1]\npayoff: scene-1\n")),
    file("manuscript/scene-1.md", "---\nid: manuscript-scene-1\ntype: manuscript\ntitle: Scene 1\n---\n\n本文の末尾に空白を残す。  \n"),
  ];
}

describe("Story source parsing and fidelity", () => {
  it("keeps exact bytes for no-op edits and preserves comments and unknown fields on a targeted edit", () => {
    const content = [
      "# Character metadata",
      "id: char-1",
      "type: character",
      "name: Alice # keep this inline note",
      "voice:",
      "  tone: gentle",
      "custom_unknown: { nested: true }",
      "",
    ].join("\r\n");
    const parsed = parseStorySourceFile(file("bible/characters/alice/profile.yaml", content));
    expect(parsed.source).toBeDefined();
    expect(parsed.entity?.editable).toBe(true);
    expect(editSourceFields(parsed.source!, { name: "Alice" })).toBe(content);

    const updated = editSourceFields(parsed.source!, { name: "アリス" });
    expect(updated).toContain("# Character metadata");
    expect(updated).toContain("# keep this inline note");
    expect(updated).toContain("voice:");
    expect(updated).toContain("tone: gentle");
    expect(updated).toContain("custom_unknown: { nested: true }");
    expect(updated).toMatch(/\r\n/u);
    expect(updated).not.toMatch(/(?<!\r)\n/u);
  });

  it("preserves Markdown body whitespace and line endings when frontmatter changes", () => {
    const content = "---\r\nid: manuscript-1\r\ntitle: Old\r\n---\r\n\r\n日本語の本文です。  \r\n\r\n";
    const parsed = parseStorySourceFile(file("manuscript/one.md", content));
    expect(parsed.entity?.body).toBe("\r\n日本語の本文です。  \r\n\r\n");
    const updated = editSourceFields(parsed.source!, { title: "New" });
    expect(updated.endsWith("\r\n\r\n日本語の本文です。  \r\n\r\n")).toBe(true);
    expect(updated).toContain("title: New");
    expect(updated).not.toContain("title: Old");
  });

  it("diagnoses YAML duplicate keys and unsafe paths without producing an editable entity", () => {
    const duplicate = parseStorySourceFile(file("bible/characters/a.yaml", "id: char-1\nid: char-2\ntype: character\nname: A\n"));
    expect(duplicate.entity).toBeUndefined();
    expect(duplicate.diagnostics.some((item) => item.code.includes("duplicate_key"))).toBe(true);

    const traversal = parseStorySourceFile(file("bible/characters/../secret.yaml", yamlEntity("secret", "character")));
    expect(traversal.entity).toBeUndefined();
    expect(traversal.diagnostics.some((item) => item.code === "source-path-invalid")).toBe(true);
  });

  it("reports duplicate IDs and does not use last-wins identity", async () => {
    const index = await buildStoryIndex(snapshot([
      file("bible/characters/first.yaml", yamlEntity("same-id", "character", "tags: [first]\n")),
      file("bible/characters/second.yaml", yamlEntity("same-id", "character", "tags: [second]\n")),
    ]));
    expect(index.duplicateEntityIds.get("same-id")).toHaveLength(2);
    expect(index.entitiesById.has("same-id")).toBe(false);
    expect(index.entities.filter((entity) => entity.id === "same-id").every((entity) => !entity.editable)).toBe(true);
    expect(index.diagnostics.some((item) => item.code === "duplicate-entity-id")).toBe(true);
  });
});

describe("Story index and source-safe operations", () => {
  it("keeps relation direction and full field provenance for appearance, POV, location and thread arcs", async () => {
    const index = await buildStoryIndex(snapshot(hierarchyFiles()));
    const bySourceField = (fromId: string, field: string) => index.relations.find((relation) =>
      relation.fromId === fromId && relation.provenance.some((item) => item.field === field),
    );

    expect(bySourceField("scene-1", "appears")?.toId).toBe("char-1");
    expect(bySourceField("scene-1", "pov")?.toId).toBe("char-1");
    expect(bySourceField("scene-1", "location")?.toId).toBe("loc-1");
    expect(bySourceField("thread-1", "planted")?.toId).toBe("scene-1");
    expect(bySourceField("thread-1", "payoff")?.toId).toBe("scene-1");
    expect(bySourceField("scene-1", "threads.plants")?.toId).toBe("thread-1");
    expect(bySourceField("scene-1", "manuscript")?.resolved).toBe(true);
    expect(bySourceField("scene-1", "appears")?.provenance[0]).toEqual({
      path: "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml",
      revision: "rev-plot-volumes-vol-1-chapters-ch-1-scenes-scene-1.yaml",
      field: "appears",
      pointer: ["appears", 0],
    });
    expect(index.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("protects incoming references by default and plans explicit multi-file cascade atomically", async () => {
    const files = hierarchyFiles();
    const index = await buildStoryIndex(snapshot(files));
    const denied = planDeleteStoryEntity(index, "char-1");
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("Expected incoming relation protection.");
    expect(denied.incoming.length).toBeGreaterThan(0);

    const cascaded = planDeleteStoryEntity(index, "char-1", { cascade: true });
    expect(cascaded.allowed).toBe(true);
    if (!cascaded.allowed) throw new Error(cascaded.reason);
    expect(cascaded.change.writes).toHaveLength(2);
    expect(cascaded.change.writes.find((write) => write.path.includes("scene-1.yaml"))?.content).not.toContain("char-1");
    expect(cascaded.change.writes.find((write) => write.path.includes("profile.yaml"))?.content).toBeNull();
    expect(cascaded.change.reads).toHaveLength(2);
  });

  it("protects targets referenced by an edge that cannot be published", async () => {
    const index = await buildStoryIndex(snapshot([
      file("bible/characters/a.yaml", yamlEntity("char-a", "character", [
        "relations:",
        "  - id: relation-invalid-kind",
        "    target: char-b",
        "    kind: 'bad kind'",
        "",
      ].join("\n"))),
      file("bible/characters/b.yaml", yamlEntity("char-b", "character")),
    ]));
    expect(index.relations).toHaveLength(0);
    expect(index.references).toHaveLength(1);
    expect(index.references[0]?.publishable).toBe(false);
    const deletion = planDeleteStoryEntity(index, "char-b");
    expect(deletion.allowed).toBe(false);
    if (deletion.allowed) throw new Error("Expected incoming invalid edge protection.");
    expect(deletion.code).toBe("INCOMING_REFERENCES");
  });

  it("fails closed when malformed relation data makes incoming-reference analysis incomplete", async () => {
    const index = await buildStoryIndex(snapshot([
      file("bible/characters/a.yaml", yamlEntity("char-a", "character", "relations: [not-a-relation-map]\n")),
      file("bible/characters/b.yaml", yamlEntity("char-b", "character")),
    ]));
    expect(index.referencesComplete).toBe(false);
    const deletion = planDeleteStoryEntity(index, "char-b");
    expect(deletion.allowed).toBe(false);
    if (deletion.allowed) throw new Error("Expected an incomplete reference index to refuse deletion.");
    expect(deletion.code).toBe("REFERENCE_INDEX_INCOMPLETE");
  });

  it("keeps metadata-only Story source visible as a diagnostic and blocks unsafe deletion", async () => {
    const index = await buildStoryIndex({
      ...snapshot([file("bible/characters/known.yaml", yamlEntity("char-known", "character"))]),
      unavailableFiles: [{ path: "bible/characters/large.yaml", revision: "rev-large", byteLength: 2_097_153, contentType: "text/yaml" }],
    });
    expect(index.diagnostics.some((item) => item.code === "source-content-unavailable" && item.path.endsWith("large.yaml"))).toBe(true);
    expect(index.referencesComplete).toBe(false);
    const deletion = planDeleteStoryEntity(index, "char-known");
    expect(deletion.allowed).toBe(false);
    if (deletion.allowed) throw new Error("Expected incomplete source inventory to refuse deletion.");
    expect(deletion.code).toBe("REFERENCE_INDEX_INCOMPLETE");
  });

  it("builds scene and manuscript together under a CAS proposal", async () => {
    const files = hierarchyFiles().filter((item) => !item.path.startsWith("plot/volumes/vol-1/chapters/ch-1/scenes/") && !item.path.startsWith("manuscript/"));
    const index = await buildStoryIndex(snapshot(files));
    const proposal = planCreateStoryEntity(index, { type: "scene", name: "新しい場面", chapterId: "ch-1", manuscriptBody: "本文\n\n" });
    expect(proposal.kind).toBe("source");
    expect(proposal.writes).toHaveLength(2);
    const sceneFile = proposal.writes.find((write) => write.path.includes("/scenes/"));
    const manuscript = proposal.writes.find((write) => write.path.startsWith("manuscript/"));
    expect(sceneFile?.content).toContain("chapter: ch-1");
    expect(sceneFile?.content).toContain("manuscript: manuscript/");
    expect(manuscript?.content).toContain("本文\n\n");
    expect(proposal.reads.some((read) => read.path.endsWith("chapter.yaml"))).toBe(true);
    expect(proposal.reads.some((read) => read.revision === null)).toBe(true);
  });

  it("keeps manuscript display-name edits on the title field and protects hierarchy parents", async () => {
    const index = await buildStoryIndex(snapshot(hierarchyFiles()));
    const manuscript = index.entities.find((entity) => entity.type === "manuscript");
    expect(manuscript).toBeDefined();
    const rename = planUpdateStoryEntity(index, manuscript!.id, { name: "改訂後" });
    expect(rename?.writes[0]?.content).toContain("title: 改訂後");
    expect(rename?.writes[0]?.content).not.toContain("name: 改訂後");

    const volumeDelete = planDeleteStoryEntity(index, "vol-1", { cascade: true });
    expect(volumeDelete.allowed).toBe(false);
    if (volumeDelete.allowed) throw new Error("Expected volume with chapters to remain protected.");
    expect(volumeDelete.code).toBe("HIERARCHY_CHILDREN");
    expect(volumeDelete.children?.map((entity) => entity.id)).toContain("ch-1");
  });

  it("keeps source revision and reports no-op edits without a write proposal", async () => {
    const index = await buildStoryIndex(snapshot([file("bible/characters/a.yaml", yamlEntity("char-1", "character"))]));
    const proposal = planUpdateStoryEntity(index, "char-1", { name: "char-1" });
    expect(proposal).toBeNull();
    expect(index.providerRevision).toMatch(/^story-v1:[a-f0-9]{64}$/u);
    expect(index.sourceRevision).toBe(REVISION);
  });
});
