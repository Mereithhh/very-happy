/**
 * Settings → Main agent → 主动程度 (B-925): pure helpers and the zh / en copy
 * (the mainAgentCopy pattern).
 */

import { MAIN_AGENT_PROACTIVE_BOUNDS, type MainAgentProactiveConfig, type MainAgentProactiveLevel } from '@slopus/happy-wire';

/** The config blob with `proactive` replaced; every other field kept. */
export function withProactive(previous: unknown, proactive: MainAgentProactiveConfig, now: number): Record<string, unknown> {
    const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...(previous as Record<string, unknown>) } : {};
    return { ...base, v: 1, proactive: { ...proactive }, updatedAt: now };
}

/** A cap typed by the owner, or null when it is not a whole number inside its bounds. */
export function parseCap(text: string, field: 'dailyWakes' | 'dailyTokens'): number | null {
    const trimmed = text.trim().replace(/[,_\s]/g, '');
    if (!/^\d+$/.test(trimmed)) return null;
    const value = Number(trimmed);
    const [min, max] = MAIN_AGENT_PROACTIVE_BOUNDS[field];
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}


export interface MainAgentProactiveCopy {
    title: string;
    levelOff: string;
    levelReport: string;
    levelFollow: string;
    levelHint: Record<MainAgentProactiveLevel, string>;
    dailyWakes: string;
    dailyTokens: string;
    capsHint: string;
    capInvalid: (max: number) => string;
    saveCaps: string;
    saved: string;
    saveFailed: string;
}

const zh: MainAgentProactiveCopy = {
    title: '主动程度',
    levelOff: '关',
    levelReport: '只汇报',
    levelFollow: '主动跟进',
    levelHint: {
        off: '不因事件唤醒主 agent，也不催派出去的活；只在你发消息时工作。',
        report: '团队任务等验收、会话出错、自动化失败、派的活完成或卡住时唤醒主 agent，让它核实后上板或告诉你；它不会自己去催或派活。',
        follow: '在「只汇报」之上：派出去的活没动静时自动催一次，主 agent 可以在安全阀内直接推进再汇报。任何时候都不会自动收尾；夜间免打扰时段只上板不推送。',
    },
    dailyWakes: '每天最多唤醒次数',
    dailyTokens: '每天最多 token',
    capsHint: '超过任一上限当天就停，并在「需要我决策」里说明；第二天自动恢复。',
    capInvalid: (max) => `填 0–${max} 的整数`,
    saveCaps: '保存上限',
    saved: '已保存',
    saveFailed: '保存失败，请重试',
};

const en: MainAgentProactiveCopy = {
    title: 'Proactivity',
    levelOff: 'Off',
    levelReport: 'Report only',
    levelFollow: 'Follow up',
    levelHint: {
        off: 'Events never wake the main agent and handed-out work is not chased; it works only when you write to it.',
        report: 'Wakes the main agent when a team task waits for your acceptance, a session fails, an automation fails, or work it handed out is done or stuck — it checks and reports (board or chat), never chases or dispatches on its own.',
        follow: 'Report only, plus one automatic nudge when handed-out work goes quiet; the main agent may move things forward within the safety gates and then report. Never wraps anything up by itself; during quiet hours it only posts to the board, without push.',
    },
    dailyWakes: 'Wake-ups per day',
    dailyTokens: 'Tokens per day',
    capsHint: 'Past either cap it stops for the day and says so on the board; it resumes the next day.',
    capInvalid: (max) => `A whole number from 0 to ${max}`,
    saveCaps: 'Save caps',
    saved: 'Saved',
    saveFailed: 'Could not save; try again',
};

export function mainAgentProactiveCopy(lang: string): MainAgentProactiveCopy {
    return lang.startsWith('zh') ? zh : en;
}
