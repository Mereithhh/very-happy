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
    });
});
