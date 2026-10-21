/**
 * B-632 ②: pi extension dialogs (`ctx.ui.select` / `ctx.ui.confirm`) reach us
 * through pi-acp as ACP permission requests — toolCallId `pi-ui-<id>`,
 * rawInput `{ method, title, message?, options? }`, options `choice-<n>`
 * (select) or `yes`/`no` (confirm) (pi-acp 0.0.33 dist/index.js
 * handleExtensionSelect / handleExtensionConfirm).
 *
 * They used to be shown as a yes/no approval card, and Approve silently picked
 * the first option (the generic "proceed_once, else options[0]" fallback). A
 * select is a question: it is shown as the AskUserQuestion card the web already
 * has, and the answer selects exactly the option whose label the user picked —
 * anything else (free text, nothing, Deny) cancels the dialog instead of
 * guessing. A confirm keeps the approval card, but Approve/Deny now name `yes`
 * / `no` explicitly. (Orca src/main/pi/rpc-extension-dialogs.ts: answers must
 * be one of the offered options.) pi's `input` / `editor` dialogs are cancelled
 * inside pi-acp itself and never reach us.
 */

export type PiExtensionDialog =
  | { kind: 'select'; question: string; options: Array<{ optionId: string; label: string }> }
  | { kind: 'confirm' };

type DialogRequest = {
  toolCall?: { toolCallId?: string; title?: string; rawInput?: Record<string, unknown> };
  options?: Array<{ optionId?: string; name?: string }>;
};

const CHOICE = /^choice-\d+$/;

export function readPiExtensionDialog(params: DialogRequest): PiExtensionDialog | null {
  const toolCall = params.toolCall;
  if (!toolCall || typeof toolCall.toolCallId !== 'string' || !toolCall.toolCallId.startsWith('pi-ui-')) return null;
  const method = toolCall.rawInput?.method;
  const options = params.options ?? [];
  if (method === 'select' && options.length > 0 && options.every((o) => typeof o.optionId === 'string' && CHOICE.test(o.optionId))) {
    const title = typeof toolCall.rawInput?.title === 'string' ? toolCall.rawInput.title : toolCall.title;
    return {
      kind: 'select',
      question: typeof title === 'string' && title.trim() ? title : 'pi asks',
      options: options.map((o) => ({ optionId: o.optionId!, label: String(o.name ?? o.optionId) })),
    };
  }
  if (method === 'confirm' && options.some((o) => o.optionId === 'yes') && options.some((o) => o.optionId === 'no')) {
    return { kind: 'confirm' };
  }
  return null;
}

/** The AskUserQuestion input the web card renders for a select. */
export function piSelectQuestionInput(dialog: Extract<PiExtensionDialog, { kind: 'select' }>, message?: unknown) {
  return {
    questions: [{
      question: dialog.question,
      header: dialog.question.length > 30 ? `${dialog.question.slice(0, 29)}…` : dialog.question,
      options: dialog.options.map((o) => ({ label: o.label, description: '' })),
      multiSelect: false,
    }],
    ...(typeof message === 'string' && message.trim() ? { message } : {}),
  };
}

export type PiDialogOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

/**
 * The ACP answer for a dialog. `answers` is what the web card sends in
 * `updatedInput` (`{ [question]: label }`, several labels joined with ", ").
 */
export function piDialogOutcome(
  dialog: PiExtensionDialog,
  result: { decision: 'approved' | 'approved_for_session' | 'denied' | 'abort'; updatedInput?: Record<string, unknown> },
): PiDialogOutcome {
  const approved = result.decision === 'approved' || result.decision === 'approved_for_session';
  if (dialog.kind === 'confirm') return { outcome: 'selected', optionId: approved ? 'yes' : 'no' };
  if (!approved) return { outcome: 'cancelled' };
  const answers = result.updatedInput?.answers;
  const picked = answers && typeof answers === 'object' ? (answers as Record<string, unknown>)[dialog.question] : undefined;
  if (typeof picked !== 'string') return { outcome: 'cancelled' };
  const match = dialog.options.find((o) => o.label === picked);
  return match ? { outcome: 'selected', optionId: match.optionId } : { outcome: 'cancelled' };
}
