/**
 * B-850c wiring across files (source assertions, verified with
 * scripts/dev/mutation-check.mjs): the spawn carries the account only when one
 * was chosen, Q3 stops an unusable choice before anything is created, the
 * banner is mounted, and the panel switches through agent-profile-bind.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

describe('B-850c accounts wiring', () => {
    it('spawn: agentProfileId is forwarded only when set (old Web / no pick = daemon default)', () => {
        expect(src('sync/ops.ts')).toContain("...(options.agentProfileId !== undefined ? { agentProfileId: options.agentProfileId } : {})");
        expect(src('sync/pendingSessions.ts')).toContain('...(record.agentProfileId !== undefined ? { agentProfileId: record.agentProfileId } : {}),');
        // the dialog sends a pick only to a daemon with accounts, for Claude
        expect(src('screens/sessions/NewSessionModal.tsx')).toContain("...(accountChoice !== undefined && readMachineAgentProfiles(selectedMachine) && agent === 'claude' ? { agentProfileId: accountChoice } : {}),");
    });

    it('Q3: an unusable account blocks before the session is created', () => {
        const detail = src('screens/session/SessionDetailScreen.tsx');
        expect(detail).toContain('onSend: (text) => !pendingAccountBlock && pendingSessions.append(pending.pendingId, text),');
        expect(detail).toContain(': pendingAccountBlock ? pendingAccountBlock');
        expect(detail).toContain("const pendingAccountBlock = pendingMode && pending?.state === 'draft'");
        const modal = src('screens/sessions/NewSessionModal.tsx');
        expect(modal).toContain("    && !accountBlocked\n");
        expect(modal).toContain("const accountBlocked = resolveSpawnAccount(readMachineAgentProfiles(selectedMachine), agent, accountChoice).kind === 'blocked';");
        // the daemon's own refusal reads as a sentence, not a code
        expect(src('sync/pendingSessionsRuntime.ts')).toContain("if (result.type === 'error' && !result.transport && parseSpawnAccountError(result.errorMessage)) result = { ...result, errorMessage: t('accounts.spawnUnavailable') };");
    });

    it('draft card offers the account picker and resets it on machine / agent change', () => {
        expect(src('screens/session/PendingSessionParts.tsx')).toContain('onChange={(agentProfileId) => pendingSessions.setTarget(id, { agentProfileId })}');
        expect(src('sync/pendingSessions.ts')).toContain('if ((change.machineId !== undefined && change.machineId !== current.machineId) || next.agent !== undefined) next.agentProfileId = undefined;');
    });

    it('session page mounts the unavailable banner; the composer passes the 账号 block and API models', () => {
        expect(src('screens/session/SessionDetailScreen.tsx')).toContain('{session && !mirror && !sharedWithMe && <AccountUnavailableBanner key={`account-unavailable:${id}`} sessionId={id} machine={bannerMachine} />}');
        const input = src('screens/session/AgentInput.tsx');
        expect(input).toContain("account={accountSection ? { label: t('accounts.sectionLabel'), ...accountSection, onChoose: chooseAccount } : undefined}");
        expect(input).toContain('? void switchSessionAccount({ sessionId, facts: accountFacts, target: apiAccount.account, model: key, working: isWorking, modelOnly: true }, t)');
        expect(input).toContain('options={apiModelOptions ?? models}');
    });

    it('switching goes through agent-profile-bind after the confirm', () => {
        const account = src('screens/session/sessionAccount.ts');
        expect(account).toContain("if (!ok) return false;\n    // Loaded on use: the RPC layer (apiSocket) stays out of the composer's import graph.\n    const { agentProfileBind } = await import('@/sync/agentProfileOps');\n    const result = await agentProfileBind(");
    });

    it('bind treats `{ bound: true, error }` as written (restart failed), not as an RPC failure', () => {
        expect(src('sync/agentProfileOps.ts')).toContain("}, (obj) => obj.bound === true);");
        expect(src('sync/agentProfileOps.ts')).toContain("if (typeof obj.error === 'string' && obj.error && !ack?.(obj)) {");
    });

    it('Q2: the paste option says the key is relayed by the server and not stored', () => {
        expect(src('components/accounts/AddAccountDialog.tsx')).toContain("{keySource === 'paste' && <>");
        expect(src('components/accounts/AddAccountDialog.tsx')).toContain("<p className=\"mce-note mce-note--warn\" data-testid=\"account-paste-warning\">{t('accounts.keyPasteWarn', { machine: machineName })}</p>");
        // file path is the default key source
        expect(src('components/accounts/AddAccountDialog.tsx')).toContain("const [keySource, setKeySource] = useState<KeySource>('file');");
    });
});
