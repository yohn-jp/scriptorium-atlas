import type { Node, NodeChange } from '@xyflow/react';

export function applyPositionChanges<NodeData extends Node>(
  current: Record<string, { x: number; y: number }>,
  changes: readonly NodeChange<NodeData>[],
): Record<string, { x: number; y: number }> {
  let next: Record<string, { x: number; y: number }> | null = null;
  for (const change of changes) {
    if (change.type !== 'position' || !change.position) continue;
    const positions = next ?? current;
    const existing = positions[change.id];
    if (change.dragging === false) {
      if (!Object.hasOwn(positions, change.id)) continue;
      next ??= { ...current };
      delete next[change.id];
      continue;
    }
    if (existing?.x === change.position.x && existing.y === change.position.y) continue;
    next ??= { ...current };
    next[change.id] = change.position;
  }
  return next ?? current;
}

export function applyNodeSelectionChanges<NodeData extends Node>(
  current: string[],
  changes: readonly NodeChange<NodeData>[],
): string[] {
  let next = current;
  for (const change of changes) {
    if (change.type === 'select') {
      const present = next.includes(change.id);
      if (change.selected && !present) next = [...next, change.id];
      else if (!change.selected && present) next = next.filter((id) => id !== change.id);
    } else if (change.type === 'remove' && next.includes(change.id)) {
      next = next.filter((id) => id !== change.id);
    }
  }
  return next;
}

export function sameIdOrder(current: readonly string[], next: readonly { id: string }[]): boolean {
  return current.length === next.length && current.every((id, index) => id === next[index]?.id);
}
