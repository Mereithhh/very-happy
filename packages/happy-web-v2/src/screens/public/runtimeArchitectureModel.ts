export type RuntimeArchitecturePath = 'structured' | 'terminal';

export type RuntimeArchitectureState = {
  activePath: RuntimeArchitecturePath;
};

export type RuntimeArchitectureAction = {
  type: 'select-path';
  path: RuntimeArchitecturePath;
};

export const INITIAL_RUNTIME_ARCHITECTURE_STATE: RuntimeArchitectureState = {
  activePath: 'structured',
};

export const RUNTIME_ARCHITECTURE_ROUTES: Record<RuntimeArchitecturePath, string> = {
  structured: 'Claude Agent SDK → normalized events → structured conversation',
  terminal: 'tmux-owned process ⇄ control mode ⇄ xterm.js',
};

export function runtimeArchitectureReducer(
  state: RuntimeArchitectureState,
  action: RuntimeArchitectureAction,
): RuntimeArchitectureState {
  if (action.type === 'select-path') return { ...state, activePath: action.path };
  return state;
}

export function getRuntimeArchitectureRoute(state: RuntimeArchitectureState): string {
  return RUNTIME_ARCHITECTURE_ROUTES[state.activePath];
}
