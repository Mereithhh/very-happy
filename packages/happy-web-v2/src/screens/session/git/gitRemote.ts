/**
 * B-583: hosted-review provider + web URLs from a git remote URL. Pure.
 *
 * Provider-neutral on purpose (Orca's rule: no GitHub-only naming) — GitHub
 * and Bitbucket call it a pull request, GitLab a merge request. Credentials
 * embedded in an https remote (`https://user:token@host/…`) are dropped and
 * never reach the UI or a link.
 */

export type HostedProvider = 'github' | 'gitlab' | 'bitbucket' | 'unknown';

export type HostedRepo = {
    provider: HostedProvider;
    host: string;
    /** `https://host[:port]/owner/repo` — no credentials, no `.git` */
    webBase: string;
};

function providerFor(host: string): HostedProvider {
    const h = host.toLowerCase();
    if (h === 'github.com' || h.startsWith('github.')) return 'github';
    if (h.includes('gitlab')) return 'gitlab';
    if (h === 'bitbucket.org') return 'bitbucket';
    return 'unknown';
}

const SAFE_PATH = /^[A-Za-z0-9._~\-/]+$/;

export function parseRemoteUrl(remote: string): HostedRepo | null {
    const raw = remote.trim();
    let host: string;
    let path: string;
    let port = '';
    const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(raw);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            return null;
        }
        if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) return null;
        host = url.hostname;
        path = url.pathname;
        // Only an http(s) port is meaningful for the web UI; an ssh port is not.
        if ((url.protocol === 'https:' || url.protocol === 'http:') && url.port) port = `:${url.port}`;
    } else if (scp) {
        host = scp[1];
        path = scp[2];
    } else {
        return null;
    }
    path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
    if (!host || !path || !path.includes('/') || !SAFE_PATH.test(path) || path.split('/').some((seg) => seg === '..' || seg === '.')) return null;
    return { provider: providerFor(host), host, webBase: `https://${host.toLowerCase()}${port}/${path}` };
}

function encodeBranch(branch: string): string {
    return branch.split('/').map(encodeURIComponent).join('/');
}

/** "Open a PR/MR" page with head (and base when known) preselected; null for unknown hosts. */
export function compareUrl(repo: HostedRepo, base: string | null, head: string): string | null {
    switch (repo.provider) {
        case 'github':
            return `${repo.webBase}/compare/${base ? `${encodeBranch(base)}...` : ''}${encodeBranch(head)}?expand=1`;
        case 'gitlab':
            return `${repo.webBase}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(head)}${base ? `&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}` : ''}`;
        case 'bitbucket':
            return `${repo.webBase}/pull-requests/new?source=${encodeURIComponent(head)}${base ? `&dest=${encodeURIComponent(base)}` : ''}`;
        default:
            return null;
    }
}

/** UI noun: GitLab says merge request. */
export function reviewNoun(provider: HostedProvider): 'PR' | 'MR' {
    return provider === 'gitlab' ? 'MR' : 'PR';
}

/** Only ever render https links that came from tools (gh JSON, gh stdout). */
export function safeHttpsUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
    } catch {
        return null;
    }
}
