import { describe, expect, it } from 'vitest';
import type { NodeChange } from '@xyflow/react';
import { applyNodeSelectionChanges, applyPositionChanges, sameIdOrder } from './graph-state.js';

describe('GraphCanvas state updates', () => {
  it('keeps position state when ReactFlow reports dimension-only or unchanged positions', () => {
    const current = { a: { x: 10, y: 20 } };
    const changes: NodeChange[] = [
      { id: 'a', type: 'dimensions', dimensions: { width: 180, height: 52 } },
      { id: 'a', type: 'position', position: { x: 10, y: 20 }, dragging: true },
      { id: 'missing', type: 'position', position: { x: 30, y: 40 }, dragging: false },
    ];

    expect(applyPositionChanges(current, changes)).toBe(current);
  });

  it('copies positions only for a real move and removes the transient position at drag end', () => {
    const current = { a: { x: 10, y: 20 } };
    const moved = applyPositionChanges(current, [
      { id: 'a', type: 'position', position: { x: 15, y: 25 }, dragging: true },
    ]);

    expect(moved).not.toBe(current);
    expect(moved).toEqual({ a: { x: 15, y: 25 } });
    expect(current).toEqual({ a: { x: 10, y: 20 } });
    expect(applyPositionChanges(moved, [
      { id: 'a', type: 'position', position: { x: 15, y: 25 }, dragging: false },
    ])).toEqual({});
  });

  it('preserves selection state for unrelated batches and keeps selected ID order stable', () => {
    const current = ['a', 'b'];
    expect(applyNodeSelectionChanges(current, [
      { id: 'a', type: 'dimensions', dimensions: { width: 180, height: 52 } },
    ])).toBe(current);
    expect(applyNodeSelectionChanges(current, [{ id: 'b', type: 'select', selected: true }])).toBe(current);
    expect(sameIdOrder(current, [{ id: 'a' }, { id: 'b' }])).toBe(true);
    expect(sameIdOrder(current, [{ id: 'b' }, { id: 'a' }])).toBe(false);
  });

  it('updates selection only when a select/remove change alters the IDs', () => {
    const current = ['a'];
    const added = applyNodeSelectionChanges(current, [{ id: 'b', type: 'select', selected: true }]);

    expect(added).toEqual(['a', 'b']);
    expect(added).not.toBe(current);
    expect(applyNodeSelectionChanges(added, [
      { id: 'b', type: 'remove' },
      { id: 'missing', type: 'remove' },
    ])).toEqual(['a']);
  });
});
