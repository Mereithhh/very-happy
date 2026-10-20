/**
 * B-024: pure parts of the post-deploy browser smoke (e2e/smoke.mjs), unit
 * tested in smokeLib.test.mjs.
 */

/**
 * Read the smoke configuration from the environment. Credentials come only
 * from CI secrets (VH_SMOKE_USERNAME / VH_SMOKE_PASSWORD) — never from the
 * repository. Missing credentials are a SKIP (with the reason), not a failure,
 * so the workflow stays green on forks and before the secrets exist.
 */
export function smokeConfig(env) {
    const url = (env.VH_SMOKE_URL || 'https://veryhappy.dev').replace(/\/+$/, '');
    const username = env.VH_SMOKE_USERNAME?.trim() || '';
    const password = env.VH_SMOKE_PASSWORD || '';
    const machine = env.VH_SMOKE_MACHINE?.trim() || null;
    let skipReason = null;
    if (!username || !password) skipReason = 'VH_SMOKE_USERNAME / VH_SMOKE_PASSWORD are not set';
    else if (!/^https?:\/\//.test(url)) skipReason = `VH_SMOKE_URL is not an http(s) URL: ${url}`;
    return { url, username, password, machine, skipReason, timeoutMs: Number(env.VH_SMOKE_TIMEOUT_MS) || 60_000 };
}

/**
 * The command typed into the terminal and the text only its OUTPUT contains:
 * the shell evaluates `$((40+2))`, so `VH_SMOKE_42_<id>` appears only once the
 * command really ran — the echoed keystrokes never contain it.
 */
export function smokeMarker(id) {
    const safe = String(id).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'x';
    return { command: `echo VH_SMOKE_$((40+2))_${safe}`, expected: `VH_SMOKE_42_${safe}` };
}

export function terminalShowsOutput(screenText, marker) {
    return typeof screenText === 'string' && screenText.includes(marker.expected);
}
