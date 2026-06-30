/**
 * DiffView — unified +/- line diff for Edit/MultiEdit/Write tool views.
 * Monospace, Console-styled, with +/- gutter and optional line numbers.
 */
import { useMemo } from 'react';
import { lineDiff, diffStats } from './diff';
import './diff.css';

export function DiffView({
    oldText,
    newText,
    showLineNumbers = false,
}: {
    oldText: string;
    newText: string;
    showLineNumbers?: boolean;
}) {
    const rows = useMemo(() => lineDiff(oldText ?? '', newText ?? ''), [oldText, newText]);
    const stats = useMemo(() => diffStats(rows), [rows]);

    return (
        <div className="dv">
            <div className="dv-stat">
                <span className="dv-add">+{stats.added}</span>
                <span className="dv-del">-{stats.removed}</span>
            </div>
            <div className="dv-body">
                {rows.map((r, idx) => (
                    <div key={idx} className={`dv-row dv-row--${r.type}`}>
                        {showLineNumbers && (
                            <>
                                <span className="dv-no">{r.oldNo ?? ''}</span>
                                <span className="dv-no">{r.newNo ?? ''}</span>
                            </>
                        )}
                        <span className="dv-sign">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
                        <span className="dv-text">{r.text === '' ? ' ' : r.text}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
