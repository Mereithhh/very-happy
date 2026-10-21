import type { UserTextMessage } from '@/sync/typesMessage';
import { presentTeamMessage } from './teamMessage';
import { presentSessionPeerMessage } from './sessionPeerMessage';
import { presentSharedMessage } from './sharedMessage';

/**
 * B-704: the human body of a user-role message that arrived through a Very
 * Happy transport (team / another session / a shared-session driver), or null
 * for an ordinary message. Previews (board card, sidebar peek) use this so the
 * `[Very Happy … message …]` envelope and its footer never read as the text.
 */
export function protocolMessageBody(message: Pick<UserTextMessage, 'text' | 'meta' | 'displayText'>): string | null {
    const team = presentTeamMessage(message);
    if (team) return team.body;
    const peer = presentSessionPeerMessage(message);
    if (peer) return peer.body;
    const shared = presentSharedMessage(message);
    if (shared) return shared.body;
    return null;
}
