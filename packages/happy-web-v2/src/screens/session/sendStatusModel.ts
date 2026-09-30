/**
 * B-513: how a user turn shows its delivery state. Pure, shared by the
 * transcript bubble and the queue dock.
 */
import type { SendState } from '@/sync/typesMessage';

export type TurnSendStatus = {
    state: SendState;
    /** The localId to act on (retry re-sends the whole turn from any member). */
    localId: string;
    /** Only a text-only turn that provably never reached storage can be taken back. */
    restorable: boolean;
};

type SendItem = { localId: string | null; sendState?: SendState; sendRestorable?: true };

/**
 * failed > sending: one failed item makes the turn failed. `restorable` comes
 * from the text message alone and only when the turn has no other items —
 * attachments are released after sending and cannot go back to the composer.
 */
export function turnSendStatus(text: SendItem, attachments: readonly SendItem[] = []): TurnSendStatus | null {
    const items = [text, ...attachments];
    const failed = items.find((item) => item.sendState === 'failed' && item.localId);
    const sending = items.find((item) => item.sendState === 'sending' && item.localId);
    const pick = failed ?? sending;
    if (!pick?.localId || !pick.sendState) return null;
    return {
        state: pick.sendState,
        localId: pick.localId,
        restorable: pick.sendState === 'failed'
            && attachments.length === 0
            && text.sendState === 'failed'
            && text.sendRestorable === true,
    };
}

/** Spinner appears only after this long in `sending`, so fast acks never flash. */
export const SEND_SPINNER_DELAY_MS = 150;

/**
 * When each localId entered `sending`, kept outside React so a re-render or a
 * row moving between transcript and queue dock does not restart the delay.
 */
const sendingSince = new Map<string, number>();

/** Returns ms left before the spinner may show (0 = show now). Records the start on first sight. */
export function sendSpinnerRemaining(localId: string, now: number): number {
    let since = sendingSince.get(localId);
    if (since === undefined) {
        since = now;
        sendingSince.set(localId, since);
    }
    return Math.max(0, SEND_SPINNER_DELAY_MS - (now - since));
}

/** Forget the start once the item left `sending` (a retry starts a new delay). */
export function clearSendSpinner(localId: string): void {
    sendingSince.delete(localId);
}
