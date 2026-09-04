/**
 * ```mermaid 代码块 → 真图（B-357）。
 *
 * 设计原则：**屏幕上任何时刻都必须有内容**。mermaid 及其依赖是懒加载的（首图 171 kB gzip），
 * 而 LLM 写错 mermaid 语法是常态，所以这里是一个状态机，每一格都落在「代码块」这个安全底：
 *
 * | 状态 | 显示 |
 * |---|---|
 * | 加载中 / 未渲染 | `CodeView`（不是 spinner，不是空白） |
 * | 成功 | SVG + 「源码 / 图」切换 |
 * | 语法错或渲染失败 | 回落 `CodeView` + 一行 dim 说明；**不显示 mermaid 自己的错误图** |
 * | 弱网（saveData / 2g-3g） | `CodeView` + 「渲染图表」按钮，把 171 kB 的决定权交给用户 |
 *
 * 流式草稿（`plainCode`）根本不会走到这里——半截图必然解析失败，而草稿每秒重渲多次
 * （见 `Markdown.tsx` 的 `components.pre`）。
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Code2, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { CodeView } from './CodeView';
import { renderMermaid, sanitizeMermaidId, shouldDeferMermaid } from './mermaidRender';
import './mermaid.css';

/**
 * 当前生效的主题，不依赖 `ThemeProvider`。
 *
 * `useTheme()` 在 provider 之外会抛，而 `<Markdown>` 也被 `renderToStaticMarkup` 的测试
 * 直接渲染；这里读 DOM + matchMedia 并订阅两者的变化，行为等价而没有耦合。
 */
function useThemeKey(): string {
    const read = () => {
        if (typeof document === 'undefined') return 'dark';
        const attr = document.documentElement.getAttribute('data-theme');
        if (attr === 'dark' || attr === 'light') return attr;
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    };
    const [key, setKey] = useState(read);
    useEffect(() => {
        const update = () => setKey(read());
        const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
        mq?.addEventListener('change', update);
        const mo = typeof MutationObserver !== 'undefined'
            ? new MutationObserver(update)
            : null;
        mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => { mq?.removeEventListener('change', update); mo?.disconnect(); };
    }, []);
    return key;
}

type State =
    | { kind: 'idle' }
    | { kind: 'deferred' }
    | { kind: 'ok'; svg: string }
    | { kind: 'failed' };

export function MermaidView({ code }: { code: string }) {
    const { t } = useTranslation();
    const themeKey = useThemeKey();
    const id = sanitizeMermaidId(useId());
    const [state, setState] = useState<State>(() => (shouldDeferMermaid() ? { kind: 'deferred' } : { kind: 'idle' }));
    const [showSource, setShowSource] = useState(false);
    const wanted = useRef(false);

    useEffect(() => {
        if (state.kind === 'deferred' && !wanted.current) return;
        let cancelled = false;
        void renderMermaid(id, code, themeKey).then((result) => {
            if (cancelled) return;
            setState(result.ok ? { kind: 'ok', svg: result.svg } : { kind: 'failed' });
        });
        return () => { cancelled = true; };
        // `state.kind` intentionally out: re-running on our own setState would loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code, themeKey, id]);

    if (state.kind === 'deferred') {
        return (
            <div className="mmd">
                <CodeView code={code} lang="mermaid" />
                <button
                    type="button"
                    className="mmd-action"
                    onClick={() => { wanted.current = true; setState({ kind: 'idle' }); }}
                >
                    <ImageIcon size={13} aria-hidden />
                    {t('session.chat.mermaidRender')}
                </button>
            </div>
        );
    }

    if (state.kind === 'ok' && !showSource) {
        return (
            <div className="mmd">
                {/* mermaid 产物是 SVG 字符串，只能这样注入。安全性靠 securityLevel:'strict'
                    （禁 click 处理器与原始 HTML 标签）+ mermaid 内部的 dompurify，见
                    mermaidRender.ts 与 mermaidSecurity.test.tsx。 */}
                <div className="mmd-svg" dangerouslySetInnerHTML={{ __html: state.svg }} />
                <button type="button" className="mmd-action" onClick={() => setShowSource(true)}>
                    <Code2 size={13} aria-hidden />
                    {t('session.chat.mermaidSource')}
                </button>
            </div>
        );
    }

    return (
        <div className="mmd">
            <CodeView code={code} lang="mermaid" />
            {state.kind === 'ok' && (
                <button type="button" className="mmd-action" onClick={() => setShowSource(false)}>
                    <ImageIcon size={13} aria-hidden />
                    {t('session.chat.mermaidDiagram')}
                </button>
            )}
            {state.kind === 'failed' && <span className="mmd-note">{t('session.chat.mermaidFailed')}</span>}
        </div>
    );
}
