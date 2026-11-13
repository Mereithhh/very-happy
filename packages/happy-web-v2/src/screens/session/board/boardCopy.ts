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
    /** B-921: the server wants a signed-in login before an owner choice (an old token without a login session). */
    reloginRequired: string;
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
    /** B-915 收尾 / 交接 card. */
    wrapup: WrapupCopy;
    /** B-924 checklist on a decision card (`payload.type: 'select'`). */
    select: SelectCopy;
}

export interface SelectCopy {
    /** Heading while the card is open (tick, then choose an option). */
    title: string;
    /** Heading once the card is closed: what was ticked. */
    result: (checked: number, total: number) => string;
    checkFailed: string;
}

export interface WrapupCopy {
    /** Who posted it (the card's meta row): the session's own agent, not the team lead. */
    by: string;
    running: string;
    handoffRunning: (target: string | null) => string;
    /** B-915b: the turn ended without a report / handoff. */
    incomplete: string;
    handoffIncomplete: string;
    incompleteHint: string;
    handoffIncompleteHint: string;
    retry: string;
    canClose: string;
    pending: (n: number) => string;
    notYet: string;
    delivered: (target: string) => string;
    stored: (target: string) => string;
    handoffFailed: (target: string) => string;
    summary: string;
    more: string;
    less: string;
    files: (n: number) => string;
    artifacts: (n: number) => string;
    commits: (n: number) => string;
    copyPaths: string;
    pendingTitle: string;
    target: string;
    deliveryLabel: Record<'delivered' | 'offline-stored' | 'failed', string>;
    autoArchived: string;
    archive: string;
    archived: string;
    archivePendingConfirm: (n: number) => string;
    archiveConfirm: string;
    archiveFailed: string;
    checkFailed: string;
}

const ZH: BoardCopy = {
    title: '汇报板',
    open: '打开汇报板',
    close: '收起汇报板',
    tabs: { open: '进行中', done: '已处理' },
    groups: { need: '等你处理', asked: '你提的', report: '给你的汇报' },
    kinds: { decision: '决定', todo: '待办', blocked: '卡住了', report: '汇报', answer: '回答', question: '你问的', request: '你交代的', pin: '你钉的', wrapup: '收尾' },
    inferred: '自动识别',
    resolveNote: '负责人备注',
    choicePrefix: '［汇报板 · 决定］',
    actionFailed: '汇报板操作没有成功，已刷新',
    choiceNotSent: '已记下你的选择，但没能发消息告诉负责人',
    reloginRequired: '这台设备的登录太旧，汇报板上的选择没有生效。请退出后重新登录再选（点这里去账号设置）',
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
    wrapup: {
        by: '本会话',
        running: '收尾中…',
        handoffRunning: (target) => (target ? `交接中 → ${target}` : '交接中…'),
        incomplete: '收尾未完成',
        handoffIncomplete: '交接未完成',
        incompleteHint: '这一轮结束了，但会话没有提交收尾结果。',
        handoffIncompleteHint: '这一轮结束了，但会话没有发出交接。',
        retry: '重试',
        canClose: '可以关闭',
        pending: (n) => `${n} 项待确认`,
        notYet: '还不能关闭',
        delivered: (target) => `已交接给 ${target}`,
        stored: (target) => `已留言给 ${target}（对方不在线）`,
        handoffFailed: (target) => (target ? `交接给 ${target} 失败` : '交接失败'),
        summary: '摘要',
        more: '展开全文',
        less: '收起',
        files: (n) => `文件（${n}）`,
        artifacts: (n) => `产物（${n}）`,
        commits: (n) => `提交（${n}）`,
        copyPaths: '复制路径',
        pendingTitle: '待确认',
        target: '交接对象',
        deliveryLabel: { delivered: '已送达', 'offline-stored': '对方离线，已存为留言，下次运行时读到', failed: '未送达' },
        autoArchived: '已自动归档本会话',
        archive: '归档会话',
        archived: '会话已归档',
        archivePendingConfirm: (n) => `还有 ${n} 项未确认，仍要归档这个会话？`,
        archiveConfirm: '归档这个会话？',
        archiveFailed: '归档失败',
        checkFailed: '勾选没有保存，已刷新',
    },
    select: {
        title: '勾选要处理的，再点下面的选项',
        result: (checked, total) => `已勾选 ${checked} / ${total}`,
        checkFailed: '勾选没有保存，已刷新',
    },
};

const EN: BoardCopy = {
    title: 'Briefing',
    open: 'Open Briefing',
    close: 'Close Briefing',
    tabs: { open: 'Active', done: 'Handled' },
    groups: { need: 'Needs you', asked: 'You asked', report: 'For you' },
    kinds: { decision: 'Decide', todo: 'To do', blocked: 'Blocked', report: 'Report', answer: 'Answer', question: 'Asked', request: 'Requested', pin: 'Pinned', wrapup: 'Wrap-up' },
    inferred: 'Auto-detected',
    resolveNote: 'Lead note',
    choicePrefix: '[Briefing · decision] ',
    actionFailed: 'That Briefing action did not go through; refreshed',
    choiceNotSent: 'Your choice is saved, but the message to the lead was not sent',
    reloginRequired: 'This device\'s sign-in is too old, so your Briefing choice was not saved. Sign out and sign in again, then choose (tap to open Account)',
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
    wrapup: {
        by: 'This session',
        running: 'Wrapping up…',
        handoffRunning: (target) => (target ? `Handing off → ${target}` : 'Handing off…'),
        incomplete: 'Wrap-up not finished',
        handoffIncomplete: 'Handoff not finished',
        incompleteHint: 'The turn ended without a wrap-up result.',
        handoffIncompleteHint: 'The turn ended without sending the handoff.',
        retry: 'Retry',
        canClose: 'Ready to close',
        pending: (n) => `${n} to confirm`,
        notYet: 'Not ready to close',
        delivered: (target) => `Handed off to ${target}`,
        stored: (target) => `Left for ${target} (offline)`,
        handoffFailed: (target) => (target ? `Handoff to ${target} failed` : 'Handoff failed'),
        summary: 'Summary',
        more: 'Show all',
        less: 'Show less',
        files: (n) => `Files (${n})`,
        artifacts: (n) => `Artifacts (${n})`,
        commits: (n) => `Commits (${n})`,
        copyPaths: 'Copy paths',
        pendingTitle: 'To confirm',
        target: 'Handed off to',
        deliveryLabel: { delivered: 'Delivered', 'offline-stored': 'Target offline: stored, read on its next run', failed: 'Not delivered' },
        autoArchived: 'This session was archived automatically',
        archive: 'Archive session',
        archived: 'Session archived',
        archivePendingConfirm: (n) => `${n} item${n === 1 ? '' : 's'} still unconfirmed. Archive this session anyway?`,
        archiveConfirm: 'Archive this session?',
        archiveFailed: 'Could not archive',
        checkFailed: 'That tick was not saved; refreshed',
    },
    select: {
        title: 'Tick the ones to act on, then pick an option below',
        result: (checked, total) => `${checked} of ${total} ticked`,
        checkFailed: 'That tick was not saved; refreshed',
    },
};

export function boardCopy(zh: boolean): BoardCopy {
    return zh ? ZH : EN;
}

/** Kind label; a kind added by a newer server shows its raw name. */
export function kindLabel(copy: BoardCopy, kind: string): string {
    return (copy.kinds as Record<string, string>)[kind] ?? kind;
}
