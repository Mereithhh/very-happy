/**
 * B-796: /dev/safe-area — no auth, ships in production on purpose (the Owner
 * opens it on the device; a DEV-only route would not exist there). Paints the
 * four env(safe-area-inset-*) bands at the screen edges with their sizes, plus
 * two probe rows with a ＋ at the right edge: one ignoring the insets (where
 * the old header ＋ sat) and one padded by `--sa-*` (what the app does now).
 * One screenshot shows where the system draws (iPhone Duo cover: the status
 * column on the right) and whether our controls stay clear; 「复制」 gives
 * the numbers as text.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Plus } from 'lucide-react';
import { Button } from '@/ui';
import { collectViewportSnapshot, copyText, measureSafeArea, subscribeViewportChanges } from './viewportMeasure';
import { formatSafeAreaReport } from './safeAreaReport';
import './safeAreaDiag.css';

type Insets = ReturnType<typeof measureSafeArea>;

/** What the app's `--sa-*` mirrors resolve to (equal to env() unless a test injects them). */
function measureMirrors(): Insets {
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, { position: 'absolute', visibility: 'hidden', paddingTop: 'var(--sa-t)', paddingRight: 'var(--sa-r)', paddingBottom: 'var(--sa-b)', paddingLeft: 'var(--sa-l)' });
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const out = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
    el.remove();
    return out;
}

export function SafeAreaDiagScreen() {
    const navigate = useNavigate();
    const [report, setReport] = useState('');
    const [env, setEnv] = useState<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });
    const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

    useEffect(() => subscribeViewportChanges(() => {
        const snap = collectViewportSnapshot();
        setEnv(snap.safeArea);
        setReport(formatSafeAreaReport(snap, measureMirrors()));
    }), []);

    const onCopy = async () => {
        setCopied((await copyText(report)) ? 'ok' : 'fail');
        window.setTimeout(() => setCopied('idle'), 2000);
    };
    const onBack = () => {
        const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
        if (idx > 0) navigate(-1);
        else navigate('/');
    };

    return (
        <div className="sad-page">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                <div key={side} className={`sad-band sad-band--${side}`} aria-hidden="true">
                    <span>{side} {env[side]}</span>
                </div>
            ))}
            <div className="sad-probe sad-probe--raw" aria-hidden="true"><span>不避让（旧）</span><i><Plus size={18} /></i></div>
            <div className="sad-probe sad-probe--safe" aria-hidden="true"><span>按 --sa-* 避让（新）</span><i><Plus size={18} /></i></div>
            <div className="sad-body">
                <div className="sad-head">
                    <button type="button" className="vh-back" aria-label="返回" onClick={onBack}><ChevronLeft size={18} /></button>
                    <h1>Safe area 诊断</h1>
                    <Button size="sm" variant="primary" onClick={() => void onCopy()}>
                        {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败，请长按选择' : '复制'}
                    </Button>
                </div>
                <p className="sad-hint">
                    红色半透明带 = 系统报告的 env(safe-area-inset-*)，数字是 CSS px。上方两行各有一个「＋」：
                    第一行贴屏幕右边（不避让），第二行按 safe area 留白。请在合起 / 展开、竖屏 / 横屏下各截一张图，并点「复制」把文本发给我们。
                </p>
                <pre className="sad-pre">{report}</pre>
            </div>
        </div>
    );
}
