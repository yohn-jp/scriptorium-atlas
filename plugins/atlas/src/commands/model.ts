import type {
  BoardDocument,
  BoardEdge,
  BoardNode,
  Position,
  Viewport,
} from '@scriptorium-atlas/contracts';
import { assertBoardIntegrity } from '@scriptorium-atlas/contracts';

type BoardView = BoardDocument['views'][number];
type BoardCard = BoardDocument['cards'][number];
type BoardNodePatch = {
  label?: string;
  annotation?: string | null;
  groupId?: string | null;
  position?: Position;
};
type CardPatch = {
  text?: string | null;
  annotation?: string | null;
  position?: Position;
  width?: number;
  height?: number;
  source?: BoardDocument['cards'][number]['source'] | null;
  nodeRef?: BoardDocument['cards'][number]['nodeRef'] | null;
  assetId?: string | null;
};

export type AtlasCommand =
  | { type: 'board.rename'; name: string }
  | { type: 'node.create'; node: BoardNode }
  | { type: 'node.update'; id: string; patch: BoardNodePatch }
  | { type: 'node.apply-layout'; positions: Array<{ id: string; position: Position }> }
  | { type: 'node.apply-groups'; groups: Array<{ groupId: string; ids: string[] }> }
  | { type: 'node.duplicate'; id: string; newId: string }
  | { type: 'node.delete'; id: string }
  | { type: 'node.group'; ids: string[]; groupId: string | null }
  | { type: 'edge.create'; edge: BoardEdge }
  | { type: 'edge.update'; id: string; patch: { label?: string | null } }
  | { type: 'edge.delete'; id: string }
  | { type: 'graph.delete-selection'; nodeIds: string[]; edgeIds: string[] }
  | { type: 'card.create'; card: BoardCard; asset?: BoardDocument['assets'][number] }
  | { type: 'card.update'; id: string; patch: CardPatch }
  | { type: 'card.duplicate'; id: string; newId: string }
  | { type: 'card.delete'; id: string }
  | { type: 'view.create'; view: BoardView }
  | { type: 'view.update'; id: string; patch: Partial<Omit<BoardView, 'id' | 'kind'>> }
  | { type: 'view.delete'; id: string }
  | { type: 'view.move-node'; viewId: string; nodeId: string; position: Position; pin: boolean }
  | { type: 'view.move-nodes'; viewId: string; positions: Array<{ nodeId: string; position: Position }>; pin: boolean }
  | { type: 'view.unpin-node'; viewId: string; nodeId: string }
  | { type: 'view.assign-card'; viewId: string; laneId: string; cardId: string; index?: number }
  | { type: 'view.set-lanes'; viewId: string; lanes: NonNullable<BoardView['lanes']> }
  | { type: 'view.reorder-cards'; viewId: string; cardIds: string[] }
  | {
      type: 'view.timeline';
      viewId: string;
      axis: NonNullable<BoardView['axis']>;
      range: { start: number; end: number };
      entries: Array<{ itemId: string; value: number | null }>;
    }
  | { type: 'view.filter'; viewId: string; filter: NonNullable<BoardView['filter']> | null }
  | { type: 'view.viewport'; viewId: string; viewport: Viewport };

export class AtlasCommandError extends Error {
  constructor(
    readonly code:
      | 'ITEM_NOT_FOUND'
      | 'ITEM_EXISTS'
      | 'INVALID_COMMAND'
      | 'LAST_VIEW'
      | 'SEMANTIC_EDGE_READONLY'
      | 'PROVIDER_NODE_READONLY',
    message: string,
  ) {
    super(message);
    this.name = 'AtlasCommandError';
  }
}

const fail = (code: ConstructorParameters<typeof AtlasCommandError>[0], message: string): never => {
  throw new AtlasCommandError(code, message);
};

const clone = <T>(value: T): T => structuredClone(value);

const itemIndex = <T extends { id: string }>(items: T[], id: string, label: string): number => {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) fail('ITEM_NOT_FOUND', `${label} \"${id}\" does not exist.`);
  return index;
};

const assertAvailableId = (items: Array<{ id: string }>, id: string, label: string): void => {
  if (items.some((item) => item.id === id)) fail('ITEM_EXISTS', `${label} \"${id}\" already exists.`);
  if (!id || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    fail('INVALID_COMMAND', `${label} ID is invalid.`);
  }
};

const updateOptionalString = <T extends object, K extends keyof T>(
  item: T,
  patch: Partial<Record<K, T[K] | null>>,
  key: K,
): void => {
  if (!Object.hasOwn(patch, key)) return;
  const value = patch[key];
  const mutable = item as Partial<T>;
  if (value === null || value === undefined) delete mutable[key];
  else mutable[key] = value as T[K];
};

const requireView = (board: BoardDocument, id: string): BoardView => {
  const index = itemIndex(board.views, id, 'View');
  return board.views[index]!;
};

const requireCard = (board: BoardDocument, id: string): BoardCard => {
  const index = itemIndex(board.cards, id, 'Card');
  return board.cards[index]!;
};

const requireNode = (board: BoardDocument, id: string): BoardNode => {
  const index = itemIndex(board.nodes, id, 'Node');
  return board.nodes[index]!;
};

const applyNodePatch = (node: BoardNode, patch: BoardNodePatch): BoardNode => {
  if (node.origin === 'provider' && Object.hasOwn(patch, 'label')) {
    fail('PROVIDER_NODE_READONLY', 'Provider node labels come from the provider snapshot.');
  }
  const next = { ...node };
  if (patch.label !== undefined) next.label = patch.label;
  if (Object.hasOwn(patch, 'position') && patch.position) next.position = clone(patch.position);
  updateOptionalString(next, patch, 'annotation');
  updateOptionalString(next, patch, 'groupId');
  return next;
};

const applyCardPatch = (card: BoardCard, patch: CardPatch): BoardCard => {
  const next = { ...card };
  if (Object.hasOwn(patch, 'text')) updateOptionalString(next, patch, 'text');
  if (Object.hasOwn(patch, 'annotation')) updateOptionalString(next, patch, 'annotation');
  if (Object.hasOwn(patch, 'position') && patch.position) next.position = clone(patch.position);
  if (patch.width !== undefined) next.width = patch.width;
  if (patch.height !== undefined) next.height = patch.height;
  updateOptionalString(next, patch, 'assetId');
  if (Object.hasOwn(patch, 'source')) {
    if (patch.source === null || patch.source === undefined) delete next.source;
    else next.source = clone(patch.source);
  }
  if (Object.hasOwn(patch, 'nodeRef')) {
    if (patch.nodeRef === null || patch.nodeRef === undefined) delete next.nodeRef;
    else next.nodeRef = clone(patch.nodeRef);
  }
  return next;
};

const updateView = (board: BoardDocument, id: string, updater: (view: BoardView) => BoardView): void => {
  const index = itemIndex(board.views, id, 'View');
  board.views[index] = updater(board.views[index]!);
};

const ensureTimelineEntries = (view: BoardView, itemIds: string[]): BoardView => {
  if (view.kind !== 'timeline') return view;
  const timeline = view.timeline ?? { range: { start: 0, end: 1 }, entries: [] };
  const present = new Set(timeline.entries.map((entry) => entry.itemId));
  const missing = itemIds
    .filter((id) => !present.has(id))
    .map((itemId) => ({ itemId, value: null }));
  return {
    ...view,
    axis: view.axis ?? 'unknown',
    timeline: { ...timeline, entries: [...timeline.entries, ...missing] },
  };
};

const allBoardItemIds = (board: BoardDocument): string[] => [
  ...board.nodes.map((node) => node.id),
  ...board.cards.map((card) => card.id),
];

const withRevision = (board: BoardDocument): BoardDocument => ({
  ...board,
  revision: board.revision + 1,
});

/** Applies one local-document operation. Story meaning data is never written here. */
export function applyAtlasCommand(input: BoardDocument, command: AtlasCommand): BoardDocument {
  assertBoardIntegrity(input);
  const board = clone(input);

  switch (command.type) {
    case 'board.rename': {
      if (command.name.trim().length === 0) fail('INVALID_COMMAND', 'Board name must not be empty.');
      board.name = command.name;
      break;
    }
    case 'node.create': {
      if (command.node.origin === 'provider' && !command.node.ref) {
        fail('INVALID_COMMAND', 'A provider board node must keep its provider reference.');
      }
      assertAvailableId(board.nodes, command.node.id, 'Node');
      board.nodes.push(clone(command.node));
      board.views = board.views.map((view) => ensureTimelineEntries(view, allBoardItemIds(board)));
      break;
    }
    case 'node.update': {
      const index = itemIndex(board.nodes, command.id, 'Node');
      board.nodes[index] = applyNodePatch(board.nodes[index]!, command.patch);
      break;
    }
    case 'node.apply-layout': {
      const unique = new Set<string>();
      for (const item of command.positions) {
        if (unique.has(item.id)) fail('INVALID_COMMAND', `Node "${item.id}" appears twice in a layout result.`);
        unique.add(item.id);
        requireNode(board, item.id);
        if (!Number.isFinite(item.position.x) || !Number.isFinite(item.position.y)) {
          fail('INVALID_COMMAND', `Node "${item.id}" has a non-finite layout position.`);
        }
      }
      const positions = new Map(command.positions.map((item) => [item.id, item.position]));
      board.nodes = board.nodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position: clone(position) } : node;
      });
      break;
    }
    case 'node.apply-groups': {
      const assigned = new Set<string>();
      for (const group of command.groups) {
        if (!group.groupId) fail('INVALID_COMMAND', 'Group ID must not be empty.');
        for (const id of group.ids) {
          if (assigned.has(id)) fail('INVALID_COMMAND', `Node "${id}" belongs to more than one component group.`);
          assigned.add(id);
          requireNode(board, id);
        }
      }
      const groupByNode = new Map(command.groups.flatMap((group) => group.ids.map((id) => [id, group.groupId] as const)));
      board.nodes = board.nodes.map((node) => {
        const groupId = groupByNode.get(node.id);
        if (!groupId) return node;
        return { ...node, groupId };
      });
      break;
    }
    case 'node.duplicate': {
      const source = requireNode(board, command.id);
      assertAvailableId(board.nodes, command.newId, 'Node');
      board.nodes.push({
        id: command.newId,
        origin: 'manual',
        kind: source.kind,
        label: `${source.label} copy`,
        position: { x: source.position.x + 32, y: source.position.y + 32 },
        ...(source.annotation === undefined ? {} : { annotation: source.annotation }),
      });
      board.views = board.views.map((view) => ensureTimelineEntries(view, allBoardItemIds(board)));
      break;
    }
    case 'node.delete': {
      const index = itemIndex(board.nodes, command.id, 'Node');
      board.nodes.splice(index, 1);
      board.edges = board.edges.filter((edge) => edge.from !== command.id && edge.to !== command.id);
      board.views = board.views.map((view) => ({
        ...view,
        ...(view.visibleNodeIds ? { visibleNodeIds: view.visibleNodeIds.filter((id) => id !== command.id) } : {}),
        ...(view.pins ? { pins: view.pins.filter((pin) => pin.nodeId !== command.id) } : {}),
        ...(view.timeline
          ? { timeline: { ...view.timeline, entries: view.timeline.entries.filter((entry) => entry.itemId !== command.id) } }
          : {}),
      }));
      break;
    }
    case 'node.group': {
      if (command.ids.length === 0) fail('INVALID_COMMAND', 'Select at least one node to group.');
      const uniqueIds = new Set(command.ids);
      if (uniqueIds.size !== command.ids.length) fail('INVALID_COMMAND', 'A node may appear only once in a group operation.');
      for (const id of uniqueIds) requireNode(board, id);
      board.nodes = board.nodes.map((node) => {
        if (!uniqueIds.has(node.id)) return node;
        const next = { ...node };
        if (command.groupId === null) delete next.groupId;
        else next.groupId = command.groupId;
        return next;
      });
      break;
    }
    case 'edge.create': {
      if (command.edge.meaning !== 'visual') {
        fail('SEMANTIC_EDGE_READONLY', 'Atlas may create visual edges; semantic edges belong to their source provider.');
      }
      assertAvailableId(board.edges, command.edge.id, 'Edge');
      requireNode(board, command.edge.from);
      requireNode(board, command.edge.to);
      board.edges.push(clone(command.edge));
      break;
    }
    case 'edge.delete': {
      const index = itemIndex(board.edges, command.id, 'Edge');
      if (board.edges[index]!.meaning === 'semantic') {
        fail('SEMANTIC_EDGE_READONLY', 'Semantic edges are read-only in Atlas.');
      }
      board.edges.splice(index, 1);
      break;
    }
    case 'edge.update': {
      const index = itemIndex(board.edges, command.id, 'Edge');
      if (board.edges[index]!.meaning === 'semantic') {
        fail('SEMANTIC_EDGE_READONLY', 'Semantic edges are read-only in Atlas.');
      }
      const edge = { ...board.edges[index]! };
      updateOptionalString(edge, command.patch, 'label');
      board.edges[index] = edge;
      break;
    }
    case 'graph.delete-selection': {
      const uniqueNodes = new Set(command.nodeIds);
      const uniqueEdges = new Set(command.edgeIds);
      if (uniqueNodes.size !== command.nodeIds.length || uniqueEdges.size !== command.edgeIds.length) {
        fail('INVALID_COMMAND', 'A selection may not contain duplicate node or edge IDs.');
      }
      for (const id of uniqueNodes) requireNode(board, id);
      for (const id of uniqueEdges) {
        const edge = board.edges[itemIndex(board.edges, id, 'Edge')]!;
        if (edge.meaning === 'semantic') fail('SEMANTIC_EDGE_READONLY', 'Semantic edges are read-only in Atlas.');
      }
      board.nodes = board.nodes.filter((node) => !uniqueNodes.has(node.id));
      board.edges = board.edges.filter((edge) =>
        !uniqueEdges.has(edge.id) && !uniqueNodes.has(edge.from) && !uniqueNodes.has(edge.to));
      board.views = board.views.map((view) => ({
        ...view,
        ...(view.visibleNodeIds ? { visibleNodeIds: view.visibleNodeIds.filter((id) => !uniqueNodes.has(id)) } : {}),
        ...(view.pins ? { pins: view.pins.filter((pin) => !uniqueNodes.has(pin.nodeId)) } : {}),
        ...(view.timeline
          ? { timeline: { ...view.timeline, entries: view.timeline.entries.filter((entry) => !uniqueNodes.has(entry.itemId)) } }
          : {}),
      }));
      break;
    }
    case 'card.create': {
      assertAvailableId(board.cards, command.card.id, 'Card');
      board.cards.push(clone(command.card));
      if (command.asset) {
        assertAvailableId(board.assets, command.asset.id, 'Asset');
        board.assets.push(clone(command.asset));
      }
      board.views = board.views.map((view) => {
        if (view.kind === 'board') {
          let lanes = view.lanes ?? (view.laneIds ?? []).map((id) => ({ id, label: id, cardIds: [] }));
          if (lanes.length === 0) lanes = [{ id: 'lane-unassigned', label: 'Unassigned', cardIds: [] }];
          const unassignedIndex = lanes.findIndex((lane) => lane.id === 'lane-unassigned');
          const laneIndex = unassignedIndex >= 0 ? unassignedIndex : 0;
          const updatedLanes = lanes.map((lane) => ({ ...lane, cardIds: [...lane.cardIds] }));
          updatedLanes[laneIndex]!.cardIds.push(command.card.id);
          return { ...view, lanes: updatedLanes, laneIds: updatedLanes.map((lane) => lane.id) };
        }
        if (view.kind === 'storyboard') return { ...view, cardOrder: [...(view.cardOrder ?? []), command.card.id] };
        return ensureTimelineEntries(view, allBoardItemIds(board));
      });
      break;
    }
    case 'card.update': {
      const index = itemIndex(board.cards, command.id, 'Card');
      board.cards[index] = applyCardPatch(board.cards[index]!, command.patch);
      break;
    }
    case 'card.duplicate': {
      const source = requireCard(board, command.id);
      assertAvailableId(board.cards, command.newId, 'Card');
      const duplicate = clone(source);
      duplicate.id = command.newId;
      duplicate.position = { x: source.position.x + 32, y: source.position.y + 32 };
      board.cards.push(duplicate);
      board.views = board.views.map((view) => {
        if (view.kind === 'board') {
          let lanes = view.lanes ?? (view.laneIds ?? []).map((id) => ({ id, label: id, cardIds: [] }));
          if (lanes.length === 0) lanes = [{ id: 'lane-unassigned', label: 'Unassigned', cardIds: [] }];
          const sourceLane = lanes.find((lane) => lane.cardIds.includes(command.id)) ?? lanes[0]!;
          const updatedLanes = lanes.map((lane) => ({ ...lane, cardIds: [...lane.cardIds] }));
          const lane = updatedLanes.find((entry) => entry.id === sourceLane.id)!;
          lane.cardIds.splice(lane.cardIds.indexOf(command.id) + 1, 0, command.newId);
          return { ...view, lanes: updatedLanes, laneIds: updatedLanes.map((entry) => entry.id) };
        }
        if (view.kind === 'storyboard') {
          const cardOrder = [...(view.cardOrder ?? [])];
          const sourceIndex = cardOrder.indexOf(command.id);
          if (sourceIndex >= 0) cardOrder.splice(sourceIndex + 1, 0, command.newId);
          else cardOrder.push(command.newId);
          return { ...view, cardOrder };
        }
        return ensureTimelineEntries(view, allBoardItemIds(board));
      });
      break;
    }
    case 'card.delete': {
      const index = itemIndex(board.cards, command.id, 'Card');
      const assetId = board.cards[index]!.assetId;
      board.cards.splice(index, 1);
      if (assetId && !board.cards.some((card) => card.assetId === assetId)) {
        board.assets = board.assets.filter((asset) => asset.id !== assetId);
      }
      board.views = board.views.map((view) => ({
        ...view,
        ...(view.cardOrder ? { cardOrder: view.cardOrder.filter((id) => id !== command.id) } : {}),
        ...(view.lanes
          ? { lanes: view.lanes.map((lane) => ({ ...lane, cardIds: lane.cardIds.filter((id) => id !== command.id) })) }
          : {}),
        ...(view.timeline
          ? { timeline: { ...view.timeline, entries: view.timeline.entries.filter((entry) => entry.itemId !== command.id) } }
          : {}),
      }));
      break;
    }
    case 'view.create': {
      assertAvailableId(board.views, command.view.id, 'View');
      board.views.push(ensureTimelineEntries(clone(command.view), allBoardItemIds(board)));
      break;
    }
    case 'view.update': {
      updateView(board, command.id, (view) => ({ ...view, ...clone(command.patch) }));
      break;
    }
    case 'view.delete': {
      const index = itemIndex(board.views, command.id, 'View');
      if (board.views.length <= 1) fail('LAST_VIEW', 'A board must keep at least one view.');
      board.views.splice(index, 1);
      break;
    }
    case 'view.move-node': {
      const node = requireNode(board, command.nodeId);
      const updatedNode = { ...node, position: clone(command.position) };
      board.nodes[board.nodes.findIndex((candidate) => candidate.id === node.id)] = updatedNode;
      updateView(board, command.viewId, (view) => {
        const pins = view.pins ?? [];
        const existing = pins.findIndex((pin) => pin.nodeId === command.nodeId);
        if (!command.pin) {
          if (existing < 0) return view;
          return { ...view, pins: pins.filter((pin) => pin.nodeId !== command.nodeId) };
        }
        const nextPin = { nodeId: command.nodeId, ...command.position, mode: 'manual' as const };
        return {
          ...view,
          pins: existing < 0 ? [...pins, nextPin] : pins.map((pin, index) => (index === existing ? nextPin : pin)),
        };
      });
      break;
    }
    case 'view.move-nodes': {
      const seen = new Set<string>();
      const positions = new Map<string, Position>();
      for (const item of command.positions) {
        if (seen.has(item.nodeId)) fail('INVALID_COMMAND', `Node "${item.nodeId}" appears twice in a move operation.`);
        seen.add(item.nodeId);
        requireNode(board, item.nodeId);
        if (!Number.isFinite(item.position.x) || !Number.isFinite(item.position.y)) fail('INVALID_COMMAND', 'Node positions must be finite.');
        positions.set(item.nodeId, item.position);
      }
      board.nodes = board.nodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position: clone(position) } : node;
      });
      updateView(board, command.viewId, (view) => {
        const currentPins = view.pins ?? [];
        const byNode = new Map(currentPins.map((pin) => [pin.nodeId, pin]));
        for (const [nodeId, position] of positions) {
          if (command.pin) byNode.set(nodeId, { nodeId, ...position, mode: 'manual' });
          else byNode.delete(nodeId);
        }
        const pins = [...byNode.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
        return { ...view, pins };
      });
      break;
    }
    case 'view.unpin-node': {
      updateView(board, command.viewId, (view) => ({
        ...view,
        pins: (view.pins ?? []).filter((pin) => pin.nodeId !== command.nodeId),
      }));
      break;
    }
    case 'view.assign-card': {
      requireCard(board, command.cardId);
      updateView(board, command.viewId, (view) => {
        if (view.kind !== 'board') fail('INVALID_COMMAND', 'Cards can only be assigned to a board view.');
        const lanes = view.lanes ?? (view.laneIds ?? []).map((id) => ({ id, label: id, cardIds: [] }));
        const laneIndex = lanes.findIndex((lane) => lane.id === command.laneId);
        if (laneIndex < 0) fail('ITEM_NOT_FOUND', `Lane \"${command.laneId}\" does not exist.`);
        const updated = lanes.map((lane) => ({
          ...lane,
          cardIds: lane.cardIds.filter((id) => id !== command.cardId),
        }));
        const lane = updated[laneIndex]!;
        const index = command.index === undefined
          ? lane.cardIds.length
          : Math.max(0, Math.min(command.index, lane.cardIds.length));
        lane.cardIds.splice(index, 0, command.cardId);
        return { ...view, lanes: updated, laneIds: updated.map((lane) => lane.id) };
      });
      break;
    }
    case 'view.set-lanes': {
      const laneIds = new Set<string>();
      const cardIds = new Set<string>();
      for (const lane of command.lanes) {
        if (laneIds.has(lane.id)) fail('INVALID_COMMAND', `Lane \"${lane.id}\" is duplicated.`);
        assertAvailableId([], lane.id, 'Lane');
        laneIds.add(lane.id);
        for (const cardId of lane.cardIds) {
          requireCard(board, cardId);
          if (cardIds.has(cardId)) fail('INVALID_COMMAND', `Card \"${cardId}\" belongs to more than one lane.`);
          cardIds.add(cardId);
        }
      }
      updateView(board, command.viewId, (view) => {
        if (view.kind !== 'board') fail('INVALID_COMMAND', 'Lanes can only be changed in a board view.');
        const lanes = clone(command.lanes);
        return { ...view, lanes, laneIds: lanes.map((lane) => lane.id) };
      });
      break;
    }
    case 'view.reorder-cards': {
      const uniqueIds = new Set(command.cardIds);
      if (uniqueIds.size !== command.cardIds.length) fail('INVALID_COMMAND', 'Storyboard order contains duplicate cards.');
      for (const id of uniqueIds) requireCard(board, id);
      updateView(board, command.viewId, (view) => {
        if (view.kind !== 'storyboard') fail('INVALID_COMMAND', 'Card order can only be changed in a storyboard view.');
        return { ...view, cardOrder: [...command.cardIds] };
      });
      break;
    }
    case 'view.timeline': {
      if (
        !Number.isFinite(command.range.start) ||
        !Number.isFinite(command.range.end) ||
        command.range.end < command.range.start
      ) {
        fail('INVALID_COMMAND', 'Timeline range must be finite and end at or after start.');
      }
      const itemIds = new Set(allBoardItemIds(board));
      const entryIds = new Set<string>();
      for (const entry of command.entries) {
        if (!itemIds.has(entry.itemId)) fail('ITEM_NOT_FOUND', `Timeline item \"${entry.itemId}\" does not exist.`);
        if (entryIds.has(entry.itemId)) fail('INVALID_COMMAND', `Timeline item \"${entry.itemId}\" is duplicated.`);
        if (entry.value !== null && !Number.isFinite(entry.value)) fail('INVALID_COMMAND', 'Timeline values must be finite numbers or unknown.');
        entryIds.add(entry.itemId);
      }
      const entries = [
        ...clone(command.entries),
        ...[...itemIds].filter((id) => !entryIds.has(id)).map((itemId) => ({ itemId, value: null })),
      ];
      const currentView = requireView(board, command.viewId);
      if (currentView.kind !== 'timeline') fail('INVALID_COMMAND', 'Timeline values can only be changed in a timeline view.');
      if (currentView.axis !== command.axis && entries.some((entry) => entry.value !== null)) {
        fail('INVALID_COMMAND', 'Changing timeline axis requires clearing values to unknown first.');
      }
      updateView(board, command.viewId, (view) => {
        if (view.kind !== 'timeline') fail('INVALID_COMMAND', 'Timeline values can only be changed in a timeline view.');
        return {
          ...view,
          axis: command.axis,
          timeline: { range: clone(command.range), entries },
        };
      });
      break;
    }
    case 'view.filter': {
      updateView(board, command.viewId, (view) => {
        const next = { ...view };
        if (command.filter === null) delete next.filter;
        else next.filter = clone(command.filter);
        return next;
      });
      break;
    }
    case 'view.viewport': {
      updateView(board, command.viewId, (view) => ({ ...view, viewport: clone(command.viewport) }));
      break;
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }

  if (JSON.stringify(board) === JSON.stringify(input)) return input;
  const result = withRevision(board);
  assertBoardIntegrity(result);
  return result;
}

export function createAtlasId(prefix: string): string {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,31}$/.test(prefix)) fail('INVALID_COMMAND', 'ID prefix is invalid.');
  const id = `${prefix}-${crypto.randomUUID()}`;
  if (id.length > 128) fail('INVALID_COMMAND', 'Generated ID is too long.');
  return id;
}

export function createEmptyAtlasBoard(name = 'New Atlas board'): BoardDocument {
  const defaultViewport = (): Viewport => ({ x: 0, y: 0, zoom: 1 });
  const board: BoardDocument = {
    schema: 'atlas.board/v1',
    boardId: crypto.randomUUID(),
    name,
    revision: 0,
    views: [
      { id: createAtlasId('view'), kind: 'graph', name: 'Graph', viewport: defaultViewport(), pins: [] },
      { id: createAtlasId('view'), kind: 'freeform', name: 'Canvas', viewport: defaultViewport() },
      {
        id: createAtlasId('view'),
        kind: 'board',
        name: 'Board',
        viewport: defaultViewport(),
        laneIds: ['lane-unassigned', 'lane-todo', 'lane-doing', 'lane-done'],
        cardOrder: [],
        lanes: [
          { id: 'lane-unassigned', label: 'Unassigned', cardIds: [] },
          { id: 'lane-todo', label: 'To do', cardIds: [] },
          { id: 'lane-doing', label: 'In progress', cardIds: [] },
          { id: 'lane-done', label: 'Done', cardIds: [] },
        ],
      },
      {
        id: createAtlasId('view'),
        kind: 'timeline',
        name: 'Timeline',
        viewport: defaultViewport(),
        axis: 'generic.time',
        timeline: { range: { start: 0, end: 1 }, entries: [] },
      },
      { id: createAtlasId('view'), kind: 'storyboard', name: 'Storyboard', viewport: defaultViewport(), cardOrder: [] },
    ],
    nodes: [],
    edges: [],
    cards: [],
    assets: [],
  };
  assertBoardIntegrity(board);
  return board;
}

/** Local undo/redo history. Restored documents get fresh monotonic board revisions. */
export class AtlasCommandHistory {
  #past: BoardDocument[] = [];
  #future: BoardDocument[] = [];
  #present: BoardDocument;

  constructor(initial: BoardDocument) {
    assertBoardIntegrity(initial);
    this.#present = clone(initial);
  }

  get current(): BoardDocument {
    return this.#present;
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  dispatch(command: AtlasCommand): BoardDocument {
    const next = applyAtlasCommand(this.#present, command);
    if (next === this.#present) return this.#present;
    this.#past.push(this.#present);
    this.#future = [];
    this.#present = next;
    return next;
  }

  /** Records a board returned by a controlled editor callback as one undoable action. */
  accept(board: BoardDocument): BoardDocument {
    assertBoardIntegrity(board);
    if (JSON.stringify(board) === JSON.stringify(this.#present)) return this.#present;
    this.#past.push(this.#present);
    this.#future = [];
    this.#present = { ...clone(board), revision: Math.max(board.revision, this.#present.revision + 1) };
    assertBoardIntegrity(this.#present);
    return this.#present;
  }

  undo(): BoardDocument {
    const previous = this.#past.pop();
    if (!previous) return this.#present;
    this.#future.push(this.#present);
    this.#present = { ...clone(previous), revision: this.#present.revision + 1 };
    return this.#present;
  }

  redo(): BoardDocument {
    const next = this.#future.pop();
    if (!next) return this.#present;
    this.#past.push(this.#present);
    this.#present = { ...clone(next), revision: this.#present.revision + 1 };
    return this.#present;
  }

  replaceFromHost(board: BoardDocument): void {
    assertBoardIntegrity(board);
    this.#past = [];
    this.#future = [];
    this.#present = clone(board);
  }
}
