import type { GraphDelta, GraphEdge, GraphNode, NodeRef, SnapshotRef } from '@scriptorium-atlas/contracts';
import type { GraphSearchOptions, GraphTraversalResult, ShortestPathOptions, ShortestPathResult, WeakComponent } from '../index.js';

export type GraphWorkerRequest =
  | { readonly id: number; readonly type: 'replace'; readonly snapshot: SnapshotRef; readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] }
  | { readonly id: number; readonly type: 'delta'; readonly delta: GraphDelta }
  | { readonly id: number; readonly type: 'search'; readonly snapshotKey: string; readonly options: GraphSearchOptions }
  | { readonly id: number; readonly type: 'neighbors'; readonly snapshotKey: string; readonly from: NodeRef; readonly direction: 'in' | 'out' | 'both'; readonly depth: number; readonly limit?: number }
  | { readonly id: number; readonly type: 'shortestPath'; readonly snapshotKey: string; readonly options: ShortestPathOptions }
  | { readonly id: number; readonly type: 'weakComponents'; readonly snapshotKey: string };

export type GraphWorkerValue =
  | undefined
  | ReturnType<typeof import('../index.js').searchGraph>
  | GraphTraversalResult
  | ShortestPathResult
  | readonly WeakComponent[];

export interface GraphWorkerResponse {
  readonly id: number;
  readonly snapshotKey: string | null;
  readonly ok: boolean;
  readonly value?: GraphWorkerValue;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface WorkerPort {
  postMessage(message: GraphWorkerRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<GraphWorkerResponse>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<GraphWorkerResponse>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate(): void;
}
