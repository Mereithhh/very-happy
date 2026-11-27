export const modelFeedbackCopy = (lang: string) => lang.startsWith('zh') ? {
    up: '回答得好', down: '回答得不好',
    notePlaceholder: '哪里不好？（选填，一句话）', send: '提交', skip: '跳过',
    thanks: '已记下，谢谢', failed: '反馈没提交成功，稍后再试',
    exportTitle: '模型回答反馈', exportHint: '对话里每轮回答下的 👍/👎。导出里带会话 id 和每次模型请求的 request id，可以直接对上模型网关的请求记录。',
    exportJsonl: '导出 JSONL', exportCsv: '导出 CSV', exported: (n: number) => `已导出（${n} 字节）`,
} : {
    up: 'Good answer', down: 'Bad answer',
    notePlaceholder: 'What went wrong? (optional, one line)', send: 'Send', skip: 'Skip',
    thanks: 'Noted, thanks', failed: 'Feedback was not sent. Try again later.',
    exportTitle: 'Model answer feedback', exportHint: 'The 👍/👎 under each answer in chats. Each record carries the session id and the request id of every model request, so it joins the model gateway’s request log directly.',
    exportJsonl: 'Export JSONL', exportCsv: 'Export CSV', exported: (n: number) => `Exported (${n} bytes)`,
};
