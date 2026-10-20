import type {
  GraphEdge,
  GraphEdgePage,
  GraphNode,
  GraphDeltaPage,
  Neighbor,
  NeighborPage,
  NodeRef,
  ProviderPage,
  ProviderRequest,
  SnapshotRef,
} from "@scriptorium-atlas/contracts";
import type { StoryEntity, StoryIndex, StoryRelation } from "./types.js";
import { STORY_PROVIDER_ID } from "./types.js";

type ListQuery = Omit<Extract<ProviderRequest, { method: "listNodes" }>['params'], "handle">;
type NeighborQuery = Omit<Extract<ProviderRequest, { method: "neighbors" }>['params'], "handle">;
type DiffQuery = Omit<Extract<ProviderRequest, { method: "diff" }>['params'], "handle">;

export interface StoryGraphProjection {
  snapshot: SnapshotRef;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  nodesById: ReadonlyMap<string, GraphNode>;
  edgesById: ReadonlyMap<string, GraphEdge>;
  complete: boolean;
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja");
}

function truncate(value: string, maxCodePoints: number): string {
  return Array.from(value).slice(0, maxCodePoints).join("");
}

function ref(localId: string): NodeRef {
  return { providerId: STORY_PROVIDER_ID, localId };
}

function boundedStrings(values: readonly string[]): string[] | undefined {
  const result = [...new Set(values.map((value) => truncate(value, 256)).filter(Boolean))].slice(0, 64);
  return result.length > 0 ? result : undefined;
}

const GRAPH_META_FIELDS = [
  "status", "order", "volume", "chapter", "manuscript", "location", "date", "time", "category", "role",
] as const;

function metadata(entity: StoryEntity): GraphNode["meta"] {
  const result: NonNullable<GraphNode["meta"]> = {};
  for (const key of GRAPH_META_FIELDS) {
    const value = entity.properties[key];
    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || value === null) {
      result[key] = typeof value === "string" ? truncate(value, 1024) : value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function graphNode(index: StoryIndex, entity: StoryEntity): GraphNode {
  const aliases = boundedStrings(entity.aliases);
  const tags = boundedStrings(entity.tags);
  const meta = metadata(entity);
  return {
    ref: ref(entity.id),
    kind: `story.${entity.type}`,
    label: truncate(entity.name || entity.id, 1024),
    ...(aliases ? { aliases } : {}),
    ...(tags ? { tags } : {}),
    source: { workspaceId: index.workspaceId, path: entity.path, revision: entity.revision },
    status: "available",
    ...(meta ? { meta } : {}),
  };
}

function graphEdge(index: StoryIndex, relation: StoryRelation): GraphEdge {
  const provenance = relation.provenance.map((item) => ({ path: item.path, revision: item.revision, field: item.field }));
  const source = provenance[0];
  return {
    ref: ref(relation.id),
    from: ref(relation.fromId),
    to: ref(relation.toId),
    kind: relation.kind,
    directed: relation.directed,
    ...(source ? { source: { workspaceId: index.workspaceId, path: source.path, revision: source.revision } } : {}),
    provenance,
  };
}

function unresolvedNode(localId: string): GraphNode {
  return {
    ref: ref(localId),
    kind: "story.unresolved",
    label: truncate(localId, 1024) || "未解決",
    status: "unresolved",
  };
}

export function projectStoryGraph(index: StoryIndex): StoryGraphProjection {
  const snapshot: SnapshotRef = {
    workspaceId: index.workspaceId,
    sourceRevision: index.sourceRevision,
    providerRevision: index.providerRevision,
    epoch: index.epoch,
  };
  const nodesById = new Map<string, GraphNode>();
  for (const entity of index.entitiesById.values()) nodesById.set(entity.id, graphNode(index, entity));
  const relations = [...index.relations].sort((left, right) => codePointCompare(left.id, right.id));
  for (const relation of relations) {
    if (!nodesById.has(relation.toId)) nodesById.set(relation.toId, unresolvedNode(relation.toId));
  }
  const edges = relations.map((relation) => graphEdge(index, relation));
  const nodes = [...nodesById.values()].sort((left, right) => codePointCompare(left.ref.localId, right.ref.localId));
  const edgesById = new Map(edges.map((edge) => [edge.ref.localId, edge]));
  return {
    snapshot,
    nodes,
    edges,
    nodesById,
    edgesById,
    complete: index.referencesComplete,
  };
}

function stableQuery(query: unknown): string {
  return JSON.stringify(query);
}

interface CursorPayload {
  v: 1;
  handle: string;
  snapshot: string;
  query: string;
  offset: number;
}

function encodeCursor(cursor: CursorPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (encoded.length > 4096) throw Object.assign(new Error("Provider cursor exceeds the contract limit."), { code: "PROTOCOL_INVALID" });
  return encoded;
}

function decodeCursor(value: string | undefined, handle: string, snapshot: SnapshotRef, query: string): number {
  if (!value) return 0;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Partial<CursorPayload>;
    if (parsed.v !== 1 || parsed.handle !== handle || parsed.snapshot !== JSON.stringify(snapshot) || parsed.query !== query || !Number.isSafeInteger(parsed.offset) || parsed.offset! < 0) {
      throw new Error("cursor binding mismatch");
    }
    return parsed.offset!;
  } catch {
    throw Object.assign(new Error("Provider cursor is invalid or belongs to another query, handle, or snapshot."), { code: "INVALID_INPUT" });
  }
}

function pageCursor(handle: string, snapshot: SnapshotRef, query: string, offset: number): string {
  return encodeCursor({ v: 1, handle, snapshot: JSON.stringify(snapshot), query, offset });
}

function page<T>(
  projection: StoryGraphProjection,
  handle: string,
  queryKey: string,
  values: readonly T[],
  cursor: string | undefined,
  requestedLimit: number | undefined,
): { items: T[]; nextCursor: string | null; complete: boolean } {
  const limit = requestedLimit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw Object.assign(new Error("Page limit must be between 1 and 500."), { code: "INVALID_INPUT" });
  const offset = decodeCursor(cursor, handle, projection.snapshot, queryKey);
  if (offset > values.length) throw Object.assign(new Error("Provider cursor offset is outside the current result."), { code: "INVALID_INPUT" });
  const end = Math.min(values.length, offset + limit);
  return {
    items: values.slice(offset, end) as T[],
    nextCursor: end < values.length ? pageCursor(handle, projection.snapshot, queryKey, end) : null,
    complete: projection.complete,
  };
}

function queryIncludesNode(node: GraphNode, filter: ListQuery["filter"]): boolean {
  if (!filter) return true;
  if (filter.kinds && !filter.kinds.includes(node.kind)) return false;
  const tags = node.tags ?? [];
  if (filter.tags && filter.tags.some((tag) => !tags.includes(tag))) return false;
  if (filter.query) {
    const searchable = [node.kind, node.label, node.ref.localId, ...(node.aliases ?? []), ...tags, node.source?.path ?? ""];
    if (!searchable.some((value) => normalize(value).includes(normalize(filter.query!)))) return false;
  }
  return true;
}

export function listStoryNodes(
  projection: StoryGraphProjection,
  handle: string,
  query: ListQuery,
): ProviderPage {
  const normalized = {
    filter: query.filter ? {
      ...(query.filter.kinds ? { kinds: [...query.filter.kinds].sort(codePointCompare) } : {}),
      ...(query.filter.tags ? { tags: [...query.filter.tags].sort(codePointCompare) } : {}),
      ...(query.filter.query !== undefined ? { query: query.filter.query } : {}),
    } : null,
  };
  const queryKey = stableQuery(["listNodes", normalized]);
  const values = projection.nodes.filter((node) => queryIncludesNode(node, query.filter));
  return { snapshot: projection.snapshot, ...page(projection, handle, queryKey, values, query.cursor, query.limit) };
}

function queryIncludesEdge(projection: StoryGraphProjection, edge: GraphEdge, filter: ListQuery["filter"]): boolean {
  if (!filter) return true;
  if (filter.kinds && !filter.kinds.includes(edge.kind)) return false;
  const from = projection.nodesById.get(edge.from.localId);
  const to = projection.nodesById.get(edge.to.localId);
  const tags = [...(from?.tags ?? []), ...(to?.tags ?? [])];
  if (filter.tags && filter.tags.some((tag) => !tags.includes(tag))) return false;
  if (filter.query) {
    const searchable = [
      edge.kind, edge.ref.localId, edge.from.localId, edge.to.localId,
      from?.label ?? "", to?.label ?? "", from?.source?.path ?? "", to?.source?.path ?? "",
      ...(edge.provenance ?? []).flatMap((item) => [item.path, item.field]),
    ];
    if (!searchable.some((value) => normalize(value).includes(normalize(filter.query!)))) return false;
  }
  return true;
}

export function listStoryEdges(
  projection: StoryGraphProjection,
  handle: string,
  query: ListQuery,
): GraphEdgePage {
  const normalized = {
    filter: query.filter ? {
      ...(query.filter.kinds ? { kinds: [...query.filter.kinds].sort(codePointCompare) } : {}),
      ...(query.filter.tags ? { tags: [...query.filter.tags].sort(codePointCompare) } : {}),
      ...(query.filter.query !== undefined ? { query: query.filter.query } : {}),
    } : null,
  };
  const queryKey = stableQuery(["listEdges", normalized]);
  const values = projection.edges.filter((edge) => queryIncludesEdge(projection, edge, query.filter));
  return { snapshot: projection.snapshot, ...page(projection, handle, queryKey, values, query.cursor, query.limit) };
}

export function getStoryNodes(projection: StoryGraphProjection, refs: readonly NodeRef[]): ProviderPage {
  if (refs.some((nodeRef) => nodeRef.providerId !== STORY_PROVIDER_ID)) {
    throw Object.assign(new Error("getNodes only accepts Story provider references."), { code: "INVALID_INPUT" });
  }
  const requested = [...new Set(refs.map((nodeRef) => nodeRef.localId))].sort(codePointCompare);
  const items = requested.flatMap((localId) => {
    const node = projection.nodesById.get(localId);
    return node ? [node] : [];
  });
  return {
    snapshot: projection.snapshot,
    items,
    nextCursor: null,
    complete: items.length === requested.length,
  };
}

function snapshotEqual(left: SnapshotRef, right: SnapshotRef): boolean {
  return left.workspaceId === right.workspaceId && left.sourceRevision === right.sourceRevision
    && left.providerRevision === right.providerRevision && left.epoch === right.epoch;
}

function neighborsFor(projection: StoryGraphProjection, query: NeighborQuery): { values: Neighbor[]; edgesComplete: boolean } {
  if (query.from.providerId !== STORY_PROVIDER_ID) {
    throw Object.assign(new Error("neighbors only accepts Story provider references."), { code: "INVALID_INPUT" });
  }
  const start = query.from.localId;
  if (!projection.nodesById.has(start)) return { values: [], edgesComplete: true };
  const fromEdges = new Map<string, GraphEdge[]>();
  const toEdges = new Map<string, GraphEdge[]>();
  for (const edge of projection.edges) {
    const out = fromEdges.get(edge.from.localId) ?? [];
    out.push(edge);
    fromEdges.set(edge.from.localId, out);
    const incoming = toEdges.get(edge.to.localId) ?? [];
    incoming.push(edge);
    toEdges.set(edge.to.localId, incoming);
  }

  const visited = new Set([start]);
  let frontier = [start];
  const neighbors = new Map<string, { node: GraphNode; edges: Map<string, GraphEdge> }>();
  for (let depth = 0; depth < query.depth; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const current of frontier) {
      const candidates = new Map<string, GraphEdge>();
      if (query.direction === "out" || query.direction === "both") {
        for (const edge of fromEdges.get(current) ?? []) candidates.set(edge.ref.localId, edge);
      }
      if (query.direction === "in" || query.direction === "both") {
        for (const edge of toEdges.get(current) ?? []) candidates.set(edge.ref.localId, edge);
      }
      for (const edge of [...candidates.values()].sort((left, right) => codePointCompare(left.ref.localId, right.ref.localId))) {
        const targetId = edge.from.localId === current ? edge.to.localId : edge.from.localId;
        if (targetId === current) continue;
        const node = projection.nodesById.get(targetId);
        if (!node) continue;
        const currentNeighbor = neighbors.get(targetId) ?? { node, edges: new Map<string, GraphEdge>() };
        if (currentNeighbor.edges.size < 500 || currentNeighbor.edges.has(edge.ref.localId)) {
          currentNeighbor.edges.set(edge.ref.localId, edge);
        }
        neighbors.set(targetId, currentNeighbor);
        if (!visited.has(targetId)) {
          visited.add(targetId);
          nextFrontier.add(targetId);
        }
      }
    }
    frontier = [...nextFrontier].sort(codePointCompare);
    if (frontier.length === 0) break;
  }
  const values = [...neighbors.values()].map(({ node, edges }) => ({
    node,
    edges: [...edges.values()].sort((left, right) => codePointCompare(left.ref.localId, right.ref.localId)),
  })).sort((left, right) => codePointCompare(left.node.ref.localId, right.node.ref.localId));
  const edgesComplete = [...neighbors.values()].every((item) => item.edges.size < 500);
  return { values, edgesComplete };
}

export function storyNeighbors(
  projection: StoryGraphProjection,
  handle: string,
  query: NeighborQuery,
): NeighborPage {
  if (!Number.isInteger(query.depth) || query.depth < 1 || query.depth > 3 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) {
    throw Object.assign(new Error("neighbors depth must be 1–3 and limit must be 1–500."), { code: "INVALID_INPUT" });
  }
  const queryKey = stableQuery(["neighbors", query.from, query.direction, query.depth]);
  const result = neighborsFor(projection, query);
  const resultPage = page(projection, handle, queryKey, result.values, query.cursor, query.limit);
  return {
    snapshot: projection.snapshot,
    ...resultPage,
    complete: resultPage.complete && result.edgesComplete,
  };
}

export function storyDiff(projection: StoryGraphProjection, handle: string, query: DiffQuery): GraphDeltaPage {
  if (!snapshotEqual(query.previousSnapshot, projection.snapshot)) {
    throw Object.assign(new Error("The previous Story index is not available; request a full provider resync."), { code: "RESYNC_REQUIRED" });
  }
  const queryKey = stableQuery(["diff", query.previousSnapshot]);
  const items = [] as GraphDeltaPage["items"];
  const pageResult = page(projection, handle, queryKey, items, query.cursor, query.limit);
  return { snapshot: projection.snapshot, ...pageResult };
}
