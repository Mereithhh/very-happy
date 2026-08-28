export function withSessionPermissionMode(
    current: Readonly<Record<string, string>>,
    sessionId: string,
    mode: string | null,
): Record<string, string> {
    const next = { ...current };
    if (mode) next[sessionId] = mode;
    else delete next[sessionId];
    return next;
}
