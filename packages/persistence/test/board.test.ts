import { describe, expect, it } from 'vitest';
import type { BoardDocument } from '@scriptorium-atlas/contracts';
import { serializeBoard } from '../src/board.js';

function board(): BoardDocument {
  return {
    schema: 'atlas.board/v1',
    boardId: 'board-test',
    name: 'Test Board',
    revision: 1,
    views: [],
    nodes: [],
    edges: [],
    cards: [],
    assets: [],
    extensions: { vendor: { retained: true } }
  };
}

describe('deterministic Board serialization', () => {
  it('preserves exact original bytes when the semantic board is unchanged', () => {
    const value = board();
    const exactOriginal = `\uFEFF{ "name": "Test Board", "schema": "atlas.board/v1", "boardId": "board-test", "revision": 1, "views": [], "nodes": [], "edges": [], "cards": [], "assets": [], "extensions": { "vendor": { "retained": true } } }\r\n`;
    expect(serializeBoard(value, { board: value, content: exactOriginal })).toBe(exactOriginal);
  });

  it('emits canonical key order after a semantic edit and retains extension data', () => {
    const original = board();
    const edited = { ...original, name: 'Edited Board' };
    const result = serializeBoard(edited, { board: original, content: JSON.stringify(original) });
    expect(result).toBe(`${JSON.stringify({
      assets: [],
      boardId: 'board-test',
      cards: [],
      edges: [],
      extensions: { vendor: { retained: true } },
      name: 'Edited Board',
      nodes: [],
      revision: 1,
      schema: 'atlas.board/v1',
      views: []
    })}\n`);
  });
});
