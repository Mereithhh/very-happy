import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperatorRpcError } from '@/sync/operatorProtocol';
import { operatorErrorCode, operatorErrorCopy } from './operatorCopy';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('B-867 operator error copy', () => {
    const t = ((key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key) as never;
    it('maps broker codes; an old CLI / legacy machine says the CLI needs an update', () => {
        expect(operatorErrorCopy(t, 'cli_upgrade_required')).toBe('share.operator.errors.upgrade');
        expect(operatorErrorCopy(t, 'machine_unsupported')).toBe('share.operator.errors.upgrade');
        expect(operatorErrorCopy(t, 'operator_mode_escalation')).toBe('share.operator.errors.modeEscalation');
        expect(operatorErrorCopy(t, 'operator_path_denied')).toBe('share.operator.errors.pathDenied');
        expect(operatorErrorCopy(t, 'whatever')).toContain('share.operator.errors.generic');
        expect(operatorErrorCode(new OperatorRpcError('not_operator'))).toBe('not_operator');
        expect(operatorErrorCode(new Error('x'))).toBe('rpc_failed');
    });
});

describe('B-867 guards that must not regress (source)', () => {
    it('sessionRPC only routes operators, only for allowlisted methods, and still refuses everyone else', () => {
        const src = read('../../sync/apiSocket.ts');
        const fn = src.slice(src.indexOf('async sessionRPC<'), src.indexOf('const sessionEncryption = this.encryption!.getSessionEncryption(sessionId);'));
        expect(fn).toMatch(/share\.role === 'driver' && share\.operate === true && OPERATOR_SESSION_METHODS\.has\(method\)/);
        expect(fn).toContain('return this.operatorRPC');
        expect(fn).toMatch(/throw new Error\(`Session \$\{sessionId\} is shared with this account/);
    });
    it('operator calls go to the central broker only, sealed with the SESSION key', () => {
        const src = read('../../sync/apiSocket.ts');
        const fn = src.slice(src.indexOf('async operatorRPC<'), src.indexOf('Deliver encrypted structured messages'));
        expect(fn).toContain("emitWithAck('operator-rpc'");
        expect(fn).toContain('getSessionEncryption(sessionId)');
        expect(fn).not.toMatch(/relay|getMachineEncryption/i);
    });
    it('the share dialog sends operate only after the acknowledgement AND the confirm modal', () => {
        const src = read('./ShareDialog.tsx');
        expect(src).toMatch(/disabled=\{target\.trim\(\)\.length === 0 \|\| !operatorAck\}/);
        expect(src).toMatch(/if \(role === 'operator'\) \{\s*if \(!operatorAck\) return;/);
        // the only place that sends operate:true is the confirm handler
        expect(src.match(/confirmOperator: true/g)?.length).toBe(1);
        expect(src.slice(src.indexOf('const confirmOperator = async'))).toContain('confirmOperator: true');
        const grant = read('./OperatorGrant.tsx');
        expect(grant).toMatch(/disabled=\{!ack\}/);
        // the three facts Lead required, in the confirm dialog
        for (const key of ['warningRead', 'warningRun', 'warningBackground']) expect(grant).toContain(`share.operator.${key}`);
    });
    it('operator expiry never offers "never"', () => {
        const types = read('../../sync/sessionShareTypes.ts');
        expect(types).toMatch(/OPERATOR_EXPIRY_CHOICES: Exclude<ShareExpiryDays, null>\[\] = \[1, 7, 30\]/);
    });
    it('the presence chip uses danger, never the live accent', () => {
        const css = read('./shared.css').replace(/\/\*[\s\S]*?\*\//g, '');
        const chip = css.match(/\.opchip \{([^}]*)\}/)?.[1] ?? '';
        expect(chip).toContain('var(--danger)');
        expect(chip).not.toContain('--accent');
    });
    it('both languages carry the three warnings', () => {
        const en = read('../../text/_default.ts');
        const zh = read('../../text/translations/zh-Hans.ts');
        expect(en).toContain('including your Very Happy account credentials');
        expect(en).toContain('run any command on this machine as you');
        expect(en).toContain('keep running after you revoke');
        expect(zh).toContain('包括你的 Very Happy 账号凭据');
        expect(zh).toContain('以你的身份在这台机器上执行任意命令');
        expect(zh).toContain('撤销后，对方已经启动的后台进程不会自动停止');
    });
});
