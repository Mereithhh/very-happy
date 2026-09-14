import { describe, expect, it, vi } from 'vitest';
import { createTurnSteeringController } from './turnSteering';

describe('turn steering controller', () => {
    it('interrupts one turn and consumes exactly one cancelled result', async () => {
        const controller = createTurnSteeringController();
        const interrupt = vi.fn(async () => undefined);
        controller.setInterrupt(interrupt);

        await expect(controller.steer()).resolves.toBe(true);
        expect(interrupt).toHaveBeenCalledOnce();
        expect(controller.consumeReady()).toBe(true);
        expect(controller.consumeReady()).toBe(false);
    });

    it('does not mark a turn as steered when interrupt is unavailable or fails', async () => {
        const controller = createTurnSteeringController();
        await expect(controller.steer()).resolves.toBe(false);
        controller.setInterrupt(async () => { throw new Error('unsupported'); });
        await expect(controller.steer()).rejects.toThrow('unsupported');
        expect(controller.consumeReady()).toBe(false);
    });

    it('interruptTurn stops the turn WITHOUT the steering flag (stop button, not steer)', async () => {
        const controller = createTurnSteeringController();
        const interrupt = vi.fn(async () => undefined);
        controller.setInterrupt(interrupt);

        await expect(controller.interruptTurn()).resolves.toBe(true);
        expect(interrupt).toHaveBeenCalledOnce();
        // Unlike steer(), a plain abort must NOT arm a follow-up injection:
        // the turn just ends and the streaming query waits for the next message.
        expect(controller.consumeReady()).toBe(false);
    });

    it('interruptTurn returns false when no query is attached', async () => {
        const controller = createTurnSteeringController();
        await expect(controller.interruptTurn()).resolves.toBe(false);
        expect(controller.consumeInterrupted()).toBe(false);
    });

    it('B-468: interruptTurn marks exactly one result as user-interrupted', async () => {
        const controller = createTurnSteeringController();
        controller.setInterrupt(async () => undefined);
        await controller.interruptTurn();
        expect(controller.consumeReady()).toBe(false);      // still not a steer
        expect(controller.consumeInterrupted()).toBe(true);
        expect(controller.consumeInterrupted()).toBe(false); // consumed once
        // a failed interrupt leaves nothing behind
        controller.setInterrupt(async () => { throw new Error('gone'); });
        await expect(controller.interruptTurn()).rejects.toThrow('gone');
        expect(controller.consumeInterrupted()).toBe(false);
        // reset clears a pending mark
        controller.setInterrupt(async () => undefined);
        await controller.interruptTurn();
        controller.reset();
        expect(controller.consumeInterrupted()).toBe(false);
    });
});

describe('B-468: the remote launcher turns a graceful stop into "Aborted by user"', () => {
    // Verified with scripts/dev/mutation-check.mjs (see PR).
    it('closes the interrupted result as cancelled with the lifecycle event, and never lets the mark leak to the next turn', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(__dirname, 'claudeRemoteLauncher.ts'), 'utf8');
        expect(src).toContain([
            '                        if (turnSteering.consumeInterrupted()) {',
            "                            session.client.closeClaudeSessionTurn('cancelled');",
            "                            session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });",
            '                            return;',
            '                        }',
        ].join('\n'));
        // the interrupted branch sits before the failed/completed lifecycle mapping
        expect(src.indexOf('turnSteering.consumeInterrupted()')).toBeLessThan(src.indexOf('applyClaudeResultLifecycle(result, {'));
        // escalating to the hard abort drops the mark (the hard path emits its own event)
        const escalation = src.indexOf("escalating to hard abort");
        expect(src.slice(escalation, escalation + 400)).toContain('turnSteering.consumeInterrupted();');
    });
});
