export const messageActionsCopy = (lang: string) => lang.startsWith('zh') ? {
    actions: '消息操作', quote: '引用', edit: '编辑', cancel: '取消',
    title: '编辑并重新发送', text: '消息', submit: '重新发送', busy: '发送中…',
    description: '将编辑后的内容作为新消息发送到当前会话。',
    queued: '已加入发送队列',
    failed: '发送失败，请重试。',
    // Used by SessionDetailScreen's banner for forked sessions (a separate feature).
    branchContext: '从历史消息创建的分支', parent: '返回原会话',
} : {
    actions: 'Message actions', quote: 'Quote', edit: 'Edit', cancel: 'Cancel',
    title: 'Edit and resend', text: 'Message', submit: 'Resend', busy: 'Sending…',
    description: 'Sends the edited text as a new message in this conversation.',
    queued: 'Message queued',
    failed: 'Could not send. Please try again.',
    // Used by SessionDetailScreen's banner for forked sessions (a separate feature).
    branchContext: 'Branched from an earlier message', parent: 'Back to original session',
};
