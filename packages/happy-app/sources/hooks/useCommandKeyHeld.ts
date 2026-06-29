import * as React from 'react';
import { Platform } from 'react-native';

/**
 * Web-only tracker for whether the Cmd/Meta (or Ctrl on Win/Linux) key is
 * currently held down. Backed by a tiny external store + useSyncExternalStore
 * so consumers (e.g. every session row) subscribe to a single shared listener
 * set instead of each registering their own window listeners.
 *
 * The store registers exactly one set of window listeners (lazily, on first
 * subscribe) and tears them down when the last subscriber leaves. blur /
 * visibilitychange reset the flag so a key that's "released" while the window
 * was unfocused never gets stuck on.
 *
 * On native this is a constant `false` — no listeners, no churn.
 */

let held = false;
const subscribers = new Set<() => void>();
let listenersAttached = false;

function emit() {
    subscribers.forEach((fn) => fn());
}

function setHeld(next: boolean) {
    if (held === next) return;
    held = next;
    emit();
}

function isModifierHeld(e: KeyboardEvent): boolean {
    return e.metaKey || e.ctrlKey;
}

function onKeyDown(e: KeyboardEvent) {
    if (isModifierHeld(e)) setHeld(true);
}

function onKeyUp(e: KeyboardEvent) {
    // Once any of Meta/Ctrl is no longer reported as held, clear the flag.
    if (!isModifierHeld(e)) setHeld(false);
}

function reset() {
    setHeld(false);
}

function attachListeners() {
    if (listenersAttached || typeof window === 'undefined') return;
    listenersAttached = true;
    // Capture phase: fire before any bubble-phase listener (and before anything
    // that stopPropagation/stopImmediatePropagation in bubble, e.g. xterm or a
    // listener registered earlier). A late-registered bubble listener here was
    // getting swallowed, so the held flag never flipped.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
}

function detachListeners() {
    if (!listenersAttached || typeof window === 'undefined') return;
    listenersAttached = false;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', reset);
    document.removeEventListener('visibilitychange', reset);
    held = false;
}

function subscribe(fn: () => void): () => void {
    subscribers.add(fn);
    if (subscribers.size === 1) attachListeners();
    return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0) detachListeners();
    };
}

function getSnapshot(): boolean {
    return held;
}

function getServerSnapshot(): boolean {
    return false;
}

const noopSubscribe = () => () => {};

/**
 * Returns true while Cmd/Meta (or Ctrl) is held. Always false on native.
 */
export function useCommandKeyHeld(): boolean {
    return React.useSyncExternalStore(
        Platform.OS === 'web' ? subscribe : noopSubscribe,
        Platform.OS === 'web' ? getSnapshot : getServerSnapshot,
        getServerSnapshot,
    );
}
