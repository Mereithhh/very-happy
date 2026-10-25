import type { LeadFold, TurnOrigin } from './leadView';

/** B-766 B-1 copy (zh / en, same pattern as teamNavigationCopy). */
export function leadViewCopy(zh: boolean) {
    return zh ? {
        label: '消息视图',
        all: '全部消息',
        allShort: '全部',
        owner: '只看我和负责人',
        ownerShort: '我和负责人',
        members: (n: number) => `成员消息 ${n}`,
        system: (n: number) => `系统通知 ${n}`,
        leadTurns: (n: number) => `负责人处理 ${n} 轮`,
        moreSenders: (n: number) => `+${n}`,
        expand: '展开',
        collapse: (n: number) => `收起 ${n} 条`,
        answered: '已答',
        jumpToAnswer: '跳到负责人的回答',
        via: ({ source, sender, submit }: TurnOrigin) => source === 'system' ? '回复系统通知'
            : !sender ? '回复成员消息' : submit ? `回复 ${sender} 的提交` : `回复 ${sender}`,
    } : {
        label: 'Message view',
        all: 'All messages',
        allShort: 'All',
        owner: 'Just me & the lead',
        ownerShort: 'Me & lead',
        members: (n: number) => `${n} member ${n === 1 ? 'message' : 'messages'}`,
        system: (n: number) => `${n} system ${n === 1 ? 'notice' : 'notices'}`,
        leadTurns: (n: number) => `lead handled ${n} ${n === 1 ? 'turn' : 'turns'}`,
        moreSenders: (n: number) => `+${n}`,
        expand: 'Expand',
        collapse: (n: number) => `Collapse ${n}`,
        answered: 'Answered',
        jumpToAnswer: 'Jump to the lead’s answer',
        via: ({ source, sender, submit }: TurnOrigin) => source === 'system' ? 'Replying to a system notice'
            : !sender ? 'Replying to a member message' : submit ? `Replying to ${sender}’s submission` : `Replying to ${sender}`,
    };
}

export type LeadViewCopy = ReturnType<typeof leadViewCopy>;

/** 「成员消息 3 · 系统通知 1 · 负责人处理 1 轮」 — empty parts omitted. */
export function foldSummary(fold: Pick<LeadFold, 'members' | 'system' | 'leadTurns'>, copy: LeadViewCopy): string {
    return [
        fold.members > 0 && copy.members(fold.members),
        fold.system > 0 && copy.system(fold.system),
        fold.leadTurns > 0 && copy.leadTurns(fold.leadTurns),
    ].filter(Boolean).join(' · ');
}
