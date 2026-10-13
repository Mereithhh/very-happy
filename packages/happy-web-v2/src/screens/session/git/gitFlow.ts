/**
 * B-583: small pure helpers behind the git dialog (presentation decisions
 * that are worth a unit test).
 */
import { defaultBranchFor, isProtectedBranch, needsPush, pushRemote, splitUpstream, type BuildFailure, type GitProbe } from './gitShell';
import { parseRemoteUrl, safeHttpsUrl, type HostedRepo } from './gitRemote';

export function hostedRepoFor(probe: GitProbe): HostedRepo | null {
    const names = probe.remotes.map((r) => r.name);
    const remote = pushRemote(probe.upstream, names);
    const url = probe.remotes.find((r) => r.name === remote)?.url;
    return url ? parseRemoteUrl(url) : null;
}

/** Branch name the remote knows this branch by (upstream name wins). */
export function remoteHeadBranch(probe: GitProbe): string | null {
    if (probe.upstream) {
        const split = splitUpstream(probe.upstream, probe.remotes.map((r) => r.name));
        if (split?.branch) return split.branch;
    }
    return probe.branch;
}

export type PushPlan = {
    remote: string | null;
    target: string | null;
    needsPush: boolean;
    /** current branch is the remote default (or main/master): ask twice */
    protectedBranch: boolean;
    defaultBranch: string | null;
};

export function pushPlan(probe: GitProbe): PushPlan {
    const remote = pushRemote(probe.upstream, probe.remotes.map((r) => r.name));
    const defaultBranch = defaultBranchFor(probe);
    return {
        remote,
        target: remote && remoteHeadBranch(probe) ? `${remote}/${remoteHeadBranch(probe)}` : null,
        needsPush: needsPush(probe),
        protectedBranch: isProtectedBranch(probe.branch, defaultBranch),
        defaultBranch,
    };
}

/** `[feat/x 1a2b3c4] subject` → sha + subject (root commits say `(root-commit)`). */
export function parseCommitSummary(output: string): { sha: string; subject: string } | null {
    const m = /^\[[^\]\n]*?\s([0-9a-f]{7,40})\]\s+(.*)$/m.exec(output);
    return m ? { sha: m[1], subject: m[2].trim() } : null;
}

/** Last `lines` non-empty lines — the part of a hook log that names the failure. */
export function outputTail(output: string, lines = 8): string {
    const all = output.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
    return all.slice(-lines).join('\n');
}

/** First https URL `gh pr create` printed. */
export function createdPrUrl(output: string): string | null {
    for (const token of output.split(/\s+/)) {
        if (!token.startsWith('https://')) continue;
        const url = safeHttpsUrl(token);
        if (url) return url;
    }
    return null;
}

export function buildFailureText(reason: BuildFailure, zh: boolean): string {
    switch (reason) {
        case 'control': return zh ? '包含控制字符，无法安全传给命令行。' : 'Contains control characters that cannot be passed safely.';
        case 'quote': return zh ? '包含 Windows 命令行无法表达的双引号。' : 'Contains a double quote that cmd.exe cannot carry.';
        case 'unknown-platform': return zh ? '还不知道执行电脑的平台，含特殊字符的内容暂不能执行，稍后重试。' : 'The machine platform is not known yet; text with special characters cannot run. Try again shortly.';
        case 'newline': return zh ? 'Windows 执行电脑上不支持段内换行（空行分段可以）。' : 'Line breaks inside a paragraph are not supported on Windows (blank-line paragraphs are).';
        case 'too-long': return zh ? '选中的文件太多，超出 Windows 命令长度。全选提交，或去终端执行。' : 'Too many files for a Windows command line. Commit all, or use the terminal.';
        case 'empty': return zh ? '内容为空。' : 'Nothing to send.';
        case 'no-remote': return zh ? '没有可推送的远端（没有 upstream，也没有 origin）。' : 'No remote to push to (no upstream and no origin).';
    }
}
