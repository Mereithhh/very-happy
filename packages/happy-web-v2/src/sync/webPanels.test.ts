import { describe, expect, it } from 'vitest';
import { machinePanelPath, panelFrameMode, parseWebPanels } from './webPanels';

describe('B-510 parseWebPanels', () => {
    it('reads the mirrored list and drops anything a browser should not load', () => {
        const panels = parseWebPanels({ webPanels: { updatedAt: 1, panels: [
            { id: 'desktop', title: 'Desktop', url: 'https://dev.example.ts.net/vnc.html', embed: true },
            { id: 'dev', title: '', url: 'http://localhost:5173/', embed: false },
            { id: 'lan', title: 'x', url: 'http://10.0.0.2/' },
            { id: 'creds', title: 'x', url: 'https://u:p@a.example.com/' },
            { id: 'js', title: 'x', url: 'javascript:alert(1)' },
            { id: 'Bad', title: 'x', url: 'https://a.example.com/' },
            { id: 'desktop', title: 'dup', url: 'https://b.example.com/' },
        ] } });
        expect(panels).toEqual([
            { id: 'desktop', title: 'Desktop', url: 'https://dev.example.ts.net/vnc.html', embed: true },
            { id: 'dev', title: 'dev', url: 'http://localhost:5173/', embed: false },
        ]);
    });

    it('old daemons (no field) and junk give no panels', () => {
        expect(parseWebPanels({})).toEqual([]);
        expect(parseWebPanels(null)).toEqual([]);
        expect(parseWebPanels({ webPanels: { panels: 'x' } })).toEqual([]);
    });
});

describe('B-510 panelFrameMode', () => {
    it('embed:false → link only; https page + plain-http LAN panel → mixed content; else embed', () => {
        expect(panelFrameMode({ url: 'https://a.example.com/', embed: false }, 'https:')).toBe('link-only');
        expect(panelFrameMode({ url: 'http://100.64.0.2:6080/', embed: true }, 'https:')).toBe('mixed-content');
        expect(panelFrameMode({ url: 'http://localhost:5173/', embed: true }, 'https:')).toBe('embed');
        expect(panelFrameMode({ url: 'http://100.64.0.2:6080/', embed: true }, 'http:')).toBe('embed');
        expect(panelFrameMode({ url: 'https://a.example.com/', embed: true }, 'https:')).toBe('embed');
    });

    it('deep link', () => {
        expect(machinePanelPath('m 1', 'desktop')).toBe('/machine/m%201/panel/desktop');
    });
});
