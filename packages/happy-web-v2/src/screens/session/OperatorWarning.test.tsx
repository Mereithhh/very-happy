// @vitest-environment happy-dom
/**
 * B-900 QA65 P2-2: one confirmation covering terminals on several machines says "each machine listed",
 * not "this machine"; the single-terminal wording is unchanged.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'zh-Hans' }) }));
const { OperatorWarning } = await import('./OperatorGrant');

function render(node: React.ReactNode): string {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(node));
    const html = host.innerHTML;
    act(() => root.unmount());
    return html;
}

describe('OperatorWarning machine wording', () => {
    it('one machine keeps the singular lines', () => {
        const html = render(<OperatorWarning compact />);
        for (const k of ['warningTitle', 'warningRead', 'warningRun']) expect(html).toContain(`share.operator.${k}<`);
        expect(html).not.toContain('Many');
    });
    it('several machines use the plural lines', () => {
        const html = render(<OperatorWarning compact manyMachines />);
        for (const k of ['warningTitleMany', 'warningReadMany', 'warningRunMany']) expect(html).toContain(`share.operator.${k}`);
        expect(html).toContain('share.operator.warningBackground');
    });
    it('the batch confirmation picks the plural tick and warning when machines > 1', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/screens/projects/ProjectOperateAll.tsx'), 'utf8');
        expect(src).toContain('manyMachines={machines.length > 1}');
        expect(src).toContain("machines.length > 1 ? 'share.operator.acknowledgeMany' : 'share.operator.acknowledge'");
    });
});
