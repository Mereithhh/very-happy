import { describe, expect, it, vi } from 'vitest';
import { HeldInput } from './heldInput';

describe('HeldInput (B-854)', () => {
    it('tombstones a held batch with the reason it never ran', () => {
        const tombstone = vi.fn();
        const held = new HeldInput(tombstone);
        held.hold(['a', 'b']);
        expect(held.holding).toBe(true);
        expect(held.drop('failed')).toBe(true);
        expect(tombstone).toHaveBeenCalledWith(['a', 'b'], 'failed');
        expect(held.holding).toBe(false);
    });

    it('a delivered batch is never tombstoned', () => {
        const tombstone = vi.fn();
        const held = new HeldInput(tombstone);
        held.hold(['a']);
        held.delivered();
        expect(held.drop('aborted')).toBe(false);
        expect(tombstone).not.toHaveBeenCalled();
    });

    it('reports once: the turn catch and the exit path cannot both tombstone it', () => {
        const tombstone = vi.fn();
        const held = new HeldInput(tombstone);
        held.hold(['a']);
        held.drop('aborted');
        held.drop('failed');
        expect(tombstone).toHaveBeenCalledTimes(1);
        expect(tombstone).toHaveBeenCalledWith(['a'], 'aborted');
    });

    it('a batch without web ids (CLI-internal) has nothing to report', () => {
        const tombstone = vi.fn();
        const held = new HeldInput(tombstone);
        held.hold(undefined);
        expect(held.holding).toBe(false);
        held.hold([]);
        expect(held.drop('failed')).toBe(false);
        expect(tombstone).not.toHaveBeenCalled();
    });

    it('holding a new batch replaces the previous (delivered) one', () => {
        const tombstone = vi.fn();
        const held = new HeldInput(tombstone);
        held.hold(['old']);
        held.hold(['new']);
        held.drop('failed');
        expect(tombstone).toHaveBeenCalledWith(['new'], 'failed');
    });
});
