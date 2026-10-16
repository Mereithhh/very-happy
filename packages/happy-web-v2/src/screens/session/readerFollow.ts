/**
 * B-607: ChatList tells the rows inside it whether the reader is following
 * the live end. A row that is about to collapse content on its own (the
 * finished turn's activity folding) asks first, so it never pulls the text
 * out from under someone who scrolled up to read it.
 *
 * Outside a ChatList (dev harnesses, tests) there is no reader to protect:
 * the default says "following", which keeps the old fold-on-done behaviour.
 */
import { createContext } from 'react';

export const ReaderFollowContext = createContext<() => boolean>(() => true);
