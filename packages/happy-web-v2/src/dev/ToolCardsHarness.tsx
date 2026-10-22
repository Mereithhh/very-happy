/**
 * DEV-only harness for B-754 tool cards. Route `/dev/tool-cards/:id` (rows see
 * a session id, so links render); `?theme=dark|light` forces a theme and
 * `?runner=codex` narrows to one runner. Every call is a local example from
 * `toolCardFixtures.ts` — nothing is sent or read from a server.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ToolGroupView } from '@/screens/session/ToolGroupView';
import { TOOL_FIXTURES } from './toolCardFixtures';
import '@/screens/session/session.css';
import '@/screens/session/chatlist.css';

export function ToolCardsHarness() {
    const [params] = useSearchParams();
    const theme = params.get('theme');
    const runner = params.get('runner');
    useEffect(() => {
        const el = document.documentElement;
        const previous = el.getAttribute('data-theme');
        if (theme === 'dark' || theme === 'light') el.setAttribute('data-theme', theme);
        return () => { if (previous) el.setAttribute('data-theme', previous); else el.removeAttribute('data-theme'); };
    }, [theme]);
    const items = TOOL_FIXTURES.filter((f) => !runner || f.runner === runner);
    return (
        <div className="sd"><div className="sd-main"><div className="sd-body"><div className="cl"><div className="cl-scroll"><div className="cl-inner" data-testid="tool-cards">
            <div style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-12)' }}>本地示例 · B-754 工具卡（数据均为示例，不发送请求）</div>
            {items.map((f) => (
                <section key={f.id} data-fixture={f.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                    <h2 style={{ fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--text-faint)', margin: 'var(--sp-3) 0 0' }}>{f.runner} · {f.title}</h2>
                    <ToolGroupView tools={[f.message]} />
                </section>
            ))}
        </div></div></div></div></div></div>
    );
}
