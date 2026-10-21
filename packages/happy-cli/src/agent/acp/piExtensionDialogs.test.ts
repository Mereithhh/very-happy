import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AcpBackend } from './AcpBackend';
import { piDialogOutcome, piSelectQuestionInput, readPiExtensionDialog } from './piExtensionDialogs';

const select = {
  toolCall: { toolCallId: 'pi-ui-3', title: 'Pick a color', rawInput: { method: 'select', title: 'Pick a color', options: ['Red', 'Blue'] } },
  options: [{ optionId: 'choice-0', name: 'Red' }, { optionId: 'choice-1', name: 'Blue' }],
};
const confirm = {
  toolCall: { toolCallId: 'pi-ui-4', title: 'Proceed?', rawInput: { method: 'confirm', title: 'Proceed?' } },
  options: [{ optionId: 'yes', name: 'Yes' }, { optionId: 'no', name: 'No' }],
};

describe('pi extension dialogs (B-632 ②)', () => {
  it('recognises a select and a confirm, and nothing else', () => {
    expect(readPiExtensionDialog(select)).toEqual({ kind: 'select', question: 'Pick a color', options: [{ optionId: 'choice-0', label: 'Red' }, { optionId: 'choice-1', label: 'Blue' }] });
    expect(readPiExtensionDialog(confirm)).toEqual({ kind: 'confirm' });
    expect(readPiExtensionDialog({ ...select, toolCall: { ...select.toolCall, toolCallId: 'call-1' } })).toBeNull();
    expect(readPiExtensionDialog({ toolCall: { toolCallId: 'pi-ui-5', rawInput: { method: 'select' } }, options: [{ optionId: 'proceed_once', name: 'Allow' }] })).toBeNull();
  });

  it('a select becomes the AskUserQuestion card input', () => {
    const dialog = readPiExtensionDialog(select)!;
    expect(piSelectQuestionInput(dialog as any)).toEqual({ questions: [{ question: 'Pick a color', header: 'Pick a color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false }] });
  });

  it('the answer selects exactly the picked option; anything else cancels instead of guessing', () => {
    const dialog = readPiExtensionDialog(select)!;
    expect(piDialogOutcome(dialog, { decision: 'approved', updatedInput: { answers: { 'Pick a color': 'Blue' } } })).toEqual({ outcome: 'selected', optionId: 'choice-1' });
    expect(piDialogOutcome(dialog, { decision: 'approved', updatedInput: { answers: { 'Pick a color': 'Green (typed)' } } })).toEqual({ outcome: 'cancelled' });
    // The old bug: a bare approve picked choice-0.
    expect(piDialogOutcome(dialog, { decision: 'approved' })).toEqual({ outcome: 'cancelled' });
    expect(piDialogOutcome(dialog, { decision: 'denied' })).toEqual({ outcome: 'cancelled' });
  });

  it('a confirm answers yes / no by name', () => {
    expect(piDialogOutcome({ kind: 'confirm' }, { decision: 'approved' })).toEqual({ outcome: 'selected', optionId: 'yes' });
    expect(piDialogOutcome({ kind: 'confirm' }, { decision: 'approved_for_session' })).toEqual({ outcome: 'selected', optionId: 'yes' });
    expect(piDialogOutcome({ kind: 'confirm' }, { decision: 'denied' })).toEqual({ outcome: 'selected', optionId: 'no' });
  });
});

describe('AcpBackend answers a pi dialog over the wire (B-632 ②)', () => {
  const fixture = fileURLToPath(new URL('./__fixtures__/fakeAcpAgent.mjs', import.meta.url));
  const backends: AcpBackend[] = [];
  afterEach(async () => { for (const b of backends.splice(0)) await b.dispose(); });

  async function run(scenario: string, answer: (toolName: string, input: any) => any) {
    const seen: Array<{ toolName: string; input: any }> = [];
    const backend = new AcpBackend({
      agentName: 'pi', cwd: process.cwd(), command: process.execPath, args: [fixture, scenario],
      permissionHandler: { handleToolCall: async (_id: string, toolName: string, input: unknown) => { seen.push({ toolName, input }); return answer(toolName, input); } },
    } as any);
    backends.push(backend);
    const texts: string[] = [];
    backend.onMessage((m: any) => { if (m.type === 'model-output' && m.textDelta) texts.push(m.textDelta); });
    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, 'go');
    await backend.waitForResponseComplete?.(50);
    return { seen, texts };
  }

  it('select: asked as AskUserQuestion, the picked label selects its choice id', async () => {
    const { seen, texts } = await run('dialog-select', () => ({ decision: 'approved', updatedInput: { answers: { 'Pick a color': 'Blue' } } }));
    expect(seen[0].toolName).toBe('AskUserQuestion');
    expect(seen[0].input.questions[0].options.map((o: any) => o.label)).toEqual(['Red', 'Blue']);
    expect(texts.join('')).toContain('dialog:choice-1');
  });

  it('confirm: deny answers `no`, not an unknown option id', async () => {
    const { seen, texts } = await run('dialog-confirm', () => ({ decision: 'denied' }));
    expect(seen[0].toolName).not.toBe('AskUserQuestion');
    expect(texts.join('')).toContain('dialog:no');
  });
});
