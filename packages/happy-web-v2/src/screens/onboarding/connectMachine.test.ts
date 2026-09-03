import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * B-296. The connect-a-machine instructions existed only inside FirstRunScreen,
 * which `shouldShowFirstRun` retires forever once the account has one machine.
 * These assertions pin every doorway that was missing, so removing one is a
 * test failure rather than a silent dead end again.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('connect-a-machine doorways', () => {
    it('the guide is one component, rendered by both entry points', () => {
        expect(read('./FirstRunScreen.tsx')).toContain('<ConnectMachineGuide />');
        expect(read('./ConnectMachineScreen.tsx')).toContain('<ConnectMachineGuide />');
        // The commands themselves must not be duplicated anywhere else.
        expect(read('./FirstRunScreen.tsx')).not.toContain('npm install -g very-happy-cli');
        expect(read('./ConnectMachineScreen.tsx')).not.toContain('npm install -g very-happy-cli');
    });

    it('/machine/connect is a static route that outranks machine/:id', () => {
        const routes = read('../../app/AppRoot.tsx');
        expect(routes).toContain("{ path: 'machine/connect', element: <Lazy><ConnectMachineScreen /></Lazy> },");
        expect(routes.indexOf("path: 'machine/connect'")).toBeLessThan(routes.indexOf("path: 'machine/:id'"));
    });

    it('every "no online machine" dead end offers the guide', () => {
        for (const modal of ['NewSessionModal', 'NewTerminalModal', 'AttachTmuxModal', 'ImportClaudeHistoryModal']) {
            const source = read(`../sessions/${modal}.tsx`);
            expect(source, modal).toContain('<NoMachinesNotice onClose={onClose} />');
            expect(source, modal).not.toContain('"ns-empty">{t(\'machine.noMachines\')}');
        }
        expect(read('../sessions/NoMachinesNotice.tsx')).toContain("navigate('/machine/connect')");
    });

    it('the new-session and new-terminal pickers keep the doorway even when machines exist', () => {
        for (const modal of ['NewSessionModal', 'NewTerminalModal']) {
            expect(read(`../sessions/${modal}.tsx`), modal).toContain('<ConnectMachineLink onClose={onClose} />');
        }
    });

    it('settings → machines links to it', () => {
        const source = read('../settings/MachinesSettings.tsx');
        expect(source).toContain("navigate('/machine/connect')");
        expect(source).toContain("t('connectMachine.cta')");
    });
});
