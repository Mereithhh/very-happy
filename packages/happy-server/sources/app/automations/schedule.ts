import type { AutomationTrigger } from '@slopus/happy-wire';
import { CronParseError, isValidTimeZone, nextCronAfter, parseCron } from './cron';
import { AutomationError } from './errors';

/**
 * Phase-preserving interval: the first anchor + k * everyMs strictly after
 * `afterMs`. Missed periods collapse into the single next occurrence, the same
 * catch-up semantics as team schedules (`advanceSchedules`).
 */
export function nextIntervalAfter(anchorMs: number, everyMs: number, afterMs: number): number {
    if (anchorMs > afterMs) return anchorMs;
    return anchorMs + (Math.floor((afterMs - anchorMs) / everyMs) + 1) * everyMs;
}

/** Pure due calculation: next fire instant strictly after `afterMs`, or null when the trigger has no future run. */
export function nextRunAfter(trigger: AutomationTrigger, afterMs: number): number | null {
    switch (trigger.kind) {
        case 'manual': return null;
        case 'once': return trigger.at > afterMs ? trigger.at : null;
        case 'interval': return nextIntervalAfter(trigger.anchorAt ?? afterMs, trigger.everyMs, afterMs);
        case 'cron': return nextCronAfter(parseCron(trigger.expr), trigger.tz, afterMs);
    }
}

/**
 * First due instant for a newly configured trigger. A `once` in the past is
 * still due (it fires at the next claim); afterwards `nextRunAfter` retires it.
 */
export function initialRunAt(trigger: AutomationTrigger, nowMs: number): number | null {
    return trigger.kind === 'once' ? trigger.at : nextRunAfter(trigger, nowMs);
}

/** Validates and normalizes a trigger for storage (fills interval anchors, rejects bad cron/tz). */
export function normalizeTrigger(trigger: AutomationTrigger, nowMs: number): AutomationTrigger {
    if (trigger.kind === 'interval') return { ...trigger, anchorAt: trigger.anchorAt ?? nowMs };
    if (trigger.kind !== 'cron') return trigger;
    if (!isValidTimeZone(trigger.tz)) throw new AutomationError('invalid_timezone', 400);
    let fields;
    try { fields = parseCron(trigger.expr); }
    catch (error) { if (error instanceof CronParseError) throw new AutomationError('invalid_cron', 400); throw error; }
    if (nextCronAfter(fields, trigger.tz, nowMs) === null) throw new AutomationError('invalid_cron', 400);
    return trigger;
}
