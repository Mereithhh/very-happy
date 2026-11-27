/**
 * B-982 global notices — `GET /v1/notices` (operator notices addressed to
 * this account, inside their time window, newest first). An older server
 * answers 404: that is "no notices", not an error.
 */
import { NOTICES_PATH, parseNoticesResponse, type NoticeView } from '@slopus/happy-wire';
import { getCurrentAuth } from '@/auth/AuthContext';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { getHappyClientId } from './apiSocket';
import { getServerUrl } from './serverConfig';

/** The notices, `[]` when the server has none or predates them, `null` when the request failed (keep what is shown). */
export async function fetchNotices(): Promise<NoticeView[] | null> {
    const credentials = getCurrentAuth()?.credentials;
    if (!credentials) return null;
    try {
        const response = await fetch(`${getServerUrl()}${NOTICES_PATH}`, {
            headers: { Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': getHappyClientId() },
        });
        assertNotAuthFailure(response, 'apiNotices');
        if (response.status === 404) return [];
        if (!response.ok) return null;
        return parseNoticesResponse(await response.json());
    } catch {
        return null;
    }
}
