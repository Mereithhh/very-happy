/** DEV-only visual harness for the release notice and history page. */
import { ChangelogNotice } from '@/app/ChangelogNotice';

export function ChangelogHarness() {
    return (
        <main style={{ minHeight: '100dvh', background: 'var(--bg-0)', color: 'var(--text)', padding: 24 }}>
            <h1 style={{ margin: 0, fontSize: 20 }}>Changelog visual QA</h1>
            <p style={{ color: 'var(--text-dim)' }}>Clear vh.changelog.seen and reload to reopen the notice.</p>
            <ChangelogNotice />
        </main>
    );
}
