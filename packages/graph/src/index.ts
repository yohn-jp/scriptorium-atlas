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

export type { GraphDelta, GraphDeltaPage, GraphEdge, GraphEdgePage, GraphNode, NodeRef, ProviderPage, SnapshotRef } from '@scriptorium-atlas/contracts';

export type GraphDirection = 'in' | 'out' | 'both';
export type GraphField = 'name' | 'id' | 'alias' | 'tag' | 'type' | 'path';

export interface GraphIndexInput {
  readonly snapshot: SnapshotRef;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface GraphSearchOptions {
  readonly query: string;
  readonly providers?: readonly string[];
  readonly kinds?: readonly string[];
  readonly limit?: number;
}

export interface GraphSearchMatch {
  readonly node: GraphNode;
  readonly matchedFields: readonly GraphField[];
}

export interface GraphSearchResult {
  readonly items: readonly GraphSearchMatch[];
  readonly totalMatches: number;
  readonly complete: boolean;
}

export interface GraphTraversalNode {
  readonly ref: NodeRef;
  readonly node?: GraphNode;
  readonly depth: number;
}

export interface GraphTraversalResult {
  readonly from: NodeRef;
  readonly direction: GraphDirection;
  readonly depth: number;
  readonly nodes: readonly GraphTraversalNode[];
  readonly edges: readonly GraphEdge[];
  readonly unresolved: readonly NodeRef[];
  readonly complete: boolean;
}

export interface ShortestPathOptions {
  readonly from: NodeRef;
  readonly to: NodeRef;
  readonly direction?: GraphDirection;
  readonly maxHops?: number;
  readonly maxVisited?: number;
}

export type ShortestPathResult =
  | {
      readonly status: 'found';
      readonly refs: readonly NodeRef[];
      readonly nodes: readonly (GraphNode | undefined)[];
      readonly edges: readonly GraphEdge[];
      readonly hops: number;
      readonly complete: true;
    }
  | {
      readonly status: 'unreachable' | 'bounded';
      readonly refs: readonly [];
      readonly nodes: readonly [];
      readonly edges: readonly [];
      readonly hops: null;
      readonly complete: boolean;
    };

export interface WeakComponent {
  /** All known and endpoint-only references in this weakly connected component. */
  readonly refs: readonly NodeRef[];
  /** Endpoint references without a corresponding node in this snapshot. */
  readonly unresolved: readonly NodeRef[];
}

export type GraphErrorCode =
  | 'DUPLICATE_NODE'
  | 'DUPLICATE_EDGE'
  | 'DUPLICATE_DELTA_ITEM'
  | 'SNAPSHOT_MISMATCH'
  | 'RESYNC_REQUIRED'
  | 'INCOMPLETE_SNAPSHOT'
  | 'CURSOR_LOOP'
  | 'INVALID_DIRECTION'
  | 'INVALID_DEPTH'
  | 'INVALID_LIMIT'
  | 'NODE_NOT_FOUND';

export class GraphError extends Error {
  constructor(readonly code: GraphErrorCode, message: string) {
    super(message);
    this.name = 'GraphError';
  }
}

interface IndexInternals {
  readonly nodeByKey: Map<string, GraphNode>;
  readonly edgeByKey: Map<string, GraphEdge>;
  readonly outgoing: Map<string, GraphEdge[]>;
  readonly incoming: Map<string, GraphEdge[]>;
  readonly weak: Map<string, Set<string>>;
  readonly refs: Map<string, NodeRef>;
  readonly unresolved: Set<string>;
  readonly searchValues: Map<string, readonly { readonly field: GraphField; readonly value: string }[]>;
}

const internals = new WeakMap<GraphIndex, IndexInternals>();

/** A stable, immutable in-memory index for one exact provider snapshot. */
export class GraphIndex {
  readonly snapshot: SnapshotRef;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];

  constructor(input: GraphIndexInput) {
    const snapshot = freezeSnapshot(input.snapshot);
    const nodeByKey = new Map<string, GraphNode>();
    const edgeByKey = new Map<string, GraphEdge>();

    for (const node of input.nodes) {
      const key = nodeKey(node.ref);
      if (nodeByKey.has(key)) {
        throw new GraphError('DUPLICATE_NODE', `Duplicate node reference ${key}`);
      }
      nodeByKey.set(key, freezeNode(node));
    }

    for (const edge of input.edges) {
      const key = nodeKey(edge.ref);
      if (edgeByKey.has(key)) {
        throw new GraphError('DUPLICATE_EDGE', `Duplicate edge reference ${key}`);
      }
      edgeByKey.set(key, freezeEdge(edge));
    }

    this.snapshot = snapshot;
    this.nodes = Object.freeze([...nodeByKey.values()].sort((left, right) => compareRefs(left.ref, right.ref)));
    this.edges = Object.freeze([...edgeByKey.values()].sort((left, right) => compareRefs(left.ref, right.ref)));
    internals.set(this, buildInternals(nodeByKey, edgeByKey));
    Object.freeze(this);
  }

  getNode(ref: NodeRef): GraphNode | undefined {
    return internals.get(this)?.nodeByKey.get(nodeKey(ref));
  }

  getEdge(ref: NodeRef): GraphEdge | undefined {
    return internals.get(this)?.edgeByKey.get(nodeKey(ref));
  }

  hasReference(ref: NodeRef): boolean {
    return internals.get(this)?.refs.has(nodeKey(ref)) ?? false;
  }

  isResolved(ref: NodeRef): boolean {
    return internals.get(this)?.nodeByKey.has(nodeKey(ref)) ?? false;
  }
}

export function createGraphIndex(input: GraphIndexInput): GraphIndex {
  return new GraphIndex(input);
}

export class GraphSnapshotBuilder {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  private nodesComplete = false;
  private edgesComplete = false;
  private nodesTerminal = false;
  private edgesTerminal = false;
  private readonly nodeCursors = new Set<string>();
  private readonly edgeCursors = new Set<string>();
  private completed = false;

  constructor(readonly snapshot: SnapshotRef) {
    this.snapshot = freezeSnapshot(snapshot);
  }

  addNodesPage(page: ProviderPage): this {
    this.assertOpen();
    assertSameSnapshot(this.snapshot, page.snapshot, 'Node page');
    this.acceptPage(page.complete, page.nextCursor, 'node', this.nodeCursors, this.nodesTerminal);
    if (page.complete) this.nodesComplete = true;
    if (page.nextCursor === null) this.nodesTerminal = true;
    this.nodes.push(...page.items);
    return this;
  }

  addEdgesPage(page: GraphEdgePage): this {
    this.assertOpen();
    assertSameSnapshot(this.snapshot, page.snapshot, 'Edge page');
    this.acceptPage(page.complete, page.nextCursor, 'edge', this.edgeCursors, this.edgesTerminal);
    if (page.complete) this.edgesComplete = true;
    if (page.nextCursor === null) this.edgesTerminal = true;
    this.edges.push(...page.items);
    return this;
  }

  build(): GraphIndex {
    return createGraphIndex(this.buildInput());
  }

  buildInput(): GraphIndexInput {
    this.assertOpen();
    if (!this.nodesComplete || !this.edgesComplete) {
      throw new GraphError('INCOMPLETE_SNAPSHOT', 'Both node and edge page streams must be complete before building an index');
    }
    this.completed = true;
    assertUniqueItems(this.nodes, 'node');
    assertUniqueItems(this.edges, 'edge');
    const input = Object.freeze({
      snapshot: this.snapshot,
      nodes: Object.freeze([...this.nodes]),
      edges: Object.freeze([...this.edges]),
    });
    this.nodes.length = 0;
    this.edges.length = 0;
    return input;
  }

  abort(): void {
    this.assertOpen();
    this.completed = true;
    this.nodes.length = 0;
    this.edges.length = 0;
  }

  private assertOpen(): void {
    if (this.completed) throw new GraphError('SNAPSHOT_MISMATCH', 'Snapshot builder is already completed');
  }

  private acceptPage(complete: boolean, nextCursor: string | null, kind: 'node' | 'edge', seen: Set<string>, terminal: boolean): void {
    if (terminal) throw new GraphError('INCOMPLETE_SNAPSHOT', `A ${kind} page arrived after its stream ended`);
    if (complete && nextCursor !== null) throw new GraphError('INCOMPLETE_SNAPSHOT', `A complete ${kind} page cannot have another cursor`);
    if (!complete && nextCursor === null) throw new GraphError('INCOMPLETE_SNAPSHOT', `The ${kind} page stream ended without proving completeness`);
    if (nextCursor !== null) {
      if (seen.has(nextCursor)) throw new GraphError('CURSOR_LOOP', `The ${kind} page stream repeated a cursor`);
      seen.add(nextCursor);
    }
  }
}

export function beginGraphSnapshot(snapshot: SnapshotRef): GraphSnapshotBuilder {
  return new GraphSnapshotBuilder(snapshot);
}

/** Apply a consecutive delta to a new index. The original index is never mutated. */
export function applyGraphDelta(index: GraphIndex, delta: GraphDelta): GraphIndex {
  if (!sameSnapshot(index.snapshot, delta.previousSnapshot)) {
    throw new GraphError('RESYNC_REQUIRED', 'Delta base does not match the current snapshot');
  }
  if (
    index.snapshot.workspaceId !== delta.snapshot.workspaceId ||
    index.snapshot.epoch !== delta.snapshot.epoch
  ) {
    throw new GraphError('RESYNC_REQUIRED', 'Delta crosses a workspace or provider epoch boundary');
  }

  const nodesByKey = new Map(index.nodes.map((node) => [nodeKey(node.ref), node]));
  const edgesByKey = new Map(index.edges.map((edge) => [nodeKey(edge.ref), edge]));
  applyDeltaItems(nodesByKey, delta.changedNodes ?? [], delta.removedNodes ?? [], (item) => item.ref, 'node');
  applyDeltaItems(edgesByKey, delta.changedEdges ?? [], delta.removedEdges ?? [], (item) => item.ref, 'edge');

  return createGraphIndex({
    snapshot: delta.snapshot,
    nodes: [...nodesByKey.values()],
    edges: [...edgesByKey.values()],
  });
}

export function applyGraphDeltaPages(index: GraphIndex, pages: readonly GraphDeltaPage[]): GraphIndex {
  return applyGraphDelta(index, combineGraphDeltaPages(index.snapshot, pages));
}

export function combineGraphDeltaPages(previousSnapshot: SnapshotRef, pages: readonly GraphDeltaPage[]): GraphDelta {
  if (pages.length === 0) throw new GraphError('RESYNC_REQUIRED', 'No complete delta pages were supplied');
  const target = pages[0]!.snapshot;
  const changedNodes: GraphNode[] = [];
  const removedNodes: NodeRef[] = [];
  const changedEdges: GraphEdge[] = [];
  const removedEdges: NodeRef[] = [];
  const cursors = new Set<string>();

  for (const [indexInPages, page] of pages.entries()) {
    assertSameSnapshot(target, page.snapshot, 'Delta page');
    const isLast = indexInPages === pages.length - 1;
    if (page.complete !== isLast || (isLast ? page.nextCursor !== null : page.nextCursor === null)) {
      throw new GraphError('RESYNC_REQUIRED', 'Delta page stream is incomplete or has inconsistent cursor state');
    }
    if (page.nextCursor !== null) {
      if (cursors.has(page.nextCursor)) throw new GraphError('CURSOR_LOOP', 'Delta page stream repeated a cursor');
      cursors.add(page.nextCursor);
    }
    for (const delta of page.items) {
      if (!sameSnapshot(delta.previousSnapshot, previousSnapshot) || !sameSnapshot(delta.snapshot, target)) {
        throw new GraphError('RESYNC_REQUIRED', 'Delta page contains a gap or mixes target snapshots');
      }
      changedNodes.push(...(delta.changedNodes ?? []));
      removedNodes.push(...(delta.removedNodes ?? []));
      changedEdges.push(...(delta.changedEdges ?? []));
      removedEdges.push(...(delta.removedEdges ?? []));
    }
  }

  return {
    previousSnapshot,
    snapshot: target,
    changedNodes,
    removedNodes,
    changedEdges,
    removedEdges,
  };
}

export function searchGraph(index: GraphIndex, options: GraphSearchOptions): GraphSearchResult {
  const limit = validateLimit(options.limit, 'search');
  const query = normalizeSearchText(options.query);
  const providers = options.providers ? new Set(options.providers) : undefined;
  const kinds = options.kinds ? new Set(options.kinds) : undefined;
  const items: GraphSearchMatch[] = [];
  const state = internals.get(index)!;

  for (const node of index.nodes) {
    if (providers && !providers.has(node.ref.providerId)) continue;
    if (kinds && !kinds.has(node.kind)) continue;

    const matches = new Set<GraphField>();
    for (const indexed of state.searchValues.get(nodeKey(node.ref)) ?? []) {
      if (indexed.value.includes(query)) matches.add(indexed.field);
    }
    if (matches.size > 0 || query.length === 0) {
      items.push(Object.freeze({ node, matchedFields: Object.freeze([...matches]) }));
    }
  }

  const totalMatches = items.length;
  const selected = limit === undefined ? items : items.slice(0, limit);
  return Object.freeze({ items: Object.freeze(selected), totalMatches, complete: selected.length === totalMatches });
}

export function neighbors(
  index: GraphIndex,
  options: { readonly from: NodeRef; readonly direction: GraphDirection; readonly depth: number; readonly limit?: number },
): GraphTraversalResult {
  const limit = validateLimit(options.limit, 'neighbors');
  validateDirection(options.direction);
  if (!Number.isInteger(options.depth) || options.depth < 1 || options.depth > 3) {
    throw new GraphError('INVALID_DEPTH', 'Neighbor depth must be an integer from 1 through 3');
  }

  const state = internals.get(index)!;
  const start = nodeKey(options.from);
  if (!state.refs.has(start)) throw new GraphError('NODE_NOT_FOUND', `Start reference ${start} is not in this snapshot`);

  const distance = new Map<string, number>([[start, 0]]);
  const queue = [start];
  const traversedEdges = new Map<string, GraphEdge>();

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]!;
    const currentDistance = distance.get(current)!;
    if (currentDistance >= options.depth) continue;

    for (const edge of adjacentEdges(state, current, options.direction)) {
      traversedEdges.set(nodeKey(edge.ref), edge);
      const next = otherEndpoint(edge, current);
      if (!distance.has(next)) {
        distance.set(next, currentDistance + 1);
        queue.push(next);
      }
    }
  }

  const traversed = [...distance.entries()]
    .filter(([key]) => key !== start)
    .map(([key, depth]) => {
      const node = state.nodeByKey.get(key);
      return Object.freeze({
        ref: state.refs.get(key)!,
        ...(node ? { node } : {}),
        depth,
      });
    })
    .sort((left, right) => left.depth - right.depth || compareRefs(left.ref, right.ref));
  const selected = limit === undefined ? traversed : traversed.slice(0, limit);
  const selectedKeys = new Set(selected.map((item) => nodeKey(item.ref)));
  const edges = [...traversedEdges.values()]
    .filter((edge) => {
      const from = nodeKey(edge.from);
      const to = nodeKey(edge.to);
      return (from === start || selectedKeys.has(from)) && (to === start || selectedKeys.has(to));
    })
    .sort((left, right) => compareRefs(left.ref, right.ref));
  const unresolved = selected.filter((item) => !item.node).map((item) => item.ref);

  return Object.freeze({
    from: state.refs.get(start)!,
    direction: options.direction,
    depth: options.depth,
    nodes: Object.freeze(selected),
    edges: Object.freeze(edges),
    unresolved: Object.freeze(unresolved),
    complete: selected.length === traversed.length,
  });
}

export function shortestPath(index: GraphIndex, options: ShortestPathOptions): ShortestPathResult {
  const direction = options.direction ?? 'both';
  validateDirection(direction);
  const maxHops = options.maxHops ?? Math.max(index.nodes.length, index.edges.length, 1);
  const maxVisited = options.maxVisited ?? Math.max(index.nodes.length + index.edges.length * 2, 1);
  if (!Number.isInteger(maxHops) || maxHops < 0) throw new GraphError('INVALID_DEPTH', 'maxHops must be a non-negative integer');
  if (!Number.isInteger(maxVisited) || maxVisited < 1) throw new GraphError('INVALID_LIMIT', 'maxVisited must be a positive integer');

  const state = internals.get(index)!;
  const start = nodeKey(options.from);
  const target = nodeKey(options.to);
  if (!state.refs.has(start)) throw new GraphError('NODE_NOT_FOUND', `Start reference ${start} is not in this snapshot`);
  if (!state.refs.has(target)) {
    return emptyPath('unreachable', true);
  }
  if (start === target) {
    const ref = state.refs.get(start)!;
    return Object.freeze({ status: 'found', refs: Object.freeze([ref]), nodes: Object.freeze([state.nodeByKey.get(start)]), edges: Object.freeze([]), hops: 0, complete: true });
  }

  const distance = new Map<string, number>([[start, 0]]);
  const parent = new Map<string, { readonly previous: string; readonly edge: GraphEdge }>();
  const queue = [start];
  let bounded = false;

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]!;
    const currentDistance = distance.get(current)!;
    if (currentDistance >= maxHops) {
      if (adjacentEdges(state, current, direction).some((edge) => !distance.has(otherEndpoint(edge, current)))) bounded = true;
      continue;
    }

    for (const edge of adjacentEdges(state, current, direction)) {
      const next = otherEndpoint(edge, current);
      if (distance.has(next)) continue;
      if (distance.size >= maxVisited) {
        bounded = true;
        continue;
      }
      distance.set(next, currentDistance + 1);
      parent.set(next, { previous: current, edge });
      if (next === target) return buildPath(state, parent, distance, start, target);
      queue.push(next);
    }
  }

  return emptyPath(bounded ? 'bounded' : 'unreachable', !bounded);
}

export function weakComponents(index: GraphIndex): readonly WeakComponent[] {
  const state = internals.get(index)!;
  const unvisited = new Set(state.refs.keys());
  const sortedKeys = [...state.refs.keys()].sort((left, right) => compareRefs(state.refs.get(left)!, state.refs.get(right)!));
  const components: WeakComponent[] = [];

  for (const start of sortedKeys) {
    if (!unvisited.has(start)) continue;
    const queue = [start];
    const members: string[] = [];
    unvisited.delete(start);
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const current = queue[queueIndex]!;
      members.push(current);
      for (const neighbor of state.weak.get(current) ?? []) {
        if (unvisited.delete(neighbor)) queue.push(neighbor);
      }
    }
    members.sort((left, right) => compareRefs(state.refs.get(left)!, state.refs.get(right)!));
    const refs = members.map((key) => state.refs.get(key)!);
    components.push(Object.freeze({
      refs: Object.freeze(refs),
      unresolved: Object.freeze(refs.filter((ref) => !state.nodeByKey.has(nodeKey(ref)))),
    }));
  }

  components.sort((left, right) => compareRefs(left.refs[0]!, right.refs[0]!));
  return Object.freeze(components);
}

export function nodeKey(ref: NodeRef): string {
  return JSON.stringify([ref.providerId, ref.localId]);
}

export function snapshotKey(snapshot: SnapshotRef): string {
  return JSON.stringify([snapshot.workspaceId, snapshot.sourceRevision, snapshot.providerRevision, snapshot.epoch]);
}

export function sameSnapshot(left: SnapshotRef, right: SnapshotRef): boolean {
  return left.workspaceId === right.workspaceId &&
    left.sourceRevision === right.sourceRevision &&
    left.providerRevision === right.providerRevision &&
    left.epoch === right.epoch;
}

function buildInternals(nodeByKey: Map<string, GraphNode>, edgeByKey: Map<string, GraphEdge>): IndexInternals {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  const weak = new Map<string, Set<string>>();
  const refs = new Map<string, NodeRef>();

  const remember = (ref: NodeRef): string => {
    const key = nodeKey(ref);
    if (!refs.has(key)) refs.set(key, freezeRef(ref));
    if (!weak.has(key)) weak.set(key, new Set());
    return key;
  };

  for (const node of nodeByKey.values()) remember(node.ref);
  for (const edge of edgeByKey.values()) {
    const from = remember(edge.from);
    const to = remember(edge.to);
    addEdge(outgoing, from, edge);
    addEdge(incoming, to, edge);
    if (!edge.directed) {
      addEdge(outgoing, to, edge);
      addEdge(incoming, from, edge);
    }
    weak.get(from)!.add(to);
    weak.get(to)!.add(from);
  }

  const sortAdjacency = (map: Map<string, GraphEdge[]>): void => {
    for (const values of map.values()) values.sort((left, right) => compareRefs(left.ref, right.ref));
  };
  sortAdjacency(outgoing);
  sortAdjacency(incoming);

  const unresolved = new Set<string>();
  for (const [key] of refs) if (!nodeByKey.has(key)) unresolved.add(key);
  const searchValues = new Map<string, readonly { readonly field: GraphField; readonly value: string }[]>();
  for (const [key, node] of nodeByKey) {
    const values: { readonly field: GraphField; readonly value: string }[] = [];
    const append = (field: GraphField, raw: string | undefined): void => {
      if (raw !== undefined && raw.length > 0) values.push(Object.freeze({ field, value: normalizeSearchText(raw) }));
    };
    append('name', node.label);
    append('id', node.ref.localId);
    for (const alias of node.aliases ?? []) append('alias', alias);
    for (const tag of node.tags ?? []) append('tag', tag);
    append('type', node.kind);
    append('path', node.source?.path);
    searchValues.set(key, Object.freeze(values));
  }
  return { nodeByKey, edgeByKey, outgoing, incoming, weak, refs, unresolved, searchValues };
}

function adjacentEdges(state: IndexInternals, key: string, direction: GraphDirection): GraphEdge[] {
  const candidates = new Map<string, GraphEdge>();
  if (direction === 'out' || direction === 'both') {
    for (const edge of state.outgoing.get(key) ?? []) candidates.set(nodeKey(edge.ref), edge);
  }
  if (direction === 'in' || direction === 'both') {
    for (const edge of state.incoming.get(key) ?? []) candidates.set(nodeKey(edge.ref), edge);
  }
  return [...candidates.values()].sort((left, right) => compareRefs(left.ref, right.ref));
}

function otherEndpoint(edge: GraphEdge, current: string): string {
  return nodeKey(edge.from) === current ? nodeKey(edge.to) : nodeKey(edge.from);
}

function buildPath(
  state: IndexInternals,
  parents: Map<string, { readonly previous: string; readonly edge: GraphEdge }>,
  distances: Map<string, number>,
  start: string,
  target: string,
): ShortestPathResult {
  const reversedRefs = [target];
  const reversedEdges: GraphEdge[] = [];
  let current = target;
  while (current !== start) {
    const step = parents.get(current)!;
    reversedEdges.push(step.edge);
    current = step.previous;
    reversedRefs.push(current);
  }
  const refs = reversedRefs.reverse().map((key) => state.refs.get(key)!);
  const edges = reversedEdges.reverse();
  return Object.freeze({
    status: 'found',
    refs: Object.freeze(refs),
    nodes: Object.freeze(refs.map((ref) => state.nodeByKey.get(nodeKey(ref)))),
    edges: Object.freeze(edges),
    hops: distances.get(target)!,
    complete: true,
  });
}

function emptyPath(status: 'unreachable' | 'bounded', complete: boolean): ShortestPathResult {
  const empty = Object.freeze([]) as readonly [];
  return Object.freeze({ status, refs: empty, nodes: empty, edges: empty, hops: null, complete });
}

function applyDeltaItems<T extends { readonly ref: NodeRef }>(
  target: Map<string, T>,
  upserts: readonly T[],
  removals: readonly NodeRef[],
  getRef: (item: T) => NodeRef,
  kind: 'node' | 'edge',
): void {
  const upsertKeys = new Set<string>();
  const removalKeys = new Set<string>();
  for (const item of upserts) {
    const key = nodeKey(getRef(item));
    if (upsertKeys.has(key)) throw new GraphError('DUPLICATE_DELTA_ITEM', `Duplicate ${kind} upsert ${key}`);
    upsertKeys.add(key);
  }
  for (const ref of removals) {
    const key = nodeKey(ref);
    if (removalKeys.has(key) || upsertKeys.has(key)) throw new GraphError('DUPLICATE_DELTA_ITEM', `Conflicting ${kind} delta item ${key}`);
    removalKeys.add(key);
    if (!target.has(key)) throw new GraphError('RESYNC_REQUIRED', `Delta removes unknown ${kind} ${key}`);
  }
  for (const key of removalKeys) target.delete(key);
  for (const item of upserts) target.set(nodeKey(getRef(item)), item);
}

function assertSameSnapshot(expected: SnapshotRef, actual: SnapshotRef, label: string): void {
  if (!sameSnapshot(expected, actual)) {
    throw new GraphError('SNAPSHOT_MISMATCH', `${label} belongs to a different snapshot`);
  }
}

function validateDirection(direction: string): asserts direction is GraphDirection {
  if (direction !== 'in' && direction !== 'out' && direction !== 'both') {
    throw new GraphError('INVALID_DIRECTION', `Unsupported graph direction ${direction}`);
  }
}

function validateLimit(limit: number | undefined, operation: string): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw new GraphError('INVALID_LIMIT', `${operation} limit must be an integer from 1 through 10000`);
  }
  return limit;
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function freezeNode(node: GraphNode): GraphNode {
  const clone = {
    ...node,
    ref: freezeRef(node.ref),
    ...(node.aliases ? { aliases: [...node.aliases] } : {}),
    ...(node.tags ? { tags: [...node.tags] } : {}),
    ...(node.source ? { source: { ...node.source } } : {}),
    ...(node.meta ? { meta: { ...node.meta } } : {}),
  };
  return Object.freeze({
    ...clone,
    ...(clone.aliases ? { aliases: Object.freeze(clone.aliases) as string[] } : {}),
    ...(clone.tags ? { tags: Object.freeze(clone.tags) as string[] } : {}),
    ...(clone.source ? { source: Object.freeze(clone.source) } : {}),
    ...(clone.meta ? { meta: Object.freeze(clone.meta) } : {}),
  }) as GraphNode;
}

function freezeEdge(edge: GraphEdge): GraphEdge {
  const clone = {
    ...edge,
    ref: freezeRef(edge.ref),
    from: freezeRef(edge.from),
    to: freezeRef(edge.to),
    ...(edge.source ? { source: { ...edge.source } } : {}),
    ...(edge.provenance ? { provenance: edge.provenance.map((item) => ({ ...item })) } : {}),
  };
  return Object.freeze({
    ...clone,
    ...(clone.source ? { source: Object.freeze(clone.source) } : {}),
    ...(clone.provenance ? { provenance: Object.freeze(clone.provenance.map((item) => Object.freeze(item))) as GraphEdge['provenance'] } : {}),
  }) as GraphEdge;
}

function freezeRef(ref: NodeRef): NodeRef {
  return Object.freeze({ providerId: ref.providerId, localId: ref.localId });
}

function freezeSnapshot(snapshot: SnapshotRef): SnapshotRef {
  return Object.freeze({
    workspaceId: snapshot.workspaceId,
    sourceRevision: snapshot.sourceRevision,
    providerRevision: snapshot.providerRevision,
    epoch: snapshot.epoch,
  });
}

function compareRefs(left: NodeRef, right: NodeRef): number {
  return compareStrings(left.providerId, right.providerId) || compareStrings(left.localId, right.localId);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addEdge(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void {
  const values = map.get(key);
  if (values) values.push(edge);
  else map.set(key, [edge]);
}

function assertUniqueItems<T extends { readonly ref: NodeRef }>(items: readonly T[], kind: 'node' | 'edge'): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = nodeKey(item.ref);
    if (seen.has(key)) throw new GraphError(kind === 'node' ? 'DUPLICATE_NODE' : 'DUPLICATE_EDGE', `Duplicate ${kind} reference ${key}`);
    seen.add(key);
  }
}
