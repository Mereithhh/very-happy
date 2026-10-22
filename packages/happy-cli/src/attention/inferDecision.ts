import { createHash } from 'node:crypto';
import { ATTENTION_LIMITS, type AttentionOption } from '@slopus/happy-wire';

/**
 * B-766 D5 (`specs/2026-10-owner-briefing.md`, DESIGN §5.2): a lead turn that
 * asks the owner to decide in prose (「需要你决定」, "please decide", an
 * `<options>` block) without posting a board decision becomes an inferred
 * draft. Rules only, no model call. Code blocks are ignored so a quoted
 * prompt or log never triggers it.
 */

const TRIGGERS: readonly RegExp[] = [
    /需要你(?:来)?(?:决定|拍板|确认|选择|定夺|批准|授权|选)/,
    /请你?(?:来)?(?:拍板|决定|定夺|确认一下|选择|选一个|选一下)/,
    /(?:等你|由你|你来)(?:拍板|决定|定夺|确认|选)/,
    /需要\s*owner\s*(?:决定|拍板|确认)/i,
    /\b(?:need|needs|waiting for|awaiting)\s+(?:your|the owner'?s?)\s+(?:decision|call|approval|sign-?off|go-?ahead)\b/i,
    /\b(?:i|we)\s+need\s+you\s+to\s+(?:decide|choose|pick|confirm|approve)\b/i,
    /\bplease\s+(?:decide|choose|pick one|confirm which|approve)\b/i,
    /<options>/i,
];

const OPTION_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:选项|option\s*)?([A-Da-d]|[1-4])(?:\*\*)?\s*[.)、:：）]\s*(?:\*\*)?\s*(\S.*?)\s*$/i;
const TAGGED_OPTION = /<option(?:\s+id="([^"]{1,16})")?\s*>([\s\S]*?)<\/option>/gi;
const RECOMMENDED = /推荐|建议选|\brecommend(?:ed)?\b|\(rec\)/i;

export type InferredDecision = {
    title: string;
    options: AttentionOption[];
    /** Stable for the same ask: a repeat only bumps `repostCount` on the server. */
    key: string;
    bodyMd: string;
};

function stripCode(text: string): string {
    return text.replace(/```[\s\S]*?(?:```|$)/g, '\n').replace(/`[^`\n]*`/g, ' ');
}

function clean(text: string, max: number): string {
    const flat = text.replace(/\*\*|__|^#+\s*/g, '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The sentence (or line) that carries the trigger, as the item title. */
function triggerSentence(text: string, match: RegExpExecArray): string {
    const start = Math.max(text.lastIndexOf('\n', match.index), ...['。', '！', '？', '. ', '! ', '? '].map(p => {
        const at = text.lastIndexOf(p, match.index);
        return at < 0 ? -1 : at + p.length - 1;
    })) + 1;
    const rest = text.slice(match.index);
    const endRel = rest.search(/[。！？\n]|[.!?](?:\s|$)/);
    const end = endRel < 0 ? text.length : match.index + endRel + 1;
    return text.slice(start, end);
}

function optionLabel(raw: string): string {
    return clean(raw.replace(/<[^>]+>/g, ''), ATTENTION_LIMITS.optionLabelChars);
}

/** First run of 2–4 consecutive `A. …` / `1) …` lines (letters win over numbers), or an `<options>` block. */
export function parseOptions(text: string): AttentionOption[] {
    const tagged = [...text.matchAll(TAGGED_OPTION)].slice(0, ATTENTION_LIMITS.options.max);
    if (tagged.length >= ATTENTION_LIMITS.options.min) {
        return tagged.map((m, i) => ({
            id: (m[1] ?? String.fromCharCode(65 + i)).slice(0, ATTENTION_LIMITS.optionIdChars),
            label: optionLabel(m[2]) || `Option ${i + 1}`,
            ...(RECOMMENDED.test(m[2]) ? { recommended: true } : {}),
        }));
    }
    const groups: { letter: boolean; lines: { id: string; label: string; recommended: boolean }[] }[] = [];
    let current: (typeof groups)[number] | null = null;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const m = OPTION_LINE.exec(line);
        if (!m) { current = null; continue; }
        const id = m[1].toUpperCase();
        const letter = /[A-D]/.test(id);
        if (!current || current.letter !== letter || current.lines.some(l => l.id === id)) {
            current = { letter, lines: [] };
            groups.push(current);
        }
        current.lines.push({ id, label: optionLabel(m[2]), recommended: RECOMMENDED.test(m[2]) });
    }
    const usable = groups.filter(g => g.lines.length >= ATTENTION_LIMITS.options.min && g.lines.every(l => l.label));
    const pick = usable.find(g => g.letter) ?? usable[0];
    if (!pick) return [];
    return pick.lines.slice(0, ATTENTION_LIMITS.options.max).map(l => ({ id: l.id, label: l.label, ...(l.recommended ? { recommended: true } : {}) }));
}

function defaultOptions(cjk: boolean): AttentionOption[] {
    return cjk
        ? [{ id: 'yes', label: '同意' }, { id: 'other', label: '另有安排（回复说明）' }]
        : [{ id: 'yes', label: 'Approve' }, { id: 'other', label: 'Something else (reply)' }];
}

export function inferOwnerDecision(text: string): InferredDecision | null {
    const prose = stripCode(text);
    let match: RegExpExecArray | null = null;
    for (const trigger of TRIGGERS) {
        match = trigger.exec(prose);
        if (match) break;
    }
    if (!match) return null;
    const title = clean(triggerSentence(prose, match).replace(/<\/?options>/gi, ''), ATTENTION_LIMITS.titleChars);
    if (!title) return null;
    const parsed = parseOptions(text);
    const options = parsed.length ? parsed : defaultOptions(/[㐀-鿿]/.test(title));
    const digest = createHash('sha256').update(`${title}\n${options.map(o => `${o.id}:${o.label}`).join('\n')}`).digest('hex').slice(0, 16);
    const encoder = new TextEncoder();
    let bodyMd = text.trim();
    while (encoder.encode(bodyMd).length > ATTENTION_LIMITS.bodyBytes / 2) bodyMd = `${bodyMd.slice(0, Math.floor(bodyMd.length * 0.8))}…`;
    return { title, options, key: `inferred-${digest}`, bodyMd };
}
