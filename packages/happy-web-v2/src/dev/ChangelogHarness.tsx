/** DEV-only visual harness for the release notice and history page. */
import { ChangelogNotice } from '@/app/ChangelogNotice';
import { CHANGELOG_RELEASES, CHANGELOG_STORAGE_KEY } from '@/app/changelogRelease';

function reopenAs(seen: string | null) {
    if (seen === null) localStorage.removeItem(CHANGELOG_STORAGE_KEY);
    else localStorage.setItem(CHANGELOG_STORAGE_KEY, seen);
    location.reload();
}

export function ChangelogHarness() {
    return (
        <main style={{ minHeight: '100dvh', background: 'var(--bg-0)', color: 'var(--text)', padding: 24 }}>
            <h1 style={{ margin: 0, fontSize: 20 }}>Changelog visual QA</h1>
            <p style={{ color: 'var(--text-dim)' }}>
                Pick the release you "last saw" — the notice shows everything newer. Clear = fresh browser (current release only).
            </p>
            <label style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                Last seen release
                <select
                    defaultValue=""
                    onChange={(e) => reopenAs(e.target.value === '' ? null : e.target.value)}
                    style={{ maxWidth: '100%', font: 'inherit', color: 'inherit', background: 'var(--bg-1)', border: '1px solid var(--line)', padding: 6 }}
                >
                    <option value="">(clear — fresh browser)</option>
                    {CHANGELOG_RELEASES.map((release) => (
                        <option key={release.id} value={release.id}>{release.id}</option>
                    ))}
                </select>
            </label>
            <ChangelogNotice />
        </main>
    );
}
