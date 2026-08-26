import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const input = readFileSync(new URL('./input.css', import.meta.url), 'utf8');
const modeMenu = readFileSync(new URL('./modemenu.css', import.meta.url), 'utf8');
const session = readFileSync(new URL('./session.css', import.meta.url), 'utf8');
const component = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');

describe('mobile composer layout contract', () => {
    it('keeps settings in one stable equal-width row with truncated values', () => {
        expect(input).toMatch(/@media \(max-width: 600px\), \(pointer: coarse\)[\s\S]*\.ci-modes \{[\s\S]*grid-auto-flow: column;[\s\S]*grid-auto-columns: minmax\(0, 1fr\);/);
        expect(modeMenu).toMatch(/@media \(max-width: 600px\), \(pointer: coarse\)[\s\S]*\.mm-v \{[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
    });

    it('gives the text its own row and keeps controls in a fixed toolbar below it', () => {
        expect(component).toContain('<div className="ci-composer-toolbar">');
        expect(component).toContain('<div className="ci-composer-tools">');
        expect(input).toMatch(/\.ci-textarea \{[\s\S]*grid-row: 1;[\s\S]*min-height: 72px;/);
        expect(input).toMatch(/\.ci-composer-toolbar \{[\s\S]*grid-row: 2;[\s\S]*justify-content: space-between;/);
    });

    it('clips transcript painting at the in-flow footer boundary during keyboard resize', () => {
        expect(session).toMatch(/\.sd-body \{[\s\S]*overflow: hidden;/);
        expect(session).toMatch(/\.sd-foot \{[\s\S]*position: relative;[\s\S]*z-index: 1;/);
        expect(session).toContain(".sd[data-keyboard-open='true']");
    });
});
