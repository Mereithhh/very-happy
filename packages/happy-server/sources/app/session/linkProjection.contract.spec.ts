import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MessageContentSchema, SessionProtocolMessageSchema } from '@slopus/happy-wire';
import { MAX_RECORD_TEXT, makePathScrubber, projectLinkPage, projectRecordForLink } from './linkProjection';

/**
 * B-745 structure contract: what the runners REALLY store, fed through the
 * share-link projection. B-701 tested a hand-written `content: { type:
 * 'session', data }` shape no producer writes, so every assistant reply
 * (`role: 'session'`, `content` = the envelope) was dropped in production.
 *
 * linkProjection.samples.json was captured from a local e2e (standalone
 * server + isolated daemon, 2026-10-22): a Claude and a pi session that read
 * a fake `.env` + private key and ran `env`; Codex could not reach a model on
 * that host, so its sample is the CLI's live mapper output for the same turn
 * plus the agent events the real (failed) Codex run stored. Paths were moved
 * to /home/alice; fake secrets are «placeholders» (literal token shapes trip
 * the repository secret scanners) filled in below.
 */
const join = (...parts: string[]) => parts.join('');
const SECRETS: Record<string, string> = {
    '«ANTHROPIC_KEY»': join('sk-', 'ant-api03-FAKEe2eKEYabcdefghijklmnop0123'),
    '«GITHUB_TOKEN»': join('gh', 'p_FAKEe2etoken0123456789abcdefghijklmn'),
    '«ENV_TOKEN»': join('gh', 'p_FAKEenvTOKEN0123456789abcdefghijklm'),
    '«DB_URL_WITH_PASSWORD»': join('postgres://admin:', 'FakeDbPass9876@'),
    '«PEM_BEGIN»': join('-----BEGIN OPENSSH PRIVATE', ' KEY-----'),
    '«PEM_END»': join('-----END OPENSSH PRIVATE', ' KEY-----'),
};
/** Secret material that must never reach a link viewer (any of these substrings). */
const NEVER = ['FAKEe2eKEY', 'FAKEe2etoken', 'FAKEenvTOKEN', 'FakeDbPass9876', 'hunter2FakePw', 'fakeSaltValue12345', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQFAKE', 'PRIVATE KEY', '/home/alice', 'PRIVATE-CODEX-REASONING'];

type Sample = { meta: { path: string; homeDir: string; flavor: string }; records: unknown[] };
const raw = readFileSync(joinPath(__dirname, 'linkProjection.samples.json'), 'utf8');
const SAMPLES: Record<'claude' | 'codex' | 'pi', Sample> = JSON.parse(Object.entries(SECRETS).reduce((s, [k, v]) => s.split(k).join(v), raw));

function project(sample: Sample) {
    const scrub = makePathScrubber({ cwd: sample.meta.path, homeDir: sample.meta.homeDir });
    return sample.records.map((record) => projectRecordForLink(record, scrub)).filter((r): r is Record<string, any> => r !== null);
}
const sessionEvents = (out: Record<string, any>[]) => out.filter((r) => r.role === 'session').map((r) => r.content.ev);
const texts = (out: Record<string, any>[]) => sessionEvents(out).filter((ev) => ev.t === 'text').map((ev) => ev.text as string);

describe('B-745 share-link projection — real runner records (structure contract)', () => {
    it('every sample record is a valid wire MessageContent (the fixtures are real shapes)', () => {
        for (const [runner, sample] of Object.entries(SAMPLES)) {
            for (const record of sample.records) expect(MessageContentSchema.safeParse(record).success, `${runner}: ${JSON.stringify(record).slice(0, 120)}`).toBe(true);
            expect(sample.records.some((r: any) => r.role === 'session' && r.content.ev && !('type' in r.content)), runner).toBe(true);
        }
    });

    it('projected records are still valid wire messages (the web parses them with the same schemas)', () => {
        for (const sample of Object.values(SAMPLES)) {
            for (const out of project(sample)) {
                expect(MessageContentSchema.safeParse(out).success, JSON.stringify(out).slice(0, 160)).toBe(true);
                if (out.role === 'session') expect(SessionProtocolMessageSchema.safeParse(out).success).toBe(true);
            }
        }
    });

    it('Claude: assistant reply, code blocks and the Bash call summary are visible; secrets are masked', () => {
        const out = project(SAMPLES.claude);
        const reply = texts(out).join('\n');
        expect(reply).toContain('```dotenv');
        expect(reply).toContain('```js\nconsole.log("done");\n```');
        expect(reply).toContain('ANTHROPIC_API_KEY=[redacted]');
        expect(reply).toContain('GITHUB_TOKEN=[redacted]');
        expect(reply).toContain('DATABASE_URL=[redacted]');
        expect(reply).toContain('PORT=3005');
        const call = sessionEvents(out).find((ev) => ev.t === 'tool-call-start');
        expect(call).toMatchObject({ name: 'Bash', title: 'Read fake secrets and env vars' });
        expect(call.args.command).toContain('cat .env');
        expect(sessionEvents(out).map((ev) => ev.t)).toEqual(['turn-start', 'tool-call-start', 'tool-call-end', 'text', 'turn-end']);
        // Envelope extras (usage, streamKey, claudeUuid) are not whitelisted.
        expect(JSON.stringify(out)).not.toMatch(/usage|streamKey|claudeUuid|cache_read/);
    });

    it('pi: final reply visible, thinking hidden, `env` / .env / private key tool output masked, paths rewritten', () => {
        const out = project(SAMPLES.pi);
        const shown = texts(out);
        expect(shown).toHaveLength(1); // three thinking texts are dropped
        expect(shown[0]).toContain('```js\nconsole.log("done");\n```');
        expect(shown[0]).toContain('E2E_DB_PASSWORD=[redacted]');
        const results = sessionEvents(out).filter((ev) => ev.t === 'tool-call-end' && ev.result).map((ev) => ev.result.text as string);
        const envResult = results.find((t) => t.startsWith('HOME='));
        expect(envResult).toBe('HOME=~\nE2E_DB_PASSWORD=[redacted]\nE2E_FAKE_TOKEN=[redacted]\n---exit:0\n');
        const fileDump = results.find((t) => t.includes('ANTHROPIC_API_KEY'))!;
        expect(fileDump).toContain('ANTHROPIC_API_KEY=[redacted]');
        expect(fileDump).toContain('AUTH_SECRET_SALT=[redacted]');
        expect(fileDump).toMatch(/---\n\[redacted\]/); // the whole PEM block
        expect(results.join('\n')).toContain('Data directory: ~/.very-happy');
        const calls = sessionEvents(out).filter((ev) => ev.t === 'tool-call-start');
        expect(calls.map((c) => c.args.command)).toContain("env | grep -E 'E2E_|HOME='; echo \"---exit:$?\"");
    });

    it('Codex: agent messages and tool summaries visible; reasoning hidden; cwd and patch paths rewritten; errors shown', () => {
        const out = project(SAMPLES.codex);
        const shown = texts(out);
        expect(shown[0]).toBe('I will read the env file and run env.');
        expect(shown.join('\n')).toContain('```js\nconsole.log("done")\n```');
        expect(shown.join('\n')).toContain('GITHUB_TOKEN=[redacted]');
        const [exec, patch] = sessionEvents(out).filter((ev) => ev.t === 'tool-call-start');
        expect(exec).toMatchObject({ name: 'CodexBash' });
        expect(exec.args.cwd).toBe('secret-project');
        expect(patch).toMatchObject({ name: 'CodexPatch', title: 'Apply patch' });
        expect(Object.keys(patch.args.changes)).toEqual(['secret-project/.env']);
        // The key names a "secret" (this project is called secret-project): its whole diff is hidden.
        expect(patch.args.changes['secret-project/.env']).toBe('[redacted]');
        const events = out.filter((r) => r.role === 'agent').map((r) => r.content.data);
        expect(events).toContainEqual({ type: 'message', message: 'Codex error: Missing environment variable: `LLMHUB_API_KEY`.' });
    });

    it('no sample leaks a secret, a home path or reasoning anywhere in the projected output', () => {
        for (const [runner, sample] of Object.entries(SAMPLES)) {
            const s = JSON.stringify(project(sample));
            for (const leaked of NEVER) expect(s, `${runner} leaks ${leaked}`).not.toContain(leaked);
        }
    });

    // B-701 adversarial budget cases, re-run on the real pi `tool-call-end.result` slot.
    it('budgets hold for real-shaped tool output: 1 MB adversarial result < 200 ms, straddling secret never leaks', () => {
        const template = SAMPLES.pi.records.find((r: any) => r.role === 'session' && r.content.ev.t === 'tool-call-end' && r.content.ev.result) as any;
        const withText = (text: string) => SessionProtocolMessageSchema.parse({ ...template, content: { ...template.content, ev: { ...template.content.ev, result: { text } } } });
        const scrub = makePathScrubber({ cwd: SAMPLES.pi.meta.path, homeDir: SAMPLES.pi.meta.homeDir });
        const adversarial = withText(['eyJ-', 'a-', 'TOKEN=', '"secret": "', 'a://b:', 'Bearer '].map((p) => p.repeat(170 * 1024 / p.length)).join(''));
        expect(JSON.stringify(adversarial).length).toBeGreaterThan(1_000_000);
        projectRecordForLink(adversarial, scrub);
        let best = Infinity;
        for (let r = 0; r < 3; r++) { const t0 = performance.now(); projectRecordForLink(adversarial, scrub); best = Math.min(best, performance.now() - t0); }
        expect(best).toBeLessThan(200);
        // A secret straddling the 32 KB per-string cut.
        const secret = SECRETS['«ENV_TOKEN»'];
        const cut = JSON.stringify(projectRecordForLink(withText('y '.repeat(16 * 1024 - 4) + 'E2E_FAKE_TOKEN=' + secret + ' tail'), scrub));
        for (let n = 4; n <= secret.length; n++) expect(cut).not.toContain(secret.slice(0, n));
        // The page budget pays for real records too.
        const page = projectLinkPage({ records: new Array(200).fill(withText('z'.repeat(MAX_RECORD_TEXT))), cipherLength: () => 300 * 1024, decode: (r) => r, scrub });
        expect(page.consumed).toBeLessThan(200);
        expect(page.projected.length).toBeGreaterThan(0);
    });
});
