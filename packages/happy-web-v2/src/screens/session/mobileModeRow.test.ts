import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');
const popup = readFileSync(new URL('./ModelEffortMenu.tsx', import.meta.url), 'utf8');

describe('compact model and effort entry', () => {
    it('owns the slider inside the model popup instead of the composer row', () => {
        expect(source).toMatch(/<ModelEffortMenu\s/);
        expect(source.match(/<ModeMenu\s/g)).toHaveLength(1);
        expect(source).not.toMatch(/<EffortSlider\s/);
        expect(popup).toMatch(/<Popover.Content[\s\S]*<select[\s\S]*<EffortSlider \{\.\.\.effort\} \/>/);
    });
});
