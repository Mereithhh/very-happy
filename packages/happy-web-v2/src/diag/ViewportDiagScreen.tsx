/**
 * B-599: /diag/viewport — no auth, not linked from the app chrome (reached via
 * 设置 → 诊断 → 视口诊断). Live viewport/safe-area numbers plus a frame drawn at
 * `height: var(--app-h)`, so one screenshot shows where the shell ends vs the
 * physical screen bottom.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/ui';
import { collectViewportSnapshot, copyText, subscribeViewportChanges } from './viewportMeasure';
import { formatViewportReport } from './viewportReport';
import { readVhDiagFlag, setVhDiagFlag, subscribeVhDiagFlag } from './vhDiagFlag';
import './viewportDiag.css';

export function ViewportDiagScreen() {
    const navigate = useNavigate();
    const [report, setReport] = useState('');
    const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
    const [overlayOn, setOverlayOn] = useState(readVhDiagFlag);

    useEffect(() => subscribeViewportChanges(() => setReport(formatViewportReport(collectViewportSnapshot()))), []);
    useEffect(() => subscribeVhDiagFlag(setOverlayOn), []);

    const onCopy = async () => {
        setCopied((await copyText(report)) ? 'ok' : 'fail');
        window.setTimeout(() => setCopied('idle'), 2000);
    };
    const onBack = () => {
        if (window.history.length > 1) navigate(-1);
        else navigate('/');
    };
    const onOverlay = () => {
        const next = !overlayOn;
        setVhDiagFlag(next);
        if (next) navigate('/');
    };

    return (
        <div className="vd-page">
            <div className="vd-head">
                <h1 className="vd-title">Viewport 诊断</h1>
                <Button size="sm" variant="ghost" onClick={onBack}>返回</Button>
                <Button size="sm" variant="primary" onClick={() => void onCopy()}>
                    {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败，请长按选择' : '复制'}
                </Button>
            </div>
            <p className="vd-hint">
                红色虚线框 = 按 --app-h 画的整屏高度（框底 = app 底边；截图底边 = 物理屏幕底）；
                黄线 = position: fixed; bottom: 0。请截图并点「复制」把文本发给我们。
            </p>
            <p className="vd-hint">
                <Button size="sm" variant="secondary" onClick={onOverlay}>
                    {overlayOn ? '关闭会话页叠加层' : '在会话页叠加诊断（然后打开任意会话）'}
                </Button>
            </p>
            <pre className="vd-pre">{report}</pre>
            <div className="vd-frame" aria-hidden="true">
                <span className="vd-frame-label">--app-h bottom</span>
            </div>
            <div className="vd-fixed-bottom" aria-hidden="true">
                <span>fixed bottom:0</span>
            </div>
        </div>
    );
}
