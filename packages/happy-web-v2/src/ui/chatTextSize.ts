/**
 * B-582 — 对话字号 (chat text size), a device-local setting.
 *
 * The chat type scale lives in styles/tokens.css: every conversation font tier
 * and the --chat-space unit are `calc(<default px> * var(--chat-scale))`, and
 * `html[data-chat-size]` picks the scale. This module only owns the choice:
 * read/normalize it from localStorage, put it on <html>, and notify React.
 *
 * Why its own localStorage key instead of LocalSettings / synced settings
 * (spec specs/2026-10-chat-type-scale.md):
 *  - text size is a screen/eyesight trait of the device (phone vs desktop), not
 *    account state, so it must not sync;
 *  - it has to be applied before the first React render (no size flash), like
 *    the theme (themePreference.ts), without parsing the whole LocalSettings
 *    blob at boot;
 *  - an unknown stored value (a future size read by an older web build) just
 *    normalizes to the default — it can never fail a whole-blob safeParse.
 * Absent attribute = default, so CSS stays pixel-identical when unset.
 */
import { useSyncExternalStore } from 'react';

export const CHAT_TEXT_SIZES = ['sm', 'md', 'lg', 'xl'] as const;
export type ChatTextSize = (typeof CHAT_TEXT_SIZES)[number];
export const DEFAULT_CHAT_TEXT_SIZE: ChatTextSize = 'md';

/** Mirrors the :root[data-chat-size] rules in tokens.css (tested). */
export const CHAT_TEXT_SCALE: Record<ChatTextSize, number> = { sm: 0.9, md: 1, lg: 1.125, xl: 1.25 };

export const CHAT_TEXT_SIZE_STORAGE = 'vh-chat-text-size';

export function normalizeChatTextSize(value: unknown): ChatTextSize {
  return typeof value === 'string' && (CHAT_TEXT_SIZES as readonly string[]).includes(value)
    ? (value as ChatTextSize)
    : DEFAULT_CHAT_TEXT_SIZE;
}

export function readChatTextSize(): ChatTextSize {
  try {
    return normalizeChatTextSize(localStorage.getItem(CHAT_TEXT_SIZE_STORAGE));
  } catch {
    return DEFAULT_CHAT_TEXT_SIZE;
  }
}

/** Default removes the attribute so the token defaults apply untouched. */
export function applyChatTextSize(size: ChatTextSize, el: { dataset: DOMStringMap } = document.documentElement): void {
  if (size === DEFAULT_CHAT_TEXT_SIZE) delete el.dataset.chatSize;
  else el.dataset.chatSize = size;
}

const listeners = new Set<() => void>();
let current: ChatTextSize | null = null;

function snapshot(): ChatTextSize {
  if (current === null) current = readChatTextSize();
  return current;
}

export function setChatTextSize(size: ChatTextSize): void {
  current = normalizeChatTextSize(size);
  try {
    if (current === DEFAULT_CHAT_TEXT_SIZE) localStorage.removeItem(CHAT_TEXT_SIZE_STORAGE);
    else localStorage.setItem(CHAT_TEXT_SIZE_STORAGE, current);
  } catch { /* private mode: still applies for this page */ }
  applyChatTextSize(current);
  listeners.forEach((fn) => fn());
}

/** Boot: apply the stored size before the first render, and follow other tabs. */
export function installChatTextSize(): void {
  applyChatTextSize(snapshot());
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== CHAT_TEXT_SIZE_STORAGE) return;
    current = readChatTextSize();
    applyChatTextSize(current);
    listeners.forEach((fn) => fn());
  });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useChatTextSize(): [ChatTextSize, (size: ChatTextSize) => void] {
  const size = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_CHAT_TEXT_SIZE);
  return [size, setChatTextSize];
}
