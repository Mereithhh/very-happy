import { createContext, useContext } from 'react';

/** Child transcripts are local trees, not entries in the parent session index. */
export const SubagentNavigationContext = createContext<'session' | 'inline'>('session');
export function useSubagentNavigation() {
    return useContext(SubagentNavigationContext);
}
