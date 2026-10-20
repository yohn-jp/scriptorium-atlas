import type { ELK as ElkApi, ElkNode } from 'elkjs/lib/elk-api.js';
import type { Position } from '@scriptorium-atlas/contracts';
import { LayoutError, type LayoutInput, type LayoutNode, type LayoutPosition, type LayoutResult } from './types.js';

const coordinateLimit = 10_000_000;
const defaultNodeWidth = 160;
const defaultNodeHeight = 80;

export async function calculateLayout(input: LayoutInput): Promise<LayoutResult> {
  const normalized = normalizeInput(input);
  let computed: LayoutPosition[];
  switch (input.kind) {
    case 'force':
      computed = await forceLayout(input, normalized.nodes, normalized.edges);
      break;
    case 'layered':
      computed = await layeredLayout(input, normalized.nodes, normalized.edges);
      break;
    case 'timeline':
      computed = timelineLayout(input, normalized.nodes);
      break;
    case 'manual':
      computed = normalized.nodes.map((node) => position(node.id, node.position.x, node.position.y));
      break;
  }

  const pins = new Map<string, Position>();
  for (const pin of input.pins ?? []) pins.set(pin.nodeId, { x: pin.x, y: pin.y });
  const positions = computed.map((item) => {
    const pinned = pins.get(item.nodeId);
    return pinned ? Object.freeze({ ...item, position: Object.freeze({ x: pinned.x, y: pinned.y }) }) : item;
  });
  positions.sort((left, right) => compareStrings(left.nodeId, right.nodeId));

  const snapshot = input.snapshot ? Object.freeze({ ...input.snapshot }) : undefined;
  const base = {
    kind: input.kind,
    boardRevision: input.boardRevision,
    positions: Object.freeze(positions),
    unresolvedEdgeIds: Object.freeze(normalized.unresolvedEdgeIds),
  };
  return Object.freeze(snapshot ? { ...base, snapshot } : base);
}

interface NormalizedInput {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutInput['edges'][number][];
  readonly unresolvedEdgeIds: readonly string[];
}

function normalizeInput(input: LayoutInput): NormalizedInput {
  if (!Number.isSafeInteger(input.boardRevision) || input.boardRevision < 0) {
    throw new LayoutError('INVALID_INPUT', 'Layout requires a non-negative integer Board revision');
  }
  const nodeById = new Map<string, LayoutNode>();
  for (const node of input.nodes) {
    if (!node.id || nodeById.has(node.id)) {
      throw new LayoutError('DUPLICATE_NODE', `Missing or duplicate layout node id ${node.id}`);
    }
    validateCoordinate(node.position.x, `node ${node.id} x`);
    validateCoordinate(node.position.y, `node ${node.id} y`);
    if (node.width !== undefined && (!Number.isFinite(node.width) || node.width <= 0 || node.width > 10000)) {
      throw new LayoutError('INVALID_INPUT', `Node ${node.id} has an invalid width`);
    }
    if (node.height !== undefined && (!Number.isFinite(node.height) || node.height <= 0 || node.height > 10000)) {
      throw new LayoutError('INVALID_INPUT', `Node ${node.id} has an invalid height`);
    }
    nodeById.set(node.id, node);
  }

  const edgeIds = new Set<string>();
  const edges: LayoutInput['edges'][number][] = [];
  const unresolvedEdgeIds: string[] = [];
  for (const edge of input.edges) {
    if (!edge.id || edgeIds.has(edge.id)) throw new LayoutError('DUPLICATE_EDGE', `Missing or duplicate layout edge id ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) unresolvedEdgeIds.push(edge.id);
    else edges.push(edge);
  }

  const seenPins = new Set<string>();
  for (const pin of input.pins ?? []) {
    if (seenPins.has(pin.nodeId) || !nodeById.has(pin.nodeId)) {
      throw new LayoutError('INVALID_PIN', `Pin ${pin.nodeId} is duplicated or refers to a missing node`);
    }
    seenPins.add(pin.nodeId);
    validateCoordinate(pin.x, `pin ${pin.nodeId} x`);
    validateCoordinate(pin.y, `pin ${pin.nodeId} y`);
  }

  return {
    nodes: Object.freeze([...nodeById.values()].sort((left, right) => compareStrings(left.id, right.id))),
    edges: Object.freeze(edges.sort((left, right) => compareStrings(left.id, right.id))),
    unresolvedEdgeIds: Object.freeze(unresolvedEdgeIds.sort(compareStrings)),
  };
}

async function forceLayout(
  input: Extract<LayoutInput, { kind: 'force' }>,
  sourceNodes: readonly LayoutNode[],
  sourceEdges: readonly LayoutInput['edges'][number][],
): Promise<LayoutPosition[]> {
  const {
    forceCenter,
    forceCollide,
    forceLink,
    forceManyBody,
    forceSimulation,
  } = await import('d3-force');
  const pins = new Map((input.pins ?? []).map((pin) => [pin.nodeId, pin]));
  const nodes = sourceNodes.map((node) => {
    const pin = pins.get(node.id);
    return {
      id: node.id,
      x: pin?.x ?? node.position.x,
      y: pin?.y ?? node.position.y,
      ...(pin ? { fx: pin.x, fy: pin.y } : {}),
      width: node.width ?? defaultNodeWidth,
      height: node.height ?? defaultNodeHeight,
    };
  });
  const links = sourceEdges.map((edge) => ({ id: edge.id, source: edge.from, target: edge.to }));
  const simulation = forceSimulation<typeof nodes[number]>([]);
  simulation.stop();
  simulation.randomSource(seededRandom(input.seed ?? 'atlas-layout-v1'));
  simulation.nodes(nodes);
  simulation
    .force('link', forceLink<typeof nodes[number], (typeof links)[number]>(links).id((node) => node.id).distance(input.linkDistance ?? 140))
    .force('charge', forceManyBody<typeof nodes[number]>().strength(input.chargeStrength ?? -300))
    .force('center', forceCenter(input.centerX ?? 0, input.centerY ?? 0))
    .force('collision', forceCollide<typeof nodes[number]>((node) => Math.hypot(node.width, node.height) / 2));

  const iterations = input.iterations ?? 240;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10000) {
    throw new LayoutError('INVALID_INPUT', 'Force iterations must be an integer from 1 through 10000');
  }
  if (input.linkDistance !== undefined && (!Number.isFinite(input.linkDistance) || input.linkDistance <= 0 || input.linkDistance > 10000)) {
    throw new LayoutError('INVALID_INPUT', 'Force linkDistance must be positive and at most 10000');
  }
  if (input.chargeStrength !== undefined && (!Number.isFinite(input.chargeStrength) || input.chargeStrength > 0 || input.chargeStrength < -100000)) {
    throw new LayoutError('INVALID_INPUT', 'Force chargeStrength must be between -100000 and 0');
  }
  simulation.tick(iterations);
  simulation.stop();

  return nodes.map((node) => position(node.id, node.fx ?? node.x ?? 0, node.fy ?? node.y ?? 0));
}

async function layeredLayout(
  input: Extract<LayoutInput, { kind: 'layered' }>,
  sourceNodes: readonly LayoutNode[],
  sourceEdges: readonly LayoutInput['edges'][number][],
): Promise<LayoutPosition[]> {
  const direction = input.direction ?? 'RIGHT';
  const nodeSpacing = input.nodeSpacing ?? 48;
  const layerSpacing = input.layerSpacing ?? 96;
  if (!Number.isFinite(nodeSpacing) || nodeSpacing < 0 || nodeSpacing > 10000 || !Number.isFinite(layerSpacing) || layerSpacing < 0 || layerSpacing > 10000) {
    throw new LayoutError('INVALID_INPUT', 'Layered spacing must be between 0 and 10000');
  }

  const graph: ElkNode = {
    id: 'atlas-root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': String(nodeSpacing),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(layerSpacing),
    },
    children: sourceNodes.map((node) => ({ id: node.id, width: node.width ?? defaultNodeWidth, height: node.height ?? defaultNodeHeight })),
    edges: sourceEdges.map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  };
  const hasNativeWorker = typeof document === 'undefined' && typeof self !== 'undefined';
  const elk = await createElk();
  try {
    const result = await elk.layout(graph);
    return (result.children ?? []).map((node) => position(node.id, node.x ?? 0, node.y ?? 0));
  } finally {
    if (hasNativeWorker) elk.terminateWorker();
  }
}

async function createElk(): Promise<ElkApi> {
  // elk.bundled installs its fake Worker by requiring elk-worker.min.js. In a
  // DedicatedWorker that file instead binds self.onmessage and exports no
  // fake Worker, so use ELK's public API with its official nested Worker entry.
  if (typeof document === 'undefined' && typeof self !== 'undefined') {
    const elkModule = await import('elkjs/lib/elk-api.js');
    const ElkConstructor = elkModule.default as unknown as new (options: { workerFactory: () => Worker }) => ElkApi;
    return new ElkConstructor({
      workerFactory: () => new Worker(new URL('./elk-entry.js', import.meta.url), { type: 'module' }),
    });
  }

  // Keep direct Node calculateLayout consumers working with elkjs's bundled
  // in-process worker. Browser layout calculations run in the branch above.
  const elkModule = await import('elkjs/lib/elk.bundled.js');
  const ElkConstructor = elkModule.default as unknown as new () => ElkApi;
  return new ElkConstructor();
}

function timelineLayout(
  input: Extract<LayoutInput, { kind: 'timeline' }>,
  nodes: readonly LayoutNode[],
): LayoutPosition[] {
  const width = input.width ?? 1200;
  const rowSpacing = input.rowSpacing ?? 72;
  const laneSpacing = input.laneSpacing ?? 120;
  if (!Number.isFinite(width) || width <= 0 || width > coordinateLimit || !Number.isFinite(rowSpacing) || rowSpacing <= 0 || rowSpacing > 10000 || !Number.isFinite(laneSpacing) || laneSpacing <= 0 || laneSpacing > 10000) {
    throw new LayoutError('INVALID_INPUT', 'Timeline width and spacing must be positive finite values');
  }

  const valuesByItemId = new Map<string, number | null>();
  for (const entry of input.entries) {
    if (valuesByItemId.has(entry.itemId)) throw new LayoutError('INVALID_INPUT', `Duplicate timeline entry for ${entry.itemId}`);
    if (entry.value !== null && !Number.isFinite(entry.value)) {
      throw new LayoutError('INVALID_INPUT', `Timeline entry ${entry.itemId} must be finite or null`);
    }
    valuesByItemId.set(entry.itemId, entry.value);
  }

  if (input.range && (
    !Number.isFinite(input.range.start) ||
    !Number.isFinite(input.range.end) ||
    input.range.start > input.range.end
  )) {
    throw new LayoutError('INVALID_INPUT', 'Timeline range must have finite start and end values with start <= end');
  }

  const known = new Map<string, number>();
  const unknown: LayoutNode[] = [];
  if (input.axis !== 'unknown') {
    for (const node of nodes) {
      const value = valuesByItemId.get(node.id);
      if (value === undefined || value === null) unknown.push(node);
      else known.set(node.id, value);
    }
  } else {
    unknown.push(...nodes);
  }

  const times = [...new Set(known.values())].sort((left, right) => left - right);
  const min = input.range?.start ?? times[0] ?? 0;
  const max = input.range?.end ?? times[times.length - 1] ?? min;
  const mainPositions = new Map<string, { readonly x: number; readonly y: number }>();
  const byTime = new Map<number, string[]>();
  for (const [nodeId, value] of known) {
    const list = byTime.get(value);
    if (list) list.push(nodeId);
    else byTime.set(value, [nodeId]);
  }
  let maxItemsAtTime = 0;
  for (const [time, nodeIds] of byTime) {
    nodeIds.sort(compareStrings);
    maxItemsAtTime = Math.max(maxItemsAtTime, nodeIds.length);
    const x = max === min ? width / 2 : ((time - min) / (max - min)) * width;
    for (const [rank, nodeId] of nodeIds.entries()) {
      mainPositions.set(nodeId, { x, y: rank * rowSpacing });
    }
  }

  const unknownY = maxItemsAtTime * rowSpacing + laneSpacing;
  const results: LayoutPosition[] = [];
  for (const node of nodes) {
    const knownPosition = mainPositions.get(node.id);
    if (knownPosition) results.push(position(node.id, knownPosition.x, knownPosition.y, 'main'));
  }
  unknown.sort((left, right) => compareStrings(left.id, right.id));
  for (const [index, node] of unknown.entries()) {
    results.push(position(node.id, index * rowSpacing, unknownY, 'unknown'));
  }
  return results;
}

function position(nodeId: string, x: number, y: number, lane?: 'main' | 'unknown'): LayoutPosition {
  validateCoordinate(x, `layout x for ${nodeId}`);
  validateCoordinate(y, `layout y for ${nodeId}`);
  const position: Position = Object.freeze({ x, y });
  return Object.freeze(lane ? { nodeId, position, lane } : { nodeId, position });
}

function validateCoordinate(value: number, label: string): void {
  if (!Number.isFinite(value) || value < -coordinateLimit || value > coordinateLimit) {
    throw new LayoutError('INVALID_INPUT', `${label} must be a finite coordinate within ±${coordinateLimit}`);
  }
}

function seededRandom(seed: string | number): () => number {
  let state = typeof seed === 'number' ? Math.floor(seed) >>> 0 : hashString(seed);
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
