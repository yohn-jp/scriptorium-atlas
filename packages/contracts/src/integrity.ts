import type { BoardDocument } from './generated/types.js';
import { validateBoard } from './generated/validators.js';
import { assertContract } from './validation.js';

export class BoardIntegrityError extends TypeError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Atlas board relationships: ${issues.join('; ')}`);
    this.name = 'BoardIntegrityError';
    this.issues = issues;
  }
}

export function validateBoardIntegrity(value: unknown): value is BoardDocument {
  if (!validateBoard(value)) return false;
  return boardIssues(value).length === 0;
}

export function assertBoardIntegrity(value: unknown): asserts value is BoardDocument {
  assertContract('board', value);
  const issues = boardIssues(value);
  if (issues.length) throw new BoardIntegrityError(issues);
}

function boardIssues(board: BoardDocument): string[] {
  const issues: string[] = [];
  const ensureUnique = (values: readonly string[], label: string): Set<string> => {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) issues.push(`duplicate ${label}: ${value}`);
      seen.add(value);
    }
    return seen;
  };
  const viewIds = ensureUnique(board.views.map(({ id }) => id), 'view id');
  const nodeIds = ensureUnique(board.nodes.map(({ id }) => id), 'node id');
  const edgeIds = ensureUnique(board.edges.map(({ id }) => id), 'edge id');
  const cardIds = ensureUnique(board.cards.map(({ id }) => id), 'card id');
  ensureUnique(board.assets.map(({ id }) => id), 'asset id');
  void viewIds;
  void edgeIds;

  const providerRefs = new Set<string>();
  for (const node of board.nodes) {
    if (node.origin === 'provider' && !node.ref) issues.push(`provider node ${node.id} has no NodeRef`);
    if (node.ref) {
      const ref = JSON.stringify([node.ref.providerId, node.ref.localId]);
      if (providerRefs.has(ref)) issues.push(`duplicate provider NodeRef: ${ref}`);
      providerRefs.add(ref);
    }
  }
  for (const edge of board.edges) {
    if (!nodeIds.has(edge.from)) issues.push(`edge ${edge.id} has missing from node ${edge.from}`);
    if (!nodeIds.has(edge.to)) issues.push(`edge ${edge.id} has missing to node ${edge.to}`);
  }

  for (const view of board.views) {
    const orderedLanes = ensureUnique(view.laneIds ?? [], `view ${view.id} lane order`);
    if (view.laneIds?.length && !view.lanes) issues.push(`view ${view.id} orders lanes without lane definitions`);
    for (const pin of view.pins ?? []) {
      if (!nodeIds.has(pin.nodeId)) issues.push(`view ${view.id} pin references missing node ${pin.nodeId}`);
    }
    for (const nodeId of view.visibleNodeIds ?? []) {
      if (!nodeIds.has(nodeId)) issues.push(`view ${view.id} references missing node ${nodeId}`);
    }
    if (view.cardOrder) {
      const ordered = ensureUnique(view.cardOrder, `view ${view.id} card order`);
      for (const cardId of ordered) if (!cardIds.has(cardId)) issues.push(`view ${view.id} references missing card ${cardId}`);
    }
    if (view.lanes) {
      const lanes = ensureUnique(view.lanes.map(({ id }) => id), `view ${view.id} lane id`);
      const assignedCards = new Set<string>();
      for (const lane of view.lanes) {
        const assigned = ensureUnique(lane.cardIds, `view ${view.id} lane ${lane.id} card assignment`);
        for (const cardId of assigned) {
          if (!cardIds.has(cardId)) issues.push(`lane ${lane.id} references missing card ${cardId}`);
          if (assignedCards.has(cardId)) issues.push(`card ${cardId} is assigned to multiple lanes`);
          assignedCards.add(cardId);
        }
      }
      for (const laneId of orderedLanes) if (!lanes.has(laneId)) issues.push(`view ${view.id} orders missing lane ${laneId}`);
    }
    if (view.timeline) {
      const { range, entries } = view.timeline;
      if (range.start > range.end) issues.push(`view ${view.id} timeline range starts after it ends`);
      const itemIds = ensureUnique(entries.map(({ itemId }) => itemId), `view ${view.id} timeline item`);
      for (const itemId of itemIds) {
        if (!nodeIds.has(itemId) && !cardIds.has(itemId)) issues.push(`view ${view.id} timeline references missing item ${itemId}`);
      }
      for (const entry of entries) {
        if (entry.value !== null && !Number.isFinite(entry.value)) issues.push(`view ${view.id} timeline has a non-finite value`);
      }
    }
  }
  return issues;
}
