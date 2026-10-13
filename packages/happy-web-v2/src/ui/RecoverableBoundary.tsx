/**
 * RecoverableBoundary — B-565, the local render-error boundary.
 *
 * Before this the only boundary was the route errorElement, so ONE malformed
 * message / mermaid block / tool card blanked the whole workspace (and did it
 * again after every refresh). Wrap a region and a crash inside it turns into
 * a one-line fallback ("这条内容渲染失败 · 重试 · 复制错误"); siblings keep
 * rendering.
 *
 * - `resetKey` change → error cleared automatically (the content changed, try
 *   again). Compared with Object.is, so an object reference works.
 * - lazy-chunk failures are rethrown to the route errorElement → ChunkFailure,
 *   which owns the reload-to-latest recovery (see recoverableBoundaryModel).
 * - console.error carries the region name.
 *
 * Styling uses tokens only (no --accent: accent means "live").
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { t } from '@/i18n/useTranslation';
import { toast } from './Toast';
import { boundaryErrorText, nextBoundaryState, shouldRethrowToRoute } from './recoverableBoundaryModel';
import './recoverableBoundary.css';

interface Props {
    /** short region name: console prefix + data-boundary attribute */
    region: string;
    children?: ReactNode;
    /** change it to clear a caught error (e.g. the message object) */
    resetKey?: unknown;
    /** one-line fallback (rows) instead of the block panel (panels) */
    compact?: boolean;
}

interface State {
    error: unknown;
    resetKey: unknown;
    componentStack: string | null;
}

export class RecoverableBoundary extends Component<Props, State> {
    state: State = { error: null, resetKey: this.props.resetKey, componentStack: null };

    static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
        const next = nextBoundaryState(state, props.resetKey);
        return next ? { ...next, componentStack: null } : null;
    }

    static getDerivedStateFromError(error: unknown): Partial<State> {
        return { error: error ?? new Error('unknown render error') };
    }

    componentDidCatch(error: unknown, info: ErrorInfo): void {
        if (shouldRethrowToRoute(error)) return; // the route boundary reports it
        console.error(`[boundary:${this.props.region}] render crash contained`, error, info.componentStack);
        this.setState({ componentStack: info.componentStack ?? null });
    }

    private retry = () => this.setState({ error: null, componentStack: null });

    private copy = () => {
        const text = boundaryErrorText(this.props.region, this.state.error, this.state.componentStack);
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clip) return;
        void clip.writeText(text).then(
            () => toast.success(t('robustness.errorCopied')),
            () => toast.error(t('common.error')),
        );
    };

    render(): ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children ?? null;
        // Hand chunk failures to the route errorElement (ChunkFailure).
        if (shouldRethrowToRoute(error)) throw error;
        const compact = this.props.compact === true;
        const actions = (
            <>
                <button type="button" className="vh-boundary-btn" onClick={this.retry}>{t('robustness.retry')}</button>
                <span className="vh-boundary-sep" aria-hidden>·</span>
                <button type="button" className="vh-boundary-btn" onClick={this.copy}>{t('robustness.copyError')}</button>
            </>
        );
        if (compact) {
            return (
                <div className="vh-boundary vh-boundary--compact" role="alert" data-boundary={this.props.region}>
                    <AlertTriangle size={13} className="vh-boundary-icon" aria-hidden />
                    <span className="vh-boundary-text">{t('robustness.renderFailed')}</span>
                    <span className="vh-boundary-sep" aria-hidden>·</span>
                    {actions}
                </div>
            );
        }
        return (
            <div className="vh-boundary vh-boundary--panel" role="alert" data-boundary={this.props.region}>
                <AlertTriangle size={16} className="vh-boundary-icon" aria-hidden />
                <div className="vh-boundary-title">{t('robustness.panelFailed')}</div>
                <div className="vh-boundary-hint">{t('robustness.panelFailedHint')}</div>
                <div className="vh-boundary-actions">{actions}</div>
            </div>
        );
    }
}
