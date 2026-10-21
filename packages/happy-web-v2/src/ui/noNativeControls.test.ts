import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script without types
import { codeLines, findNativeControls } from '../../../../scripts/dev/check-design-lint.mjs';

/**
 * B-714 — the whole web app (dev harnesses and the public Landing included) has
 * no native select / option / datalist / checkbox / summary left: SelectMenu,
 * Combobox, Segmented, SuggestInput, Checkbox and Summary replace them. The
 * design lint blocks new ones on changed lines; this pins the existing tree.
 * Same matcher as the lint (comments and string literals do not count).
 */
const SRC = join(__dirname, '..');

function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) yield* walk(path);
        else if (name.endsWith('.tsx') && !name.includes('.test.')) yield path;
    }
}

describe('B-714 no native form controls', () => {
    it('no <select>, <option>, <datalist>, checkbox input or <summary> outside ui/Checkbox and ui/Summary', () => {
        const hits: string[] = [];
        for (const file of walk(SRC)) {
            const rel = relative(SRC, file);
            (codeLines(readFileSync(file, 'utf8'), 'tsx') as string[]).forEach((line, i) => {
                for (const hit of findNativeControls(line, rel) as { kind: string }[]) hits.push(`${rel}:${i + 1} ${hit.kind}`);
            });
        }
        expect(hits).toEqual([]);
    });
});
