/**
 * B-701: a transcript rendered for someone who cannot act on it (the anonymous
 * share-link page). Message actions — copy/quote included — are not rendered:
 * edit / delete / rewind are owner RPCs, and the viewer has no session.
 */
import { createContext, useContext } from 'react';

export const ReadOnlyTranscriptContext = createContext(false);
export function useReadOnlyTranscript(): boolean {
    return useContext(ReadOnlyTranscriptContext);
}
