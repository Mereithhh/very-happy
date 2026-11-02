/** B-873: issue API errors as one readable line (wire ISSUE_ERROR_CODES), shown inline where the action was. */
import { IssuesApiError } from '@/sync/apiIssues';
import type { IssuesCopy } from './issuesCopy';

const ZH: Record<string, string> = {
    issues_disabled: '这个服务器没有开启 Issues', issue_not_found: '找不到这个 issue', issue_version_conflict: '已被别处修改，已载入最新内容',
    issue_count_quota_exceeded: 'Issue 数量已达上限', issue_assignee_unsupported: '暂不支持这种指派', issue_agent_unsupported: '这个 agent 不能被指派',
    issue_no_directory: '这台机器上没有项目目录：填写目录，或给项目加一个这台机器上的目录', issue_machine_not_found: '找不到这台机器',
    issue_parent_cycle: '父 issue 不能形成环', issue_project_not_found: '项目不存在', issue_run_not_found: '找不到这次执行', transaction_conflict: '并发冲突，请重试',
    invalid_request: '内容不符合要求', network: '网络错误，请重试',
    issue_status_forbidden: '这个状态不能这样改', issue_closed: 'Issue 已关闭', issue_comment_required: '需要附上一条说明',
    issue_comment_quota_exceeded: '评论太频繁，请稍后再试', rate_limited: '操作太频繁，请稍后再试', issue_run_not_current: '这次执行已被新的执行替代',
};
const EN: Record<string, string> = {
    issues_disabled: 'Issues are not enabled on this server', issue_not_found: 'Issue not found', issue_version_conflict: 'Changed elsewhere; the latest version is loaded',
    issue_count_quota_exceeded: 'Issue limit reached', issue_assignee_unsupported: 'This kind of assignee is not supported yet', issue_agent_unsupported: 'This agent cannot be assigned',
    issue_no_directory: 'No project folder on that machine: enter a folder, or add one on that machine to the project', issue_machine_not_found: 'Machine not found',
    issue_parent_cycle: 'A parent issue cannot form a cycle', issue_project_not_found: 'Project not found', issue_run_not_found: 'Run not found', transaction_conflict: 'Concurrent change, please retry',
    invalid_request: 'Invalid input', network: 'Network error, please retry',
    issue_status_forbidden: 'This status change is not allowed', issue_closed: 'The issue is closed', issue_comment_required: 'Add a note to go with it',
    issue_comment_quota_exceeded: 'Too many comments, try again shortly', rate_limited: 'Too many requests, try again shortly', issue_run_not_current: 'A newer run has replaced this one',
};

export function issueErrorText(error: unknown, copy: IssuesCopy): string {
    const table = copy.lang === 'zh' ? ZH : EN;
    const code = error instanceof IssuesApiError ? (error.status === 429 && !ZH[error.code] ? 'rate_limited' : error.code) : 'network';
    return table[code] ?? `${copy.failed} (${code})`;
}
