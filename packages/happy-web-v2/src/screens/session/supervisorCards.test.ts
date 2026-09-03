import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDecisionBlock, parseLedgerOp, parseTickReport } from './supervisorCards';

// Generated from vh-supervisor src/tickRender.js renderTickMessage() (permission + dispatch + orphan items, footnotes).
const TICK = readFileSync(new URL('./__fixtures__/vh-tick.txt', import.meta.url), 'utf8');

describe('parseTickReport', () => {
    it('parses the tickRender output: header, items, sessions, requests, acceptance, commands, footnotes', () => {
        const report = parseTickReport(TICK);
        expect(report).not.toBeNull();
        expect(report!.at).toBe('2026-09-04T10:00:00.000Z');
        expect(report!.summary).toBe('3 items (1 permission, 1 dispatch) — local machine only');
        expect(report!.items.map((i) => [i.number, i.kind, i.taskId])).toEqual([[1, 'permission', 'T-001'], [2, 'dispatch', 'T-002'], [3, 'orphan', null]]);
        const perm = report!.items[0];
        expect(perm.goal).toBe('Fix flaky test');
        expect(perm.autonomy).toBe('rule');
        expect(perm.status).toBe('running');
        expect(perm.sessionRef).toBe('https://x/session/s-att');
        expect(perm.sessionId).toBe('s-att');
        expect(perm.machine).toBe('mac-office');
        expect(perm.sessionState).toBe('attention');
        expect(perm.title).toBe('flaky');
        expect(perm.cwd).toBe('/w');
        expect(perm.acceptance).toEqual(['tests pass 3x', 'PR opened']);
        expect(perm.pendingRequests).toEqual([
            { id: 'r1', tool: 'Bash', waiting: '12m', description: 'git push origin feat/x' },
            { id: 'fb59032b', tool: null, waiting: '3m', description: null },
        ]);
        expect(perm.commands).toHaveLength(6);
        expect(perm.commands[5]).toBe('vh-ledger decide T-001 --action approve|deny --request <id> --reason "<why>"');
        const dispatch = report!.items[1];
        expect(dispatch.cwd).toBe('/w');
        expect(dispatch.acceptance).toEqual(['done']);
        expect(dispatch.sessionId).toBeNull();
        const orphan = report!.items[2];
        expect(orphan.untrackedSessionId).toBe('o1');
        expect(orphan.sessionId).toBe('o1');
        expect(orphan.sessionState).toBe('running');
        expect(report!.footnotes).toHaveLength(2);
        expect(report!.footnotes[0]).toBe('1 unchanged item suppressed until their repeat window closes.');
    });

    it('returns null for non-tick text, unknown kinds and malformed heads', () => {
        expect(parseTickReport('hello')).toBeNull();
        expect(parseTickReport('[vh-tick 2026] 0 items ()\n')).toBeNull();
        expect(parseTickReport('[vh-tick x] 1 item\n\n## 1. bogus — T-1 "g" (autonomy: a, status: b)\n')).toBeNull();
        expect(parseTickReport('[vh-tick x] 1 item\n\n## 1. review — nonsense\n')).toBeNull();
        expect(parseTickReport(' [vh-tick x] 1 item')).toBeNull();
    });
});

describe('parseDecisionBlock', () => {
    const decisions = `[
  { "taskId": "T-012", "action": "accept", "reason": "all criteria met", "citedAcceptance": [0, 2], "requestId": null, "message": null, "command": "very-happy sessions archive s-1" },
  { "taskId": "T-013", "action": "followup", "reason": "needs tests", "citedAcceptance": [], "message": "add tests" }
]`;
    it('takes the LAST fenced json block and strips it from the prose', () => {
        const text = `Looked at both.\n\n\`\`\`json\n{"not":"decisions"}\n\`\`\`\n\nDecisions:\n\n\`\`\`json\n${decisions}\n\`\`\`\n`;
        const block = parseDecisionBlock(text);
        expect(block).not.toBeNull();
        expect(block!.decisions).toHaveLength(2);
        expect(block!.decisions[0]).toEqual({ taskId: 'T-012', action: 'accept', reason: 'all criteria met', citedAcceptance: [0, 2], requestId: null, message: null, command: 'very-happy sessions archive s-1' });
        expect(block!.decisions[1].message).toBe('add tests');
        expect(block!.decisions[1].command).toBeNull();
        expect(block!.prose).toContain('{"not":"decisions"}');
        expect(block!.prose).not.toContain('T-012');
        expect(block!.prose.endsWith('Decisions:')).toBe(true);
    });

    it('returns null when no block, invalid json, non-array, missing fields or action outside the charter set', () => {
        expect(parseDecisionBlock('plain text')).toBeNull();
        expect(parseDecisionBlock('```json\n{oops\n```')).toBeNull();
        expect(parseDecisionBlock('```json\n{"taskId":"T-1","action":"accept"}\n```')).toBeNull();
        expect(parseDecisionBlock('```json\n[]\n```')).toBeNull();
        expect(parseDecisionBlock('```json\n[{"taskId":"T-1"}]\n```')).toBeNull();
        expect(parseDecisionBlock('```json\n[{"taskId":"T-1","action":"yolo"}]\n```')).toBeNull();
        expect(parseDecisionBlock('```json\n[{"taskId":"T-1","action":"accept"}, 3]\n```')).toBeNull();
    });
});

describe('parseLedgerOp', () => {
    it('parses decide with action/reason/cite/request, bind and add (ledgerCli.test.js argv shapes)', () => {
        const decide = parseLedgerOp('vh-ledger decide T-001 --action accept --reason "all green" --cite 0,1 --json');
        expect(decide).toMatchObject({ subcommand: 'decide', taskId: 'T-001', action: 'accept', reason: 'all green', cite: [0, 1] });
        const approve = parseLedgerOp('bin/vh-ledger decide T-001 --action approve --reason \'policy allows\' --request req-1');
        expect(approve).toMatchObject({ subcommand: 'decide', taskId: 'T-001', action: 'approve', requestId: 'req-1', reason: 'policy allows' });
        expect(parseLedgerOp('vh-ledger bind T-002 cmtabc123')).toMatchObject({ subcommand: 'bind', taskId: 'T-002', sessionId: 'cmtabc123' });
        const add = parseLedgerOp('vh-ledger add --goal "Fix flaky test" --cwd /w --acceptance "tests pass" --autonomy rule --session o1');
        expect(add).toMatchObject({ subcommand: 'add', taskId: null, goal: 'Fix flaky test', sessionId: 'o1', action: null, cite: [] });
    });

    it('returns null for other commands, unknown subcommands, bad actions and unterminated quotes', () => {
        expect(parseLedgerOp('git push origin main')).toBeNull();
        expect(parseLedgerOp('vh-ledger show T-1')).toBeNull();
        expect(parseLedgerOp('echo vh-ledger decide T-1')).toBeNull();
        expect(parseLedgerOp('vh-ledger decide T-1 --action nope --reason x')).toBeNull();
        expect(parseLedgerOp('vh-ledger decide T-1 --action note --reason "unterminated')).toBeNull();
    });
});
