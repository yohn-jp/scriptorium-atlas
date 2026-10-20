import { describe, expect, it } from 'vitest';
import type { BoardDocument, BoardNode } from '@scriptorium-atlas/contracts';
import { assertBoardIntegrity } from '@scriptorium-atlas/contracts';
import { applyAtlasCommand, AtlasCommandError, AtlasCommandHistory, createEmptyAtlasBoard, isBoardKanbanView, orderedBoardLanes } from './model.js';

const manualNode = (id: string, label: string): BoardNode => ({
  id,
  origin: 'manual',
  kind: 'generic.note',
  label,
  position: { x: 10, y: 20 },
});

type BoardKanbanView = BoardDocument['views'][number] & { kind: 'board' };

describe('Atlas document commands', () => {
  it('keeps Board, Kanban, storyboard and unknown timeline data valid through edits', () => {
    const board = createEmptyAtlasBoard('Research');
    const cardId = 'card-research';
    const withCard = applyAtlasCommand(board, {
      type: 'card.create',
      card: {
        id: cardId,
        kind: 'text',
        position: { x: 40, y: 50 },
        width: 280,
        height: 160,
        text: 'Compare the two approaches',
      },
    });

    const boardView = withCard.views.find((view) => view.kind === 'board')!;
    expect(boardView.lanes?.find((lane) => lane.id === 'lane-unassigned')?.cardIds).toContain(cardId);
    expect(withCard.views.find((view) => view.kind === 'storyboard')?.cardOrder).toContain(cardId);
    expect(withCard.views.find((view) => view.kind === 'timeline')?.timeline?.entries).toContainEqual({ itemId: cardId, value: null });

    const moved = applyAtlasCommand(withCard, {
      type: 'view.assign-card',
      viewId: boardView.id,
      laneId: 'lane-doing',
      cardId,
    });
    const movedBoard = moved.views.find((view) => view.id === boardView.id)!;
    expect(movedBoard.lanes?.find((lane) => lane.id === 'lane-doing')?.cardIds).toEqual([cardId]);
    assertBoardIntegrity(moved);
  });

  it('uses laneIds as display order when canonical storage sorts lane records', () => {
    let board = createEmptyAtlasBoard('Ordered lanes');
    const orderedCardId = 'card-ordered';
    board = applyAtlasCommand(board, {
      type: 'card.create',
      card: { id: orderedCardId, kind: 'text', position: { x: 0, y: 0 }, width: 180, height: 120, text: 'Ordered' },
    });
    const boardView = board.views.find(isBoardKanbanView)!;
    const expectedLaneIds = [...boardView.laneIds!];
    board = {
      ...board,
      views: board.views.map((view) => view.id === boardView.id && view.kind === 'board'
        ? { ...view, lanes: [...view.lanes!].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0) }
        : view),
    };
    const reloadedView = board.views.find((view): view is BoardKanbanView => view.id === boardView.id && view.kind === 'board')!;
    expect(orderedBoardLanes(reloadedView).map((lane) => lane.id)).toEqual(expectedLaneIds);

    board = applyAtlasCommand(board, {
      type: 'view.assign-card',
      viewId: boardView.id,
      laneId: 'lane-doing',
      cardId: orderedCardId,
    });
    const afterAssignment = board.views.find((view): view is BoardKanbanView => view.id === boardView.id && view.kind === 'board')!;
    expect(afterAssignment.laneIds).toEqual(expectedLaneIds);
    expect(orderedBoardLanes(afterAssignment).map((lane) => lane.id)).toEqual(expectedLaneIds);

    board = applyAtlasCommand(board, {
      type: 'view.set-lanes',
      viewId: boardView.id,
      lanes: [...orderedBoardLanes(afterAssignment)].reverse(),
    });
    const reordered = board.views.find((view): view is BoardKanbanView => view.id === boardView.id && view.kind === 'board')!;
    expect(reordered.laneIds).toEqual([...expectedLaneIds].reverse());

    board = {
      ...board,
      views: board.views.map((view) => view.id === boardView.id && view.kind === 'board'
        ? { ...view, lanes: [...view.lanes!].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0) }
        : view),
    };
    const afterReload = board.views.find((view): view is BoardKanbanView => view.id === boardView.id && view.kind === 'board')!;
    const cardId = 'card-after-reload';
    board = applyAtlasCommand(board, {
      type: 'card.create',
      card: { id: cardId, kind: 'text', position: { x: 0, y: 0 }, width: 180, height: 120, text: 'After reload' },
    });
    const afterCreate = board.views.find((view): view is BoardKanbanView => view.id === boardView.id && view.kind === 'board')!;
    expect(afterCreate.laneIds).toEqual(afterReload.laneIds);
    expect(orderedBoardLanes(afterCreate).map((lane) => lane.id)).toEqual(afterReload.laneIds);
    expect(afterCreate.lanes?.find((lane) => lane.id === 'lane-unassigned')?.cardIds).toContain(cardId);
    assertBoardIntegrity(board);
  });

  it('records node moves as view pins and keeps undo/redo revisions monotonic', () => {
    const initial = applyAtlasCommand(createEmptyAtlasBoard(), {
      type: 'node.create',
      node: manualNode('node-a', 'A'),
    });
    const graphView = initial.views.find((view) => view.kind === 'graph')!;
    const history = new AtlasCommandHistory(initial);
    history.dispatch({
      type: 'view.move-node',
      viewId: graphView.id,
      nodeId: 'node-a',
      position: { x: 140, y: 220 },
      pin: true,
    });
    const movedRevision = history.current.revision;
    expect(history.current.views.find((view) => view.id === graphView.id)?.pins?.[0]).toMatchObject({
      nodeId: 'node-a',
      x: 140,
      y: 220,
      mode: 'manual',
    });

    const undone = history.undo();
    const redone = history.redo();
    expect(undone.revision).toBeGreaterThan(movedRevision);
    expect(redone.revision).toBeGreaterThan(undone.revision);
    expect(redone.views.find((view) => view.id === graphView.id)?.pins).toHaveLength(1);
    assertBoardIntegrity(redone);
  });

  it('keeps provider labels and semantic edges under their source owner', () => {
    const board = createEmptyAtlasBoard();
    const providerNode: BoardNode = {
      id: 'provider-alice',
      origin: 'provider',
      kind: 'story.character',
      label: 'Alice',
      ref: { providerId: 'scriptorium.story-knowledge', localId: 'alice' },
      position: { x: 0, y: 0 },
    };
    const manual = manualNode('manual-note', 'Note');
    const withNodes = applyAtlasCommand(applyAtlasCommand(board, { type: 'node.create', node: providerNode }), {
      type: 'node.create',
      node: manual,
    });

    expect(() => applyAtlasCommand(withNodes, {
      type: 'node.update',
      id: providerNode.id,
      patch: { label: 'Renamed' },
    })).toThrowError(AtlasCommandError);

    const withSemanticEdge = {
      ...withNodes,
      edges: [{
        id: 'edge-semantic',
        from: providerNode.id,
        to: manual.id,
        meaning: 'semantic' as const,
        ref: { providerId: 'scriptorium.story-knowledge', localId: 'relation-1' },
      }],
    };
    expect(() => applyAtlasCommand(withSemanticEdge, { type: 'edge.delete', id: 'edge-semantic' }))
      .toThrowError(AtlasCommandError);
  });

  it('creates and edits visual edge labels while keeping semantic edges read-only', () => {
    let board = createEmptyAtlasBoard();
    board = applyAtlasCommand(board, { type: 'node.create', node: manualNode('left', 'Left') });
    board = applyAtlasCommand(board, { type: 'node.create', node: manualNode('right', 'Right') });
    board = applyAtlasCommand(board, { type: 'edge.create', edge: { id: 'visual-edge', from: 'left', to: 'right', meaning: 'visual' } });
    board = applyAtlasCommand(board, { type: 'edge.update', id: 'visual-edge', patch: { label: 'points to' } });
    expect(board.edges[0]).toMatchObject({ meaning: 'visual', label: 'points to' });
    expect(applyAtlasCommand(board, { type: 'edge.update', id: 'visual-edge', patch: { label: null } }).edges[0]?.label).toBeUndefined();
  });
});
