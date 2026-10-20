import { LayoutError } from '@scriptorium-atlas/layout';

export const LAYOUT_CANCELLED_NOTICE = 'レイアウト計算を中止しました。';

export function isLayoutCancellation(error: unknown): boolean {
  return error instanceof LayoutError && error.code === 'CANCELLED';
}

export function isCurrentLayoutRequest(requestSequence: number, currentSequence: number): boolean {
  return requestSequence === currentSequence;
}

export function layoutErrorNotice(error: unknown, message: string): string {
  return isLayoutCancellation(error) ? LAYOUT_CANCELLED_NOTICE : `レイアウトに失敗しました: ${message}`;
}
