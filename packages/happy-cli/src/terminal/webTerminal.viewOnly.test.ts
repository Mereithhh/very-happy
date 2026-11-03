import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTmux, tmuxAvailable } from '@/testing/isolatedTmux';

// B-878: a view-only share viewer attaches through the server broker with
// `viewOnly` and must never change the owner's pane size; the owner's own
// opens keep resizing exactly as before. Real tmux on a private socket.
const happyHome = mkdtempSync(join(tmpdir(), 'vh-viewonly-home-'));
const prevHome = process.env.HAPPY_HOME_DIR;
process.env.HAPPY_HOME_DIR = happyHome;
const iso = createIsolatedTmux('vh-viewonly');
const { WebTerminalManager, viewOnlyGeometry, parseTmuxWindowSize } = await import('./webTerminal');

afterAll(() => {
    iso.dispose();
    if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
    rmSync(happyHome, { recursive: true, force: true });
});

describe('B-878 view-only geometry (pure)', () => {
    it('prefers the live session, then the tmux window, then the request', () => {
        expect(viewOnlyGeometry({ cols: 120, rows: 40 }, { cols: 90, rows: 30 }, { cols: 50, rows: 10 })).toEqual({ cols: 120, rows: 40 });
        expect(viewOnlyGeometry(undefined, { cols: 90, rows: 30 }, { cols: 50, rows: 10 })).toEqual({ cols: 90, rows: 30 });
        expect(viewOnlyGeometry(undefined, null, { cols: 50, rows: 10 })).toEqual({ cols: 50, rows: 10 });
    });

    it('parses `#{window_width} #{window_height}` and rejects junk', () => {
        expect(parseTmuxWindowSize('132 41\n')).toEqual({ cols: 132, rows: 41 });
        for (const bad of ['', '132', 'a b', '1 1', '0 40', '99999 3', null, undefined]) expect(parseTmuxWindowSize(bad)).toBeNull();
    });
});

describe.skipIf(!tmuxAvailable)('B-878 open-terminal viewOnly never resizes the pane', () => {
    const mgr = new WebTerminalManager(() => { /* stream not under test */ });
    afterAll(() => { mgr.disposeAll(); mgr.stopListTracking(); });
    const windowSize = (id: string) => (iso.run('display-message', '-p', '-t', `=vh-${id}:`, '#{window_width}x#{window_height}').stdout ?? '').trim();
    const settle = async (id: string, expected: string) => {
        for (let i = 0; i < 50 && windowSize(id) !== expected; i++) await new Promise((r) => setTimeout(r, 40));
        return windowSize(id);
    };

    it('owner open resizes (unchanged behaviour); a viewOnly attach of a live terminal does not', async () => {
        await mgr.open({ terminalId: 'vo000001', cols: 100, rows: 30, cwd: iso.dir });
        expect(await settle('vo000001', '100x30')).toBe('100x30');
        const viewer = await mgr.open({ terminalId: 'vo000001', cols: 40, rows: 12, viewOnly: true });
        expect(viewer).toMatchObject({ terminalId: 'vo000001', viewOnly: true, paneCols: 100, paneRows: 30 });
        await new Promise((r) => setTimeout(r, 300));
        expect(windowSize('vo000001')).toBe('100x30');
        // The owner's own re-attach still declares its size (B-287 latest wins).
        await mgr.open({ terminalId: 'vo000001', cols: 90, rows: 25, attachOnly: true });
        expect(await settle('vo000001', '90x25')).toBe('90x25');
    });

    it('a cold viewOnly attach (daemon holds no client) declares the window size, not the request', async () => {
        await mgr.open({ terminalId: 'vo000002', cols: 110, rows: 33, cwd: iso.dir });
        expect(await settle('vo000002', '110x33')).toBe('110x33');
        mgr.unsubscribe('vo000002');
        mgr.disposeAll(); // drop the daemon's control client; the tmux session survives
        expect(iso.hasSession('vh-vo000002')).toBe(true);
        const cold = await mgr.open({ terminalId: 'vo000002', cols: 30, rows: 10, viewOnly: true });
        expect(cold).toMatchObject({ viewOnly: true, paneCols: 110, paneRows: 33 });
        await new Promise((r) => setTimeout(r, 300));
        expect(windowSize('vo000002')).toBe('110x33');
    });

    it('second layer: input / resize tagged with a view-only grant is refused; the owner and an operator are not', async () => {
        await mgr.open({ terminalId: 'vo000004', cols: 100, rows: 30, cwd: iso.dir });
        await mgr.open({ terminalId: 'vo000004', viewOnly: true, shareGrantId: 'g-view' });
        expect(mgr.dropViewOnlyShareEvent('input', 'vo000004', 'g-view')).toBe(true);
        expect(mgr.dropViewOnlyShareEvent('resize', 'vo000004', 'g-view')).toBe(true);
        // The owner's own frames carry no grant; another terminal or grant is untouched.
        expect(mgr.dropViewOnlyShareEvent('input', 'vo000004', undefined)).toBe(false);
        expect(mgr.dropViewOnlyShareEvent('input', 'vo000004', 'g-other')).toBe(false);
        expect(mgr.dropViewOnlyShareEvent('input', 'vo000001', 'g-view')).toBe(false);
        // Tier raised: the same grant attaches as an operator and may type.
        await mgr.open({ terminalId: 'vo000004', cols: 100, rows: 30, attachOnly: true, shareGrantId: 'g-view' });
        expect(mgr.dropViewOnlyShareEvent('input', 'vo000004', 'g-view')).toBe(false);
    });

    it('viewOnly never creates a terminal', async () => {
        await expect(mgr.open({ terminalId: 'vo000003', cols: 80, rows: 24, viewOnly: true, cwd: iso.dir })).rejects.toThrow('terminal-gone');
        expect(iso.hasSession('vh-vo000003')).toBe(false);
    });
});

describe('B-878 daemon wiring: the view-only check runs before the write / resize', () => {
    const src = readFileSync(join(__dirname, '../api/apiMachine.ts'), 'utf8');
    it('terminal-input and terminal-resize consult dropViewOnlyShareEvent first', () => {
        const input = src.slice(src.indexOf("socket.on('terminal-input'"), src.indexOf("this.webTerminal.write(data.terminalId, payload);"));
        expect(input).toContain("if (this.webTerminal.dropViewOnlyShareEvent('input', data?.terminalId, data?.shareGrantId)) return;");
        const resize = src.slice(src.indexOf("socket.on('terminal-resize'"), src.indexOf("this.webTerminal.resize(data.terminalId, data.cols, data.rows);"));
        expect(resize).toContain("if (this.webTerminal.dropViewOnlyShareEvent('resize', data?.terminalId, data?.shareGrantId)) return;");
    });
});
