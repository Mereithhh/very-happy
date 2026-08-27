import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./input.css', import.meta.url), 'utf8');
const inputSource = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');
const dialogSource = readFileSync(new URL('./SessionOptionsDialog.tsx', import.meta.url), 'utf8');
const dialogStyles = readFileSync(new URL('./sessionOptionsDialog.css', import.meta.url), 'utf8');

describe('mobile composer session options', () => {
    it('replaces the three desktop mode pills with one dialog trigger', () => {
        const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 600px)'));
        expect(mobileStyles).toMatch(/\.ci-modes\s*{[^}]*display:\s*none;/s);
        expect(mobileStyles).toMatch(/\.ci-mobile-options\s*{[^}]*display:\s*flex;/s);
        expect(inputSource).toContain('<SessionOptionsDialog');
        expect(dialogSource).toContain('<Dialog.Root');
        expect(dialogSource).toContain('<OptionField {...model} />');
        expect(dialogSource).toContain('<OptionField {...permission} />');
        expect(dialogSource).toContain('<OptionField {...effort} />');
        expect(dialogStyles).toMatch(/@media \(max-width: 600px\)[\s\S]*\.so-dialog\s*{[^}]*bottom:\s*0;/);
    });
});
