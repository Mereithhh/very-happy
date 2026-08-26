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

    it('keeps send available beside stop while an agent is working', () => {
        expect(component).toContain('<div className="ci-composer-actions">');
        expect(component).toMatch(/\{isWorking && \([\s\S]*ci-send--abort[\s\S]*\)\}[\s\S]*aria-label=\{t\('session\.chat\.send'\)\}/);
        expect(input).toMatch(/\.ci-composer-actions \{[\s\S]*display: inline-flex;/);
    });

    it('shows explicit used and total context tokens at the right edge', () => {
        expect(component).toContain('`${contextTokens} / ${contextTotal}`');
        expect(input).toMatch(/\.ci-meter \{[\s\S]*margin-inline-start: auto;[\s\S]*white-space: nowrap;/);
    });

    it('clips transcript painting at the in-flow footer boundary during keyboard resize', () => {
        expect(session).toMatch(/\.sd-body \{[\s\S]*overflow: hidden;/);
        expect(session).toMatch(/\.sd-foot \{[\s\S]*position: relative;[\s\S]*z-index: 1;/);
        expect(session).toContain(".sd[data-keyboard-open='true']");
    });
});
