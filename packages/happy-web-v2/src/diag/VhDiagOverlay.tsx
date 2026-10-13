/**
 * B-599: layout overlay on the REAL app (enabled by `?vhdiag=1` or the toggle on
 * /diag/viewport; persisted per device). Outlines the shell → composer chain
 * and prints each element's rect bottom and computed padding-bottom, so a
 * screenshot of a session page shows which box owns the band under the
 * composer. Pointer-transparent except for its own small panel.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/ui';
import { collectElementSnapshots, collectViewportSnapshot, copyText, LAYOUT_SELECTORS, subscribeViewportChanges } from './viewportMeasure';
import { formatViewportReport, px, type ElementSnapshot } from './viewportReport';
import { setVhDiagFlag } from './vhDiagFlag';
import './viewportDiag.css';

const OUTLINED = ['.app-shell', '.sd-foot', '.ci', '.ci-status'];

export function VhDiagOverlay() {
    const [elements, setElements] = useState<ElementSnapshot[]>([]);
    const [report, setReport] = useState('');
    const [collapsed, setCollapsed] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => subscribeViewportChanges(() => {
        const els = collectElementSnapshots(LAYOUT_SELECTORS);
        setElements(els);
        setReport(formatViewportReport(collectViewportSnapshot(), els));
    }), []);

    const onCopy = async () => {
        setCopied(await copyText(report));
        window.setTimeout(() => setCopied(false), 2000);
    };

    return (
        <>
            {elements
                .filter((el) => el.found && OUTLINED.includes(el.selector))
                .map((el) => (
                    <div
                        key={el.selector}
                        aria-hidden="true"
                        className={`vd-box vd-box--${el.selector.slice(1)}`}
                        style={{ top: el.top, left: el.left, width: el.width, height: el.height }}
                    >
                        <span className="vd-box-label">
                            {el.selector} b={px(el.bottom)} pb={el.paddingBottom}
                        </span>
                    </div>
                ))}
            <div className={`vd-panel${collapsed ? ' vd-panel--collapsed' : ''}`}>
                <div className="vd-panel-actions">
                    <Button size="sm" variant="secondary" onClick={() => setCollapsed((v) => !v)}>
                        {collapsed ? 'vhdiag' : '收起'}
                    </Button>
                    {!collapsed && (
                        <>
                            <Button size="sm" variant="secondary" onClick={() => void onCopy()}>
                                {copied ? '已复制' : '复制'}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setVhDiagFlag(false)}>
                                关闭诊断
                            </Button>
                        </>
                    )}
                </div>
                {!collapsed && <pre className="vd-pre">{report}</pre>}
            </div>
        </>
    );
}
