import { createContext } from 'react';

/**
 * B-833: a longer preview with an in-place 「展开全文」 — set by the lead view
 * on the newest batch of member messages (LeadFoldPreview), read by
 * TeamMessageCard. Null: the 3-line card that opens the reader. Its own
 * module so the lead view does not pull the card's imports into ChatList's.
 */
export const TeamCardPreviewContext = createContext<{ lines: number; expand: string; collapse: string } | null>(null);
