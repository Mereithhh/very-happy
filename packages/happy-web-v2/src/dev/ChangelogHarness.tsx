/** DEV-only visual harness for the release notice and history page. */
import { ChangelogNotice } from '@/app/ChangelogNotice';
import { CHANGELOG_RELEASES, CHANGELOG_STORAGE_KEY } from '@/app/changelogRelease';
import { CHANGELOG_READ_KEY } from '@/app/changelogPager';
import { SelectMenu } from '@/ui/SelectMenu';
import { useState } from 'react';

function reopenAs(seen: string | null) {
    localStorage.removeItem(CHANGELOG_READ_KEY);
    if (seen === null) localStorage.removeItem(CHANGELOG_STORAGE_KEY);
    else localStorage.setItem(CHANGELOG_STORAGE_KEY, seen);
    location.reload();
}

export function ChangelogHarness() {
    const [seen, setSeen] = useState('');
    return (
        <main style={{ minHeight: '100dvh', background: 'var(--bg-0)', color: 'var(--text)', padding: 24 }}>
            <h1 style={{ margin: 0, fontSize: 20 }}>Changelog visual QA</h1>
            <p style={{ color: 'var(--text-dim)' }}>
                Pick the release you "last saw" — the notice shows everything newer. Clear = fresh browser (current release only).
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span id="changelog-harness-seen">Last seen release</span>
                <SelectMenu
                    labelledBy="changelog-harness-seen"
                    label="Last seen release"
                    value={seen}
                    onChange={(next) => { setSeen(next); reopenAs(next === '' ? null : next); }}
                    options={[{ value: '', label: '(clear — fresh browser)' }, ...CHANGELOG_RELEASES.map((release) => ({ value: release.id, label: release.id }))]}
                />
            </div>
            <ChangelogNotice />
        </main>
    );
}
