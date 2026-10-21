/**
 * B-722: the brief 「已发送」 moment after the server confirmed an input.
 *
 * The reducer drops `sendState` on the ack, so the transcript alone cannot
 * tell "just confirmed" from "always was". The outbox records the moment
 * here, keyed by localId (a row may move from the queue dock to the
 * transcript and must keep its flash); entries expire on their own, so no
 * permanent mark is left on the message.
 */
import { create } from 'zustand';

/** How long the sent check stays (CSS fades it out over the tail of this window). */
export const SENT_FLASH_MS = 1600;

type SendConfirmationsState = {
    /** localId → confirmation time (ms epoch). */
    confirmedAt: Record<string, number>;
};

export const useSendConfirmations = create<SendConfirmationsState>(() => ({ confirmedAt: {} }));

const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Pure: is a confirmation at `confirmedAt` still showing at `now`? */
export function isSentFlashActive(confirmedAt: number | undefined, now: number, windowMs: number = SENT_FLASH_MS): boolean {
    return typeof confirmedAt === 'number' && now - confirmedAt >= 0 && now - confirmedAt < windowMs;
}

/** The outbox calls this with the localIds the server just acknowledged. */
export function markSendConfirmed(localIds: readonly string[], now: number = Date.now()): void {
    if (localIds.length === 0) return;
    const next = { ...useSendConfirmations.getState().confirmedAt };
    for (const localId of localIds) {
        next[localId] = now;
        const existing = expiryTimers.get(localId);
        if (existing) clearTimeout(existing);
        expiryTimers.set(localId, setTimeout(() => forget(localId), SENT_FLASH_MS));
    }
    useSendConfirmations.setState({ confirmedAt: next });
}

function forget(localId: string) {
    expiryTimers.delete(localId);
    const current = useSendConfirmations.getState().confirmedAt;
    if (!(localId in current)) return;
    const next = { ...current };
    delete next[localId];
    useSendConfirmations.setState({ confirmedAt: next });
}

/** True while this localId's 「已发送」 check should show. */
export function useJustSent(localId: string | null | undefined): boolean {
    const confirmedAt = useSendConfirmations((state) => (localId ? state.confirmedAt[localId] : undefined));
    return isSentFlashActive(confirmedAt, Date.now());
}

export function __resetSendConfirmationsForTests(): void {
    for (const timer of expiryTimers.values()) clearTimeout(timer);
    expiryTimers.clear();
    useSendConfirmations.setState({ confirmedAt: {} });
}
