import { describe, expect, it } from 'vitest';
import { LayoutError } from '@scriptorium-atlas/layout';
import {
  isCurrentLayoutRequest,
  isLayoutCancellation,
  layoutErrorNotice,
  LAYOUT_CANCELLED_NOTICE,
} from './layout-notice.js';

describe('layout notices', () => {
  it('reports an explicit worker cancellation as cancelled', () => {
    const error = new LayoutError('CANCELLED', 'Layout calculation was cancelled by terminating its Worker');

    expect(isLayoutCancellation(error)).toBe(true);
    expect(layoutErrorNotice(error, error.message)).toBe(LAYOUT_CANCELLED_NOTICE);
  });

  it('keeps unrelated worker errors classified as failures', () => {
    const error = new LayoutError('WORKER_FAILED', 'Layout Worker failed and was terminated');

    expect(isLayoutCancellation(error)).toBe(false);
    expect(layoutErrorNotice(error, error.message)).toBe('レイアウトに失敗しました: Layout Worker failed and was terminated');
  });

  it('does not publish an outcome from an older layout request', () => {
    expect(isCurrentLayoutRequest(4, 5)).toBe(false);
    expect(isCurrentLayoutRequest(5, 5)).toBe(true);
  });
});
