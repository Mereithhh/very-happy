/**
 * B-889: in 新建团队 / 新建项目 the folder list ignored the wheel and touch —
 * only dragging the scrollbar moved it. The picker host was a block box with
 * `overflow: auto`, so the height never reached .fsb-list and the HOST
 * scrolled; the global `#root [class*='list'] { overscroll-behavior: contain }`
 * on the (never scrollable) .fsb-list then stopped the scroll from chaining to
 * the host. 新建终端's `.ns-browse` (display: flex) scrolled, but on a phone the
 * dialog's flex column shrank it to 2px — no list at all.
 *
 * Guards: every fixed-height box wrapping `<FsBrowser … onPickDir>` is a
 * non-shrinking flex box that clips instead of scrolling, so the list itself is the scroller; and
 * a <Checkbox> label on the Teams screen is never forced into the column
 * layout of the generic `.teams-screen label` field rule.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../..', import.meta.url).pathname;

function files(dir: string, ext: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path, ext) : name.endsWith(ext) && !name.includes('.test.') ? [path] : [];
    });
}

const rules = files(SRC, '.css').flatMap((path) => {
    const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({ file: relative(SRC, path), selectors: m[1].split(',').map((x) => x.trim()), body: m[2] }));
});

/** The class of the element directly wrapping each `<FsBrowser … onPickDir=…>`. */
function pickerHosts(): { file: string; host: string }[] {
    return files(join(SRC, 'screens'), '.tsx').flatMap((path) => {
        const src = readFileSync(path, 'utf8');
        return [...src.matchAll(/className="([\w-]+)"\s*>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<FsBrowser\b([\s\S]*?)\/>/g)]
            .filter((m) => m[2].includes('onPickDir'))
            .map((m) => ({ file: relative(SRC, path), host: m[1] }));
    });
}

function declarations(selector: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rule of rules) {
        if (!rule.selectors.includes(selector)) continue;
        for (const decl of rule.body.split(';')) {
            const i = decl.indexOf(':');
            if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
        }
    }
    return out;
}

describe('B-889 FsBrowser picker hosts', () => {
    it('finds every inline folder picker (team, project, terminal)', () => {
        expect(pickerHosts().map((h) => h.host).sort()).toEqual(['ns-browse', 'pj-folder-browser', 'team-folder-browser']);
    });

    it.each(pickerHosts())('$host ($file) hands its height to the list', ({ host }) => {
        const d = declarations(`.${host}`);
        expect(d.display).toBe('flex');
        expect(d.flex).toBe('none');
        expect(d.overflow).toBe('hidden');
        expect(d.height).toMatch(/px$/);
    });

    it('the list is the scroller and stays inside its host', () => {
        expect(declarations('.fsb-list')).toMatchObject({ flex: '1', 'min-height': '0', 'overflow-y': 'auto' });
        expect(declarations('.fsb-shell')).toMatchObject({ display: 'flex', flex: '1', 'min-height': '0' });
    });
});

describe('B-889 Teams checkbox rows', () => {
    it('the generic column label rule skips <Checkbox> labels', () => {
        const columnRule = rules.find((r) => r.file === 'screens/teams/teams.css' && /flex-direction:\s*column/.test(r.body) && r.selectors.some((s) => s.startsWith('.teams-screen label')));
        expect(columnRule?.selectors).toContain('.teams-screen label:where(:not(.vh-checkbox))');
        expect(columnRule?.selectors).not.toContain('.teams-screen label');
    });
});
