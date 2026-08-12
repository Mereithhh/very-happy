/**
 * Web-terminal agent-state transition → notification events.
 *
 * The list tracker (webTerminal listTrackTick) already classifies every
 * terminal's agentState each tick; this module watches those observations and
 * decides when a state TRANSITION deserves a webhook notification — the web
 * terminal path has no session RPC channel (bare tmux pty), so this is its
 * equivalent of the chat session's turn-done / permission push.
 *
 * Rules (see the tracker class):
 *  - eligibility: a terminal must have been SEEN 'working' at least once
 *    before it may notify (daemon startup / first observation of an idle
 *    claude must not fire);
 *  - stability: a new state must be observed NOTIFY_STABLE_TICKS consecutive
 *    times before it counts (TUI redraws can misclassify a single frame);
 *    observations closer together than `minSampleGapMs` don't increment the
 *    stability count — event kicks re-run the tick within milliseconds, and a
 *    kick burst must not fake 20s of stability;
 *  - working → idle fires 'completed'; working|idle → needs_input fires
 *    'permission'; every transition involving 'shell'/undefined is silent;
 *  - after firing, eligibility resets (must see 'working' again) and a
 *    per-terminal cooldown of NOTIFY_COOLDOWN_MS applies.
 *
 * Pure state machine — no timers, no IO; `now` is injected. The only IO in
 * this file is sendTerminalNotification (fire-and-forget POST, kept here so
 * webTerminal.ts stays free of HTTP concerns and the manager can be handed a
 * plain callback).
 */
import axios from 'axios';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import type { AgentState } from './webTerminal';

/** Webhook event category a transition maps to (matches the server's
 *  WEBHOOK_EVENTS subscription toggles). */
export type TerminalNotifyEvent = 'completed' | 'permission';

/** Consecutive stable observations required before a state change counts. */
export const NOTIFY_STABLE_TICKS = 2;
/** Per-terminal minimum interval between notifications. */
export const NOTIFY_COOLDOWN_MS = 60_000;
/** Observations closer together than this don't increment the stability
 *  count (half the 10s list-track tick: a debounced event kick right after a
 *  tick must not count as a second independent sighting). */
export const NOTIFY_MIN_SAMPLE_GAP_MS = 5_000;

interface TrackState {
    /** Seen 'working' since the last notification → eligible to fire. */
    armed: boolean;
    /** Last state that survived the stability window. */
    confirmed: AgentState | undefined;
    /** Differing state currently accumulating stability. */
    candidate: AgentState | undefined;
    candidateCount: number;
    /** When the candidate was last COUNTED (gap-gated, see above). */
    lastCountedAt: number;
    lastNotifiedAt: number;
}

export interface TerminalNotifyTrackerOptions {
    stableTicks?: number;
    cooldownMs?: number;
    minSampleGapMs?: number;
}

export class TerminalNotifyTracker {
    private tracks = new Map<string, TrackState>();
    private readonly stableTicks: number;
    private readonly cooldownMs: number;
    private readonly minSampleGapMs: number;

    constructor(opts: TerminalNotifyTrackerOptions = {}) {
        this.stableTicks = opts.stableTicks ?? NOTIFY_STABLE_TICKS;
        this.cooldownMs = opts.cooldownMs ?? NOTIFY_COOLDOWN_MS;
        this.minSampleGapMs = opts.minSampleGapMs ?? NOTIFY_MIN_SAMPLE_GAP_MS;
    }

    /**
     * Feed one observation for a terminal. Returns the notification event this
     * observation triggers, or null. Call once per terminal per tick.
     */
    observe(terminalId: string, state: AgentState | undefined, now: number): TerminalNotifyEvent | null {
        let t = this.tracks.get(terminalId);
        if (!t) {
            // First sighting is the baseline, never a transition. It arms the
            // terminal only if claude is already mid-turn.
            t = {
                armed: state === 'working',
                confirmed: state,
                candidate: state,
                candidateCount: 0,
                lastCountedAt: now,
                lastNotifiedAt: -Infinity,
            };
            this.tracks.set(terminalId, t);
            return null;
        }

        if (state === 'working') t.armed = true;

        if (state === t.confirmed) {
            // Steady (or a blip that bounced back) — drop any pending candidate.
            t.candidate = state;
            t.candidateCount = 0;
            return null;
        }

        if (state !== t.candidate) {
            t.candidate = state;
            t.candidateCount = 1;
            t.lastCountedAt = now;
        } else if (now - t.lastCountedAt >= this.minSampleGapMs) {
            t.candidateCount += 1;
            t.lastCountedAt = now;
        }
        if (t.candidateCount < this.stableTicks) return null;

        // Candidate survived the stability window → it becomes the confirmed
        // state (ALWAYS, so shell/undefined phases advance the baseline too and
        // e.g. working → undefined → idle is two silent transitions, not a
        // deferred working→idle).
        const prev = t.confirmed;
        t.confirmed = t.candidate;
        t.candidateCount = 0;

        let event: TerminalNotifyEvent | null = null;
        if (prev === 'working' && t.confirmed === 'idle') event = 'completed';
        else if ((prev === 'working' || prev === 'idle') && t.confirmed === 'needs_input') event = 'permission';
        if (!event) return null;
        if (!t.armed) return null;
        if (now - t.lastNotifiedAt < this.cooldownMs) return null;

        t.armed = false; // must see 'working' again before the next event
        t.lastNotifiedAt = now;
        return event;
    }

    /** Forget one terminal (killed / deleted). */
    remove(terminalId: string): void {
        this.tracks.delete(terminalId);
    }

    /** Forget every terminal NOT in `liveIds` (disappeared from the list). */
    prune(liveIds: Iterable<string>): void {
        const keep = new Set(liveIds);
        for (const id of this.tracks.keys()) {
            if (!keep.has(id)) this.tracks.delete(id);
        }
    }
}

/** Human message line for each event (the webhook gateway renders the title as
 *  the heading; this is the body's first line). Pure; unit-tested. */
export function terminalNotifyMessage(event: TerminalNotifyEvent): string {
    return event === 'completed' ? 'Claude 等待下一步指令' : 'Claude 请求确认/需要输入';
}

/** Web-app path for the terminal (matches the web router / board items:
 *  `/terminal/<machineId>?tid=<terminalId>`). Pure; unit-tested. */
export function terminalNotifyLink(machineId: string, terminalId: string): string {
    return `/terminal/${encodeURIComponent(machineId)}?tid=${encodeURIComponent(terminalId)}`;
}

/** What the manager hands to its notify callback. */
export interface TerminalNotification {
    terminalId: string;
    /** Terminal title (@vh_title follow), 'Terminal' fallback. */
    title: string;
    event: TerminalNotifyEvent;
}

/**
 * Fire-and-forget POST of a terminal notification through the server's
 * account webhook (`/v1/webhook/notify`). The server applies the account's
 * event-subscription toggles (the `event` field marks this as an AUTOMATIC
 * event) and appends the clickable link line. Failures are debug-logged only —
 * a notification must never disturb the daemon.
 */
export function sendTerminalNotification(opts: {
    baseUrl: string;
    token: string;
    title: string;
    message: string;
    link: string;
    event: TerminalNotifyEvent;
}): void {
    void axios.post(
        `${opts.baseUrl}/v1/webhook/notify`,
        {
            title: opts.title,
            message: opts.message,
            link: opts.link,
            event: opts.event,
        },
        {
            headers: {
                'Authorization': `Bearer ${opts.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`,
            },
            timeout: 15000,
        },
    ).then(() => {
        logger.debug(`[WEB TERMINAL] notify sent (event=${opts.event}, link=${opts.link})`);
    }).catch((error) => {
        logger.debug('[WEB TERMINAL] notify failed:', error);
    });
}
