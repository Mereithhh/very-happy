/**
 * B-892 prototype: what /issues shows while nothing is open — the one thing the
 * page is for (assign to an agent, it starts) plus examples that open 新建 issue
 * prefilled. Replaces the bare 「已完成 N」 line. Also the `C` shortcut and the
 * remembered default assignee of the new-issue dialog.
 */
import { useEffect } from 'react';
import { Plus } from 'lucide-react';
import { ISSUE_ASSIGNABLE_AGENTS, type IssueAssignableAgent } from '@slopus/happy-wire';
import type { IssuesCopy } from './issuesCopy';

const LAST_AGENT_KEY = 'vh.issues.lastAgent';

export interface LastIssueAgent { machineId: string; agent: IssueAssignableAgent }

export function readLastIssueAgent(): LastIssueAgent | null {
    try {
        const parsed = JSON.parse(localStorage.getItem(LAST_AGENT_KEY) ?? 'null') as Partial<LastIssueAgent> | null;
        return parsed?.machineId && (ISSUE_ASSIGNABLE_AGENTS as readonly string[]).includes(parsed.agent ?? '') ? parsed as LastIssueAgent : null;
    } catch { return null; }
}

export function writeLastIssueAgent(value: LastIssueAgent): void {
    try { localStorage.setItem(LAST_AGENT_KEY, JSON.stringify(value)); } catch { /* private mode */ }
}

/** The last choice while its machine can still take work, else the first machine that can; none = stay on 无. */
export function defaultNewIssueAgent(last: LastIssueAgent | null, pickableMachineIds: readonly string[]): LastIssueAgent | null {
    if (pickableMachineIds.length === 0) return null;
    if (last && pickableMachineIds.includes(last.machineId)) return last;
    return { machineId: pickableMachineIds[0], agent: last?.agent ?? 'claude' };
}

/** `c` outside a text field opens 新建 issue (Linear's key); modifiers stay with the browser. */
export function isNewIssueKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean }, target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return false;
    if (e.key !== 'c' && e.key !== 'C') return false;
    return !(target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? ''));
}

export function useNewIssueShortcut(enabled: boolean, onNew: () => void): void {
    useEffect(() => {
        if (!enabled) return;
        const onKey = (e: KeyboardEvent) => {
            if (!isNewIssueKey(e, e.target as HTMLElement | null) || document.querySelector('[role="dialog"], [role="menu"]')) return;
            e.preventDefault();
            onNew();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [enabled, onNew]);
}

export function IssueGuide({ copy, onCreate }: { copy: IssuesCopy; onCreate: (title: string) => void }) {
    return (
        <section className="is-guide" data-testid="issues-guide">
            <h2 className="is-guide-title">{copy.guideTitle}</h2>
            <ol className="is-guide-steps">{copy.guideSteps.map((step) => <li key={step}>{step}</li>)}</ol>
            <div className="is-guide-examples">
                <span className="is-muted">{copy.guideExamplesLabel}</span>
                {copy.guideExamples.map((example) => <button key={example} type="button" className="is-guide-example" onClick={() => onCreate(example)}>{example}</button>)}
            </div>
            <button type="button" className="is-primary is-guide-cta" onClick={() => onCreate('')}><Plus size={14} aria-hidden />{copy.guideCta}</button>
        </section>
    );
}
