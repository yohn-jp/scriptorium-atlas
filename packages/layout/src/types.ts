import type { BoardDocument, BoardEdge, BoardNode, Pin, Position, SnapshotRef, TimelineAxis, TimelineEntry, TimelineRange } from '@scriptorium-atlas/contracts';

export type LayoutKind = 'force' | 'layered' | 'timeline' | 'manual';

export type LayoutNode = Pick<BoardNode, 'id' | 'position'> & {
  readonly width?: number;
  readonly height?: number;
};

export type LayoutEdge = Pick<BoardEdge, 'id' | 'from' | 'to'>;

interface LayoutInputBase {
  readonly boardRevision: BoardDocument['revision'];
  readonly snapshot?: SnapshotRef;
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  readonly pins?: readonly Pin[];
}

export type LayoutInput = LayoutInputBase & (
  | {
      readonly kind: 'force';
      readonly seed?: number | string;
      readonly iterations?: number;
      readonly linkDistance?: number;
      readonly chargeStrength?: number;
      readonly centerX?: number;
      readonly centerY?: number;
    }
  | {
      readonly kind: 'layered';
      readonly direction?: 'RIGHT' | 'DOWN';
      readonly nodeSpacing?: number;
      readonly layerSpacing?: number;
    }
  | {
      readonly kind: 'timeline';
      readonly axis: TimelineAxis;
      readonly entries: readonly TimelineEntry[];
      readonly range?: TimelineRange;
      readonly width?: number;
      readonly rowSpacing?: number;
      readonly laneSpacing?: number;
    }
  | {
      readonly kind: 'manual';
    }
);

export interface LayoutPosition {
  readonly nodeId: string;
  readonly position: Position;
  readonly lane?: 'main' | 'unknown';
}

export interface LayoutResult {
  readonly kind: LayoutKind;
  readonly boardRevision: BoardDocument['revision'];
  readonly snapshot?: SnapshotRef;
  readonly positions: readonly LayoutPosition[];
  /** Edge ids with at least one endpoint absent from the supplied node set. */
  readonly unresolvedEdgeIds: readonly string[];
}

export interface LayoutRevision {
  readonly boardRevision: BoardDocument['revision'];
  readonly snapshot?: SnapshotRef;
}

export type LayoutErrorCode =
  | 'INVALID_INPUT'
  | 'DUPLICATE_NODE'
  | 'DUPLICATE_EDGE'
  | 'INVALID_PIN'
  | 'CANCELLED'
  | 'STALE_RESULT'
  | 'WORKER_FAILED'
  | 'TIMEOUT'
  | 'CLOSED';

export class LayoutError extends Error {
  constructor(readonly code: LayoutErrorCode, message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}
