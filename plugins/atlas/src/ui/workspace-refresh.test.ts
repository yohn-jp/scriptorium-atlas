import { describe, expect, it } from 'vitest';
import {
  initialWorkspaceRefreshStatus,
  reduceWorkspaceRefreshStatus,
} from './workspace-refresh.js';

describe('workspace refresh status', () => {
  it('clears a failed inventory after a newer refresh succeeds and ignores the old failure', () => {
    const firstSequence = 1;
    const secondSequence = 2;
    let state = reduceWorkspaceRefreshStatus(initialWorkspaceRefreshStatus, {
      type: 'started', sequence: firstSequence,
    });
    state = reduceWorkspaceRefreshStatus(state, {
      type: 'failed', sequence: firstSequence, message: 'INVALID_INPUT: Cursor expired',
    });
    expect(state.fatalError).toContain('Cursor expired');

    state = reduceWorkspaceRefreshStatus(state, { type: 'started', sequence: secondSequence });
    expect(state.fatalError).toContain('Cursor expired');
    state = reduceWorkspaceRefreshStatus(state, { type: 'succeeded', sequence: secondSequence });
    expect(state.fatalError).toBe('');

    const afterStaleFailure = reduceWorkspaceRefreshStatus(state, {
      type: 'failed', sequence: firstSequence, message: 'INVALID_INPUT: Cursor expired',
    });
    expect(afterStaleFailure).toBe(state);
    expect(afterStaleFailure.fatalError).toBe('');
  });

  it('does not let an older success clear a newer refresh error', () => {
    let state = reduceWorkspaceRefreshStatus(initialWorkspaceRefreshStatus, { type: 'started', sequence: 1 });
    state = reduceWorkspaceRefreshStatus(state, { type: 'started', sequence: 2 });
    state = reduceWorkspaceRefreshStatus(state, { type: 'failed', sequence: 2, message: 'latest failure' });

    const afterStaleSuccess = reduceWorkspaceRefreshStatus(state, { type: 'succeeded', sequence: 1 });
    expect(afterStaleSuccess).toBe(state);
    expect(afterStaleSuccess.fatalError).toBe('latest failure');
  });
});
