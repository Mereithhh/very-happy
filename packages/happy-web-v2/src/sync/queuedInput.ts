/**
 * Web-owned compatibility model for ordinary chat input submitted while an
 * agent turn is running. It intentionally depends only on existing turn-end
 * events so old daemon/CLI versions participate without an upgrade.
 */
export function queuedAtForSend(
    isThinking: boolean,
    source: string,
    now: () => number = Date.now,
): number | undefined {
    return isThinking && source !== 'question' ? now() : undefined;
}

export type QueuedInputOrder = {
    queuedAt: number;
    seq?: number | null;
};

export type TurnEndBoundary = {
    createdAt: number;
    seq?: number | null;
};

export function firstTurnEndForQueuedInput(
    input: QueuedInputOrder,
    turnEnds: readonly TurnEndBoundary[],
): TurnEndBoundary | undefined {
    const inputSeq = input.seq;
    if (typeof inputSeq === 'number') {
        return turnEnds
            .filter((boundary): boundary is TurnEndBoundary & { seq: number } =>
                typeof boundary.seq === 'number' && boundary.seq >= inputSeq)
            .sort((a, b) => a.seq - b.seq)[0];
    }
    return turnEnds
        .filter((boundary) => boundary.createdAt >= input.queuedAt)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
}
