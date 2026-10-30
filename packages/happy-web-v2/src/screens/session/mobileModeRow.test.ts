import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');
const popup = readFileSync(new URL('./ModelEffortMenu.tsx', import.meta.url), 'utf8');

describe('compact model and effort entry', () => {
    it('owns the effort stops inside the run-setup panel instead of the composer row, without a nested picker', () => {
        expect(source).toMatch(/<ModelEffortMenu\s/);
        expect(source.match(/<ModeMenu\s/g)).toHaveLength(1);
        expect(source).not.toMatch(/<EffortSegments\s/);
        expect(popup).toMatch(/<EffortSegments \{\.\.\.effort\} \/>/);
        // B-849a: phones get one sheet; the model list is flat rows, not a Combobox in a popover.
        expect(popup).not.toMatch(/<Combobox/);
    });
});
