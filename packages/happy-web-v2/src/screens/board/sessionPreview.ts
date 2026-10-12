/**
 * B-553 / B-558 — what a board card says about a session's latest round,
 * derived purely from data the web already holds (spec
 * `specs/2026-10-agent-set-status.md` §4/§5):
 *
 *  - `sessionPreview`: 「你：最后一句」 + the agent's reply to it, and how that
 *    round ended (stopped by the user / failed), from the session's already
 *    loaded messages. No fetch: a session whose messages were never loaded in
 *    this tab simply has no preview.
 *  - `pendingQuestionSummary`: a one-line summary of the earliest pending
 *    permission request / AskUserQuestion from `agentState.requests`.
 *
 * Pure (no store / i18n imports) so it is unit-tested directly.
 */
import type { Message } from '@/sync/typesMessage';
import { stripHarnessBlocks, parseTaskNotification } from '@/screens/session/harness';
import { presentServiceEvent } from '@/screens/session/serviceEvent';
import { stripAttachedFiles } from '@/screens/session/attachedFiles';
import { extractOptions } from '@/screens/session/optionsBlock';

/** hard cap before CSS line-clamp does the visual truncation */
export const PREVIEW_MAX_CHARS = 300;

export type RoundOutcome = 'interrupted' | 'failed';

export interface SessionPreview {
  /** the user's latest turn-opening message, plain text */
  user?: string;
  /** the agent's latest reply AFTER that message (absent = no reply yet) */
  agent?: string;
  /** how the latest round ended, when it did not end normally */
  outcome?: RoundOutcome;
}

/** Markdown → one plain line (cheap, display-only; never round-tripped). */
export function plainPreviewText(raw: string, max = PREVIEW_MAX_CHARS): string {
  const text = raw
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // `__bold__` only at word boundaries: identifiers like mcp__happy__x stay intact
    .replace(/(^|[^\w])__(?!\s)([^_\n]+?)__(?!\w)/g, '$1$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function userPreviewText(message: Extract<Message, { kind: 'user-text' }>): string {
  return plainPreviewText(stripAttachedFiles(stripHarnessBlocks(message.displayText ?? message.text)));
}

/** A user message that opens a round the user actually wrote. */
function isRoundOpener(message: Extract<Message, { kind: 'user-text' }>): boolean {
  // Not yet consumed (queued) or never ran (canceled): not the current round.
  if (message.inputState !== undefined) return false;
  const raw = message.displayText ?? message.text;
  // Background-task notices are injected as user messages, but nobody "said" them.
  if (parseTaskNotification(raw) !== null) return false;
  return userPreviewText(message).length > 0;
}

/**
 * Scan `newestFirst` (the store's order) back to the latest round opener.
 * Only the newest agent reply and the newest stop/failure event that come
 * AFTER the opener count; nothing from earlier rounds leaks in.
 */
export function sessionPreview(newestFirst: readonly Message[]): SessionPreview | null {
  const preview: SessionPreview = {};
  for (const message of newestFirst) {
    if (message.kind === 'user-text') {
      if (!isRoundOpener(message)) continue;
      preview.user = userPreviewText(message);
      break;
    }
    if (message.kind === 'agent-text') {
      if (message.isThinking || preview.agent !== undefined) continue;
      const text = plainPreviewText(extractOptions(stripHarnessBlocks(message.text)).text);
      if (text) preview.agent = text;
      continue;
    }
    if (message.kind === 'agent-event' && message.event.type === 'message' && preview.outcome === undefined && preview.agent === undefined) {
      // Only an event NEWER than the reply can describe how the round ended.
      const presented = presentServiceEvent(message.event.message);
      if (presented.kind === 'stopped') preview.outcome = 'interrupted';
      else if (presented.kind === 'error' || presented.kind === 'agent-error' || presented.kind === 'claude-auth') preview.outcome = 'failed';
    }
  }
  return preview.user === undefined && preview.agent === undefined && preview.outcome === undefined ? null : preview;
}

type PendingRequest = { tool: string; arguments?: unknown; createdAt?: number | null; kind?: string };

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstLine(value: string): string {
  return plainPreviewText(value.split('\n').find((line) => line.trim()) ?? '');
}

/** Commands, paths and tool names are literal: collapse whitespace, never strip markdown. */
function oneLine(value: string, max = 200): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** One-line summary of the EARLIEST pending request, or undefined. */
export function pendingQuestionSummary(requests: Record<string, PendingRequest> | null | undefined): string | undefined {
  if (!requests) return undefined;
  let earliest: PendingRequest | undefined;
  for (const request of Object.values(requests)) {
    if (!earliest || (request.createdAt ?? Infinity) < (earliest.createdAt ?? Infinity)) earliest = request;
  }
  if (!earliest) return undefined;
  const args = (earliest.arguments && typeof earliest.arguments === 'object' ? earliest.arguments : {}) as Record<string, unknown>;
  if (earliest.tool === 'AskUserQuestion') {
    const questions = Array.isArray(args.questions) ? args.questions : [];
    const first = questions.map((q) => str((q as { question?: unknown })?.question)).find(Boolean);
    if (first) return oneLine(questions.length > 1 ? `${first} (+${questions.length - 1})` : first);
  }
  if (earliest.kind === 'elicitation' || earliest.kind === 'user_dialog') {
    const message = str(args.message) ?? str(args.question) ?? str(args.title);
    if (message) return oneLine(message);
  }
  if (earliest.tool === 'ExitPlanMode') {
    const plan = str(args.plan);
    if (plan) return oneLine(`${earliest.tool} · ${firstLine(plan)}`);
  }
  const command = args.command;
  const detail = (Array.isArray(command) ? command.filter((part) => typeof part === 'string').join(' ') : str(command))
    ?? str(args.file_path) ?? str(args.path) ?? str(args.url) ?? str(args.pattern) ?? str(args.description);
  return oneLine(detail ? `${earliest.tool} · ${detail}` : earliest.tool);
}
