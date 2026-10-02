export const messageActionsCopy = (lang: string) => lang.startsWith('zh') ? {
    actions: '消息操作', quote: '引用', edit: '编辑', delete: '删除', cancel: '取消',
    text: '消息', submit: '发送',
    editHint: '会替换这条及之后的对话，Agent 也会忘掉它们；文件改动不会回滚。',
    deleteTitle: '删除这条消息和它的回复？', deleteHint: 'Agent 也会忘掉这一轮；文件改动不会回滚。',
    failed: '没能改写对话。',
    unsupported: '这个会话的 CLI 不支持就地编辑/删除：升级 very-happy CLI 后重启会话再试。',
    unsent: '这条消息还没送达，稍后再试。',
    recordFailed: 'Agent 已改写对话，但页面记录没保存成功：刷新后重试删除。',
    sendFailed: '对话已回退，但新消息没发出去：在输入框重新发送。',
    // Used by SessionDetailScreen's banner for forked sessions (a separate feature).
    branchContext: '从历史消息创建的分支', parent: '返回原会话',
} : {
    actions: 'Message actions', quote: 'Quote', edit: 'Edit', delete: 'Delete', cancel: 'Cancel',
    text: 'Message', submit: 'Send',
    editHint: 'Replaces this message and everything after it; the agent forgets them too. File changes are not undone.',
    deleteTitle: 'Delete this message and its replies?', deleteHint: 'The agent forgets this turn too. File changes are not undone.',
    failed: 'Could not rewrite the conversation.',
    unsupported: 'This session’s CLI cannot edit or delete in place: update the very-happy CLI, restart the session, and try again.',
    unsent: 'This message has not been delivered yet. Try again in a moment.',
    recordFailed: 'The agent rewound, but the page could not save it. Refresh and delete again.',
    sendFailed: 'The conversation was rewound, but the new message was not sent. Send it again from the composer.',
    // Used by SessionDetailScreen's banner for forked sessions (a separate feature).
    branchContext: 'Branched from an earlier message', parent: 'Back to original session',
};
