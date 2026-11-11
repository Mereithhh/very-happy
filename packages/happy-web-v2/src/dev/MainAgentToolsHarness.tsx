/**
 * DEV-only harness for B-923 main agent tool cards: route `/dev/main-agent-tools`
 * shows every fixture (each receipt's success and failure shapes) at the
 * column's default width. `?theme=dark|light` forces a theme; `?w=320` sets
 * the column width. Local example data only — nothing is sent or read.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MainAgentToolCard } from '@/screens/mainAgent/toolCards/MainAgentToolCard';
import { mainAgentToolView } from '@/screens/mainAgent/toolCards/mainAgentToolView';
import { MAIN_AGENT_TOOL_FIXTURES } from '@/screens/mainAgent/toolCards/mainAgentToolFixtures';
import '@/screens/mainAgent/mainAgent.css';

export function MainAgentToolsHarness() {
    const [params] = useSearchParams();
    const theme = params.get('theme');
    const width = Number(params.get('w')) || 400;
    useEffect(() => {
        const el = document.documentElement;
        const previous = el.getAttribute('data-theme');
        if (theme === 'dark' || theme === 'light') el.setAttribute('data-theme', theme);
        return () => { if (previous) el.setAttribute('data-theme', previous); else el.removeAttribute('data-theme'); };
    }, [theme]);
    return (
        <div style={{ height: '100dvh', overflowY: 'auto', background: 'var(--bg-0)', color: 'var(--text)' }}>
            <div data-testid="main-agent-tools" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-4)', padding: 'var(--sp-4)', alignItems: 'flex-start' }}>
                <p style={{ flexBasis: '100%', margin: 0, color: 'var(--text-faint)', fontSize: 'var(--fs-12)' }}>本地示例 · B-923 主 agent 工具卡（数据均为示例，不发送请求）· {MAIN_AGENT_TOOL_FIXTURES.length}</p>
                {MAIN_AGENT_TOOL_FIXTURES.map((f) => {
                    const view = mainAgentToolView(f.tool);
                    return (
                        <section key={f.id} data-fixture={f.id} style={{ width, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', background: 'var(--bg-1)', padding: 'var(--sp-2)' }}>
                            <h2 style={{ margin: 0, fontSize: 'var(--fs-11)', fontWeight: 500, color: 'var(--text-faint)' }}>{f.title}</h2>
                            {view ? <MainAgentToolCard view={view} mainAgentSessionId="dev-main-agent" /> : <span data-unrecognized>generic row</span>}
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
