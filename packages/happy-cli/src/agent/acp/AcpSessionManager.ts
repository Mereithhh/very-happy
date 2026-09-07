import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, streamKeyOf, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { AgentMessage } from '@/agent/core';

/**
 * Where the mapper reports the text it is still holding back (B-309 for ACP).
 *
 * `mapMessage` accumulates streamed model output and only emits the persisted
 * `text` envelope when the stream switches type, a tool starts, or the turn
 * ends — a whole answer with no tool calls is therefore invisible to the web
 * until the turn is over, which is exactly the "terminal shows it, session
 * doesn't" report. This sink is the bypass: every delta is handed over the
 * instant it arrives, keyed by the same `streamKey` the eventual envelope
 * carries, so the web paints a draft and swaps it for the real message with
 * no flicker. `StreamRelay` (claude/streamRelay.ts) satisfies it structurally.
 *
 * Only text and thinking flow through here. Tool calls already leave the
 * mapper immediately as real `tool-call-start` envelopes.
 */
export interface AcpStreamSink {
  openBlock(mid: string, idx: number, kind: 'text' | 'thinking'): void;
  appendDelta(mid: string, idx: number, text: string): void;
  closeBlock(mid: string, idx: number): void;
}

export interface AcpSessionManagerOptions {
  /** Optional: without it the mapper behaves exactly as before (no drafts). */
  stream?: AcpStreamSink;
}

function turnOptions(turnId: string | null, time: number): CreateEnvelopeOptions {
  return turnId ? { turn: turnId, time } : { time };
}

function buildToolTitle(toolName: string): string {
  return toolName;
}

function buildToolDescription(toolName: string): string {
  return `Running ${toolName}`;
}

/**
 * Carry a tool result onto `tool-call-end` only when the runner produced a
 * text result (today: pi-acp bash output, see acpToolArgs.buildAcpBashResult).
 * The wire slot already exists (B-260-P2 `result.{text,isError,truncated}`);
 * other ACP results stay off the wire as before.
 */
function toolCallEndResult(result: unknown): { text: string; isError?: boolean; truncated?: boolean } | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const record = result as { text?: unknown; exitCode?: unknown; truncated?: unknown };
  if (typeof record.text !== 'string') return undefined;
  const exitCode = typeof record.exitCode === 'number' ? record.exitCode : undefined;
  const text = exitCode !== undefined && exitCode !== 0 ? `${record.text}${record.text.endsWith('\n') || record.text === '' ? '' : '\n'}[exit code ${exitCode}]` : record.text;
  return {
    text,
    ...(exitCode !== undefined && exitCode !== 0 ? { isError: true } : {}),
    ...(record.truncated === true ? { truncated: true } : {}),
  };
}

function parseThinkingPayload(payload: unknown): { text: string; streaming: boolean } {
  if (typeof payload === 'string') {
    return { text: payload, streaming: false };
  }
  if (!payload || typeof payload !== 'object') {
    return { text: '', streaming: false };
  }
  const text = typeof (payload as { text?: unknown }).text === 'string'
    ? (payload as { text: string }).text
    : '';
  const streaming = (payload as { streaming?: unknown }).streaming === true;
  return { text, streaming };
}

export class AcpSessionManager {
  private currentTurnId: string | null = null;
  private readonly acpCallToSessionCall = new Map<string, string>();
  private readonly stream: AcpStreamSink | null;

  /** Monotonic clock: max(lastTime + 1, Date.now()) */
  private lastTime = 0;

  /** Pending text waiting to be flushed when the stream type changes */
  private pendingText = '';
  private pendingType: 'thinking' | 'output' | null = null;
  /**
   * Draft identity of the pending block: `<turn id>:<block index>`. There is
   * no API message id on this path, so the turn id plays that role and the
   * index counts blocks within the turn. Null while no turn is open — text
   * outside a turn (pi's startup banner) is persisted as before but never
   * drafted, since the web only paints drafts for a live turn anyway.
   */
  private pendingKey: { mid: string; idx: number } | null = null;
  private blockCursor = 0;

  constructor(options: AcpSessionManagerOptions = {}) {
    this.stream = options.stream ?? null;
  }

  private nextTime(): number {
    this.lastTime = Math.max(this.lastTime + 1, Date.now());
    return this.lastTime;
  }

  private ensureSessionCallId(acpCallId: string): string {
    const existing = this.acpCallToSessionCall.get(acpCallId);
    if (existing) {
      return existing;
    }

    const created = createId();
    this.acpCallToSessionCall.set(acpCallId, created);
    return created;
  }

  /**
   * Route one streamed delta into the pending block, opening a new block (and
   * flushing the previous one) when the kind changes. Returns the envelopes
   * the switch flushed.
   */
  private accumulate(type: 'thinking' | 'output', text: string): SessionEnvelope[] {
    const flushed = this.pendingType !== type ? this.flush() : [];
    if (this.pendingType === null) {
      this.pendingType = type;
      if (this.currentTurnId && this.stream) {
        this.pendingKey = { mid: this.currentTurnId, idx: this.blockCursor++ };
        this.stream.openBlock(this.pendingKey.mid, this.pendingKey.idx, type === 'thinking' ? 'thinking' : 'text');
      }
    }
    this.pendingText += text;
    if (this.pendingKey && this.stream) {
      this.stream.appendDelta(this.pendingKey.mid, this.pendingKey.idx, text);
    }
    return flushed;
  }

  private flush(): SessionEnvelope[] {
    // Close the draft even when the persisted text ends up empty after
    // trimming: an open block would keep the web's caret blinking until the
    // orphan timeout, while a closed unclaimed one is swept with the turn.
    const key = this.pendingKey;
    this.pendingKey = null;
    if (key && this.stream) {
      this.stream.closeBlock(key.mid, key.idx);
    }
    if (!this.pendingText || !this.pendingType) {
      this.pendingType = null;
      return [];
    }
    const text = this.pendingText.replace(/^\n+|\n+$/g, '');
    const type = this.pendingType;
    this.pendingText = '';
    this.pendingType = null;

    if (!text) {
      return [];
    }
    // The `streamKey` is what lets the web replace the draft with this exact
    // message instead of showing both until the sweep.
    const options: CreateEnvelopeOptions = {
      ...turnOptions(this.currentTurnId, this.nextTime()),
      ...(key ? { streamKey: streamKeyOf(key.mid, key.idx) } : {}),
    };
    if (type === 'thinking') {
      return [createEnvelope('agent', { t: 'text', text, thinking: true }, options)];
    }
    return [createEnvelope('agent', { t: 'text', text }, options)];
  }

  startTurn(): SessionEnvelope[] {
    if (this.currentTurnId) {
      return [];
    }

    // Text that arrived before the turn (pi's startup banner) is persisted on
    // its own, outside the turn. Left pending, it would be glued onto the
    // first answer AND keep that answer off the draft channel, because the
    // pending block was opened before a turn id existed.
    const flushed = this.flush();
    this.currentTurnId = createId();
    this.acpCallToSessionCall.clear();
    this.blockCursor = 0;
    return [
      ...flushed,
      createEnvelope('agent', { t: 'turn-start' }, { turn: this.currentTurnId, time: this.nextTime() }),
    ];
  }

  endTurn(status: 'completed' | 'failed' | 'cancelled'): SessionEnvelope[] {
    const flushed = this.flush();
    if (!this.currentTurnId) {
      return flushed;
    }

    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    this.acpCallToSessionCall.clear();
    return [
      ...flushed,
      createEnvelope('agent', { t: 'turn-end', status }, { turn: turnId, time: this.nextTime() }),
    ];
  }

  mapMessage(msg: AgentMessage): SessionEnvelope[] {
    if (msg.type === 'event' && msg.name === 'thinking') {
      const { text, streaming } = parseThinkingPayload(msg.payload);
      if (!text) {
        return [];
      }

      if (streaming) {
        // Streaming thinking: accumulate, flush if switching from a different type
        return this.accumulate('thinking', text);
      }

      // Non-streaming thinking: flush pending, emit immediately
      const trimmed = text.replace(/^\n+|\n+$/g, '');
      if (!trimmed) {
        return this.flush();
      }
      return [
        ...this.flush(),
        createEnvelope('agent', { t: 'text', text: trimmed, thinking: true }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'status') {
      return [];
    }

    if (msg.type === 'model-output') {
      const text = msg.textDelta ?? '';
      if (!text) {
        return [];
      }
      // Accumulate output, flush if switching from a different type
      return this.accumulate('output', text);
    }

    if (msg.type === 'tool-call') {
      const flushed = this.flush();
      const call = this.ensureSessionCallId(msg.callId);
      return [
        ...flushed,
        createEnvelope('agent', {
          t: 'tool-call-start',
          call,
          name: msg.toolName,
          title: buildToolTitle(msg.toolName),
          description: buildToolDescription(msg.toolName),
          args: msg.args,
        }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'tool-result') {
      const flushed = this.flush();
      const call = this.ensureSessionCallId(msg.callId);
      const result = toolCallEndResult(msg.result);
      return [
        ...flushed,
        createEnvelope('agent', { t: 'tool-call-end', call, ...(result ? { result } : {}) }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    return [];
  }
}
