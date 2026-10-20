import type { LayoutInput, LayoutResult } from '../types.js';

export interface LayoutWorkerRequest {
  readonly requestId: number;
  readonly generation: number;
  readonly snapshotKey: string | null;
  readonly boardRevision: LayoutInput['boardRevision'];
  readonly input: LayoutInput;
}

export interface LayoutWorkerResponse {
  readonly requestId: number;
  readonly generation: number;
  readonly snapshotKey: string | null;
  readonly boardRevision: LayoutInput['boardRevision'];
  readonly ok: boolean;
  readonly result?: LayoutResult;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface LayoutWorkerPort {
  postMessage(message: LayoutWorkerRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<LayoutWorkerResponse>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<LayoutWorkerResponse>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate(): void;
}
