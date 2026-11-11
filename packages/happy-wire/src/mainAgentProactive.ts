// B-925 how proactive the main agent is (KV `vh.main-agent-config.v1`.proactive).
// One definition for the CLI daemon (event wake-ups, follow-up ledger) and the
// Web (Settings → Main agent). Pure: no I/O.
//
//  - off     — never woken by events; follow-ups are still recorded, nothing is chased.
//  - report  — woken when something worth the owner's attention happens, to report it
//              (board / chat); it does not chase or dispatch anything in that turn.
//  - follow  — as report, plus the daemon chases dispatched work once when it goes quiet,
//              and a woken turn may act within the gates (still no wrap-up / hand-off).

export const MAIN_AGENT_PROACTIVE_LEVELS = ['off', 'report', 'follow'] as const;
export type MainAgentProactiveLevel = typeof MAIN_AGENT_PROACTIVE_LEVELS[number];

export type MainAgentProactiveConfig = {
    level: MainAgentProactiveLevel;
    /** Event wake-ups per local day; 0 = none. */
    dailyWakes: number;
    /** Tokens the woken turns may spend per local day (input + output + cache writes); 0 = none. */
    dailyTokens: number;
    /** Events arriving within this window are merged into one wake-up. */
    debounceSec: number;
    /** A dispatched piece of work with no sign of life for this long is chased (follow) or reported stuck. */
    followupMinutes: number;
    /** A request_human card nobody answered for this long wakes the main agent. */
    requestHumanMinutes: number;
};

export const MAIN_AGENT_PROACTIVE_DEFAULT: Readonly<MainAgentProactiveConfig> = {
    level: 'follow',
    dailyWakes: 24,
    dailyTokens: 300_000,
    debounceSec: 90,
    followupMinutes: 30,
    requestHumanMinutes: 30,
};

export const MAIN_AGENT_PROACTIVE_BOUNDS: Readonly<Record<Exclude<keyof MainAgentProactiveConfig, 'level'>, readonly [number, number]>> = {
    dailyWakes: [0, 200],
    dailyTokens: [0, 10_000_000],
    debounceSec: [10, 900],
    followupMinutes: [5, 24 * 60],
    requestHumanMinutes: [5, 24 * 60],
};

export function isMainAgentProactiveLevel(value: unknown): value is MainAgentProactiveLevel {
    return typeof value === 'string' && (MAIN_AGENT_PROACTIVE_LEVELS as readonly string[]).includes(value);
}

/** Lenient read of the config's `proactive`: each field falls back to its default on its own. */
export function readMainAgentProactive(config: unknown): MainAgentProactiveConfig {
    const raw = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>).proactive : undefined;
    const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const num = (field: keyof typeof MAIN_AGENT_PROACTIVE_BOUNDS): number => {
        const value = p[field];
        const [min, max] = MAIN_AGENT_PROACTIVE_BOUNDS[field];
        return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : MAIN_AGENT_PROACTIVE_DEFAULT[field];
    };
    return {
        level: isMainAgentProactiveLevel(p.level) ? p.level : MAIN_AGENT_PROACTIVE_DEFAULT.level,
        dailyWakes: num('dailyWakes'),
        dailyTokens: num('dailyTokens'),
        debounceSec: num('debounceSec'),
        followupMinutes: num('followupMinutes'),
        requestHumanMinutes: num('requestHumanMinutes'),
    };
}

/**
 * localId prefix of a wake-up message (`automation-wake-<level>-<id>`). It starts
 * with `automation-` on purpose: every owner-authored-message rule (server,
 * Lead board, the main agent's turn source) already treats that prefix as "not
 * the owner speaking", so a woken turn can never pass for an owner request.
 */
export const MAIN_AGENT_WAKE_LOCAL_ID_PREFIX = 'automation-wake-';

export function mainAgentWakeLocalId(level: Exclude<MainAgentProactiveLevel, 'off'>, id: string): string {
    return `${MAIN_AGENT_WAKE_LOCAL_ID_PREFIX}${level}-${id}`;
}

/** The level a wake-up localId carries, or null when it is not a wake-up. */
export function mainAgentWakeLevelOf(localId: string | null | undefined): Exclude<MainAgentProactiveLevel, 'off'> | null {
    if (typeof localId !== 'string' || !localId.startsWith(MAIN_AGENT_WAKE_LOCAL_ID_PREFIX)) return null;
    const rest = localId.slice(MAIN_AGENT_WAKE_LOCAL_ID_PREFIX.length);
    if (rest.startsWith('report-')) return 'report';
    if (rest.startsWith('follow-')) return 'follow';
    return null;
}
