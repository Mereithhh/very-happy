export type ServiceEventPresentation =
    | { kind: 'stopped'; textKey: 'session.chat.stoppedByYou' }
    | { kind: 'error'; textKey: 'session.chat.processFailed' }
    | { kind: 'subtle'; text: string };

export function presentServiceEvent(message: string): ServiceEventPresentation {
    const normalized = message.trim().toLowerCase();
    if (normalized === 'aborted by user' || normalized === 'turn aborted') {
        return { kind: 'stopped', textKey: 'session.chat.stoppedByYou' };
    }
    if (normalized === 'process exited unexpectedly') {
        return { kind: 'error', textKey: 'session.chat.processFailed' };
    }
    return { kind: 'subtle', text: message };
}
