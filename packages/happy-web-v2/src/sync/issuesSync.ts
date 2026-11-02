/** B-873: keep Issues fresh where they are shown (split from issuesStore.ts: sync.ts imports the store). */
import { useEffect } from 'react';
import { loadIssueDetail, loadIssues, probeIssues, useIssuesStore } from './issuesStore';
import { sync } from './sync';

/** Mount where Issues data is shown: first full load, incremental reload on every resume (AGENTS #13 via sync.onResume). */
export function useIssuesSync(enabled = true): void {
    useEffect(() => {
        if (!enabled) return;
        void probeIssues().then((availability) => { if (availability === 'enabled') void loadIssues(); });
        const off = typeof sync.onResume === 'function' ? sync.onResume(() => {
            void probeIssues().then((availability) => {
                if (availability !== 'enabled') return;
                void loadIssues();
                for (const [id, d] of Object.entries(useIssuesStore.getState().details)) if (d.status === 'ready') void loadIssueDetail(id);
            });
        }) : undefined;
        return () => { off?.(); };
    }, [enabled]);
}

