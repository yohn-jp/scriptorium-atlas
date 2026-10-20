import { assertBoardIntegrity, type BoardDocument } from '@scriptorium-atlas/contracts';
import { compareStrings, stableJson } from './bytes.js';

/**
 * Serialize an Atlas Board using the v1 stable ordering rules.
 *
 * Entity collections are keyed by ID and therefore sort by ID. Collections
 * that express user order (cardOrder, laneIds, and lane.cardIds) keep their
 * supplied order. A semantically unchanged Board returns the exact original
 * string, including whitespace, key order, and a UTF-8 BOM if present.
 */
export function serializeBoard(
  board: BoardDocument,
  original?: { board: BoardDocument; content: string }
): string {
  assertBoardIntegrity(board);
  const canonicalBoard = canonicalizeBoard(board);

  if (original && isSameOriginal(board, original)) return original.content;
  return `${stableJson(canonicalBoard)}\n`;
}

function isSameOriginal(board: BoardDocument, original: { board: BoardDocument; content: string }): boolean {
  assertBoardIntegrity(original.board);
  let parsed: unknown;
  try {
    parsed = JSON.parse(original.content.replace(/^\uFEFF/u, '')) as unknown;
  } catch {
    return false;
  }
  try {
    assertBoardIntegrity(parsed);
  } catch {
    return false;
  }

  const parsedJson = stableJson(canonicalizeBoard(parsed));
  const providedOriginalJson = stableJson(canonicalizeBoard(original.board));
  const editedJson = stableJson(canonicalizeBoard(board));
  return parsedJson === providedOriginalJson && parsedJson === editedJson;
}

function canonicalizeBoard(board: BoardDocument): BoardDocument {
  return {
    ...canonicalizeObject(board),
    views: [...board.views]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map(view => ({
        ...canonicalizeObject(view),
        ...(view.pins ? { pins: [...view.pins].sort((left, right) => compareStrings(left.nodeId, right.nodeId)).map(canonicalizeObject) } : {}),
        ...(view.visibleNodeIds ? { visibleNodeIds: [...view.visibleNodeIds].sort(compareStrings) } : {}),
        ...(view.lanes
          ? {
              lanes: [...view.lanes]
                .sort((left, right) => compareStrings(left.id, right.id))
                .map(lane => canonicalizeObject(lane))
            }
          : {}),
        ...(view.timeline
          ? {
              timeline: {
                ...canonicalizeObject(view.timeline),
                entries: [...view.timeline.entries]
                  .sort((left, right) => compareStrings(left.itemId, right.itemId))
                  .map(canonicalizeObject)
              }
            }
          : {}),
        ...(view.filter
          ? {
              filter: {
                ...canonicalizeObject(view.filter),
                ...(view.filter.kinds ? { kinds: [...view.filter.kinds].sort(compareStrings) } : {}),
                ...(view.filter.providers ? { providers: [...view.filter.providers].sort(compareStrings) } : {})
              }
            }
          : {})
      })),
    nodes: [...board.nodes].sort((left, right) => compareStrings(left.id, right.id)).map(canonicalizeObject),
    edges: [...board.edges].sort((left, right) => compareStrings(left.id, right.id)).map(canonicalizeObject),
    cards: [...board.cards].sort((left, right) => compareStrings(left.id, right.id)).map(canonicalizeObject),
    assets: [...board.assets].sort((left, right) => compareStrings(left.id, right.id)).map(canonicalizeObject)
  } as BoardDocument;
}

function canonicalizeObject<T extends object>(value: T): T {
  if (Array.isArray(value)) return value.map(item => canonicalizeUnknown(item)) as T;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = canonicalizeUnknown(child);
  }
  return result as T;
}

function canonicalizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeUnknown);
  if (value && typeof value === 'object') return canonicalizeObject(value);
  return value;
}
