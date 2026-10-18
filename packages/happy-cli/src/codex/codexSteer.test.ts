import { describe, expect, it, vi } from 'vitest';
import { steerIntoRunningTurn, type CodexSteerDeps } from './codexSteer';

type Att = { name: string };
type Staged = { path: string; mimeType: string };

function deps(overrides: Partial<CodexSteerDeps<Att, Staged>> = {}) {
    const d: CodexSteerDeps<Att, Staged> = {
        ownsTurn: () => true,
        steer: vi.fn(async () => 'steered' as const),
        stage: vi.fn(async (attachments: Att[]) => attachments.map((a) => ({ path: `/staged/${a.name}`, mimeType: a.name.endsWith('.png') ? 'image/png' : 'text/plain' }))),
        withAttachments: (text, staged) => staged.length ? `${text}\n<attached_files>${staged.map((s) => s.path).join(',')}</attached_files>` : text,
        unlink: vi.fn(async () => undefined),
        isImage: (file) => file.mimeType.startsWith('image/'),
        onSteered: vi.fn(),
        log: vi.fn(),
        ...overrides,
    };
    return d;
}

describe('steerIntoRunningTurn (B-628)', () => {
    it('sends text, image paths and the file manifest into the running turn under the message\'s localKey', async () => {
        const d = deps();
        await expect(steerIntoRunningTurn(d, 'also lint', [{ name: 'shot.png' }, { name: 'notes.txt' }], 'local-1')).resolves.toBe(true);
        expect(d.steer).toHaveBeenCalledWith({
            text: 'also lint\n<attached_files>/staged/shot.png,/staged/notes.txt</attached_files>',
            images: ['/staged/shot.png'],
            clientId: 'local-1',
        });
        expect(d.onSteered).toHaveBeenCalledWith('also lint');
        expect(d.unlink).not.toHaveBeenCalled();
    });

    it('does not even stage when the runner owns no turn', async () => {
        const d = deps({ ownsTurn: () => false });
        await expect(steerIntoRunningTurn(d, 'x', [{ name: 'a.txt' }], 'k')).resolves.toBe(false);
        expect(d.stage).not.toHaveBeenCalled();
        expect(d.steer).not.toHaveBeenCalled();
    });

    it.each(['no-turn', 'unsupported', 'refused', 'failed'] as const)('falls back to the queue on %s and removes the staged copies', async (outcome) => {
        const d = deps({ steer: vi.fn(async () => outcome) });
        await expect(steerIntoRunningTurn(d, 'x', [{ name: 'a.txt' }], 'k')).resolves.toBe(false);
        expect(d.unlink).toHaveBeenCalledWith('/staged/a.txt');
        expect(d.onSteered).not.toHaveBeenCalled();
        expect(d.log).toHaveBeenCalledWith(expect.stringContaining(outcome));
    });

    it('a thrown steer is a fallback too, never a lost message', async () => {
        const d = deps({ steer: vi.fn(async () => { throw new Error('stdin not writable'); }) });
        await expect(steerIntoRunningTurn(d, 'x', undefined, 'k')).resolves.toBe(false);
        expect(d.log).toHaveBeenCalledWith(expect.stringContaining('stdin not writable'));
    });

    it('a failed unlink of a staged copy does not turn a fallback into an error', async () => {
        const d = deps({ steer: vi.fn(async () => 'refused' as const), unlink: vi.fn(async () => { throw new Error('EACCES'); }) });
        await expect(steerIntoRunningTurn(d, 'x', [{ name: 'a.txt' }], 'k')).resolves.toBe(false);
    });
});
