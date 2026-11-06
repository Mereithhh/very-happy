/**
 * B-896: what /issues shows while nothing is open — the one thing the page is
 * for (assign to an agent, it starts) and three examples that open 新建 issue
 * prefilled — replacing the bare 「还没有 issue」 / lone 「已完成 N」 group.
 * Also the page's `C` shortcut.
 */
import { useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';
import { isNewIssueKey } from './newIssueDefaults';
import type { IssuesCopy } from './issuesCopy';

/** `C` opens 新建 issue on the page — not in a text field, while composing, or with a dialog / menu open. */
export function useNewIssueShortcut(enabled: boolean, onNew: () => void): void {
    const latest = useRef(onNew);
    latest.current = onNew;
    useEffect(() => {
        if (!enabled) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || !isNewIssueKey(e, e.target instanceof Element ? e.target as HTMLElement : null)) return;
            if (document.querySelector('[role="dialog"], [role="menu"]')) return;
            e.preventDefault();
            latest.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [enabled]);
}

export function IssueGuide({ copy, onCreate }: { copy: IssuesCopy; onCreate: (title: string) => void }) {
    return (
        <section className="is-guide" data-testid="issues-guide" aria-labelledby="is-guide-title">
            <h2 className="is-guide-title" id="is-guide-title">{copy.guideTitle}</h2>
            <ol className="is-guide-steps">{copy.guideSteps.map((step) => <li key={step}>{step}</li>)}</ol>
            <div className="is-guide-examples" role="group" aria-label={copy.guideExamplesLabel}>
                <span className="is-muted">{copy.guideExamplesLabel}</span>
                {copy.guideExamples.map((example) => <button key={example} type="button" className="is-guide-example" onClick={() => onCreate(example)}>{example}</button>)}
            </div>
            <button type="button" className="is-primary is-guide-cta" onClick={() => onCreate('')}><Plus size={14} aria-hidden />{copy.guideCta}<kbd className="is-kbd" aria-hidden>C</kbd></button>
        </section>
    );
}
