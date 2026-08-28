export type ServiceEventPresentation =
    | { kind: 'hidden' }
    | { kind: 'stopped'; textKey: 'session.chat.stoppedByYou' }
    | { kind: 'error'; textKey: 'session.chat.processFailed' }
    | { kind: 'subtle'; text: string };

export function presentServiceEvent(message: string): ServiceEventPresentation {
    const trimmed = message.trim();
    const sdkErrorPrefix = 'claude code returned an error result:';
    const payload = trimmed.toLowerCase().startsWith(sdkErrorPrefix)
        ? trimmed.slice(sdkErrorPrefix.length).trim()
        : trimmed;
    const entries = payload.split(/[;\n]+/).map((entry) => entry.trim()).filter(Boolean);
    const visibleEntries = entries.filter((entry) => !entry.startsWith('[ede_diagnostic]'));
    if (visibleEntries.length === 0 && visibleEntries.length !== entries.length) {
        return { kind: 'hidden' };
    }
    const visibleMessage = visibleEntries.length !== entries.length
        ? visibleEntries.join('\n')
        : trimmed;
    const normalized = visibleMessage.toLowerCase();
    if (normalized === 'aborted by user' || normalized === 'turn aborted') {
        return { kind: 'stopped', textKey: 'session.chat.stoppedByYou' };
    }
    if (normalized === 'process exited unexpectedly') {
        return { kind: 'error', textKey: 'session.chat.processFailed' };
    }
    return { kind: 'subtle', text: visibleMessage };
}
