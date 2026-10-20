export type WorkspaceRefreshStatus = {
  sequence: number;
  fatalError: string;
};

export type WorkspaceRefreshStatusAction =
  | { type: 'started'; sequence: number }
  | { type: 'succeeded'; sequence: number }
  | { type: 'failed'; sequence: number; message: string }
  | { type: 'set-error'; message: string }
  | { type: 'clear-error' };

export const initialWorkspaceRefreshStatus: WorkspaceRefreshStatus = {
  sequence: 0,
  fatalError: '',
};

export function reduceWorkspaceRefreshStatus(
  state: WorkspaceRefreshStatus,
  action: WorkspaceRefreshStatusAction,
): WorkspaceRefreshStatus {
  switch (action.type) {
    case 'started':
      return action.sequence > state.sequence ? { ...state, sequence: action.sequence } : state;
    case 'succeeded':
      return action.sequence === state.sequence ? { ...state, fatalError: '' } : state;
    case 'failed':
      return action.sequence === state.sequence ? { ...state, fatalError: action.message } : state;
    case 'set-error':
      return { ...state, fatalError: action.message };
    case 'clear-error':
      return { ...state, fatalError: '' };
  }
}
