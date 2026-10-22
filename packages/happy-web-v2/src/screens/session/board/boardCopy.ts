/** B-766 W-1 — 汇报板 copy (D7: 中文「汇报板」, English "Briefing"). */
import type { AttentionKind } from '@slopus/happy-wire';
import type { BoardGroup, ResolveAction, StatusKey } from './boardModel';

export interface BoardCopy {
    title: string;
    open: string;
    close: string;
    tabs: { open: string; done: string };
    groups: Record<BoardGroup, string>;
    kinds: Record<AttentionKind, string>;
    /** D5 draft the CLI detected from the lead's text. */
    inferred: string;
    resolveNote: string;
    choicePrefix: string;
    actionFailed: string;
    choiceNotSent: string;
    status: Record<StatusKey, string>;
    decided: (choice: string) => string;
    summary: (need: number, asked: number) => string;
    strip: { need: string; asked: string; fresh: string; label: string };
    emptyOpen: string;
    emptyDone: string;
    you: string;
    lead: string;
    merged: (n: number) => string;
    recommended: string;
    /** A recommendation not set by the lead (system / automation item). */
    recommendedPlain: string;
    firstReply: string;
    autoAttached: string;
    formalAnswer: string;
    stillWorking: string;
    stillWorkingHint: string;
    noAnswerYet: string;
    noAnswerYetHint: string;
    answers: string;
    locate: string;
    followUp: string;
    followUpPrefix: string;
    resolve: Record<ResolveAction, string>;
    pointer: (kind: string) => string;
    pointerGo: string;
    badge: (n: number) => string;
}

const ZH: BoardCopy = {
    title: '汇报板',
    open: '打开汇报板',
    close: '收起汇报板',
    tabs: { open: '进行中', done: '已处理' },
    groups: { need: '等你处理', asked: '你提的', report: '给你的汇报' },
    kinds: { decision: '决定', todo: '待办', blocked: '卡住了', report: '汇报', answer: '回答', question: '你问的', request: '你交代的', pin: '你钉的' },
    inferred: '自动识别',
    resolveNote: '负责人备注',
    choicePrefix: '［汇报板 · 决定］',
    actionFailed: '汇报板操作没有成功，已刷新',
    choiceNotSent: '已记下你的选择，但没能发消息告诉负责人',
    status: { waiting: '等你', unanswered: '未答', working: '在做', inProgress: '处理中', answered: '已答', completed: '已完成', decided: '已决定', dismissed: '已忽略' },
    decided: (choice) => `已决定 ${choice}`,
    summary: (need, asked) => `${need} 件等你 · ${asked} 件未结`,
    strip: { need: '等你', asked: '未结', fresh: '新汇报', label: '汇报板摘要' },
    emptyOpen: '没有待处理的',
    emptyDone: '暂无',
    you: '你',
    lead: '负责人',
    merged: (n) => `已合并 ${n} 次重复提醒`,
    recommended: '负责人推荐',
    recommendedPlain: '推荐',
    firstReply: '首次回复',
    autoAttached: '自动挂回',
    formalAnswer: '正式回答',
    stillWorking: '还在做',
    stillWorkingHint: '完成后负责人会发一条汇报挂到这里。',
    noAnswerYet: '还没有正式回答',
    noAnswerYetHint: '负责人已收到；有结论时会挂到这里并提醒你。',
    answers: '回答你的提问',
    locate: '在消息流中定位',
    followUp: '追问',
    followUpPrefix: '［汇报板］',
    resolve: { done: '标为完成', ack: '知道了', answered: '已经答了', drop: '不用跟了' },
    pointer: (kind) => `已上板 · ${kind}`,
    pointerGo: '看板',
    badge: (n) => `${n} 件等你`,
};

const EN: BoardCopy = {
    title: 'Briefing',
    open: 'Open Briefing',
    close: 'Close Briefing',
    tabs: { open: 'Active', done: 'Handled' },
    groups: { need: 'Needs you', asked: 'You asked', report: 'For you' },
    kinds: { decision: 'Decide', todo: 'To do', blocked: 'Blocked', report: 'Report', answer: 'Answer', question: 'Asked', request: 'Requested', pin: 'Pinned' },
    inferred: 'Auto-detected',
    resolveNote: 'Lead note',
    choicePrefix: '[Briefing · decision] ',
    actionFailed: 'That Briefing action did not go through; refreshed',
    choiceNotSent: 'Your choice is saved, but the message to the lead was not sent',
    status: { waiting: 'Waiting', unanswered: 'Unanswered', working: 'Working', inProgress: 'In progress', answered: 'Answered', completed: 'Done', decided: 'Decided', dismissed: 'Dismissed' },
    decided: (choice) => `Chose ${choice}`,
    summary: (need, asked) => `${need} need you · ${asked} open`,
    strip: { need: 'Needs you', asked: 'Open', fresh: 'New', label: 'Briefing summary' },
    emptyOpen: 'Nothing waiting',
    emptyDone: 'None yet',
    you: 'You',
    lead: 'Lead',
    merged: (n) => `${n} repeat reminders merged`,
    recommended: 'Lead recommends',
    recommendedPlain: 'Recommended',
    firstReply: 'First reply',
    autoAttached: 'attached automatically',
    formalAnswer: 'Answer',
    stillWorking: 'Still working',
    stillWorkingHint: 'The lead will attach a report here when it is done.',
    noAnswerYet: 'No answer yet',
    noAnswerYetHint: 'The lead has it; the answer lands here and you get a reminder.',
    answers: 'Answers your question',
    locate: 'Show in conversation',
    followUp: 'Follow up',
    followUpPrefix: '[Briefing] ',
    resolve: { done: 'Mark done', ack: 'Got it', answered: 'Already answered', drop: 'Stop tracking' },
    pointer: (kind) => `On Briefing · ${kind}`,
    pointerGo: 'Briefing',
    badge: (n) => `${n} need you`,
};

export function boardCopy(zh: boolean): BoardCopy {
    return zh ? ZH : EN;
}

/** Kind label; a kind added by a newer server shows its raw name. */
export function kindLabel(copy: BoardCopy, kind: string): string {
    return (copy.kinds as Record<string, string>)[kind] ?? kind;
}
