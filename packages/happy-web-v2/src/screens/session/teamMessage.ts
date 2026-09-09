import type { UserTextMessage } from '@/sync/typesMessage';

const footer = '\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.';
/** Metadata is a transport source hint, never a privilege or proof of system authority. */
export function presentTeamMessage(message: Pick<UserTextMessage, 'text' | 'meta'>): { preview: string; raw: string } | null {
    if (message.meta?.sentFrom !== 'team') return null;
    const raw = message.text;
    let body = raw.replace(/^\[Very Happy team message [^\n]+\]\n/, '');
    if (body !== raw && body.endsWith(footer)) body = body.slice(0, -footer.length);
    body = body.replace(/^Task [^\s]+\n/, '')
        .replace(/^New task [^\s]+: /, '')
        .replace(/^Task [^\s]+ submitted:\n/, 'Submitted: ')
        .replace(/^Revision requested \(attempt [^)]+\): /, 'Revision requested: ');
    // Keep unfamiliar formats visible, but hide machine IDs from the compact preview.
    const preview = body.replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '…')
        .split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 180) ?? '';
    return { preview, raw };
}
