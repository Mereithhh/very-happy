/**
 * ACP tool-call fidelity (B-353 lane I).
 *
 * pi-acp only tells us `kind` (read/edit/execute/other), but the web wants to
 * know *which* pi tool ran and with what input so it can reuse the Claude
 * Bash/Read/Edit/Write renderers. Probed pi-acp 0.0.33 payload shape
 * (`skills/tmp/vh-supervisor/ADDENDUM-batch3.md`):
 *
 * - bash:   title = the command text, kind = `execute`, no rawInput
 *           (output streams in `_meta.terminal_output.data`, exit code in
 *           `_meta.terminal_exit.exit_code`)
 * - read / write / edit / other tools: title = pi tool name, kind mapped,
 *   rawInput = tool args
 *
 * Everything here is additive and optional: `toolName` stays `kind` for old
 * web builds (铁律 4), and nothing throws on odd input.
 */

export const ACP_RAW_INPUT_MAX_BYTES = 64 * 1024;
export const ACP_TERMINAL_OUTPUT_MAX_BYTES = 64 * 1024;

/** pi tool names are plain identifiers; anything else in `title` is a description, not a tool. */
const PI_TOOL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export interface AcpToolArgs {
  acpTitle?: string;
  acpKind?: string;
  rawInput?: Record<string, unknown>;
  rawInputTruncated?: true;
  piTool?: string;
  command?: string;
}

/**
 * Derive the additive args for a `tool-call` event from an ACP `tool_call`
 * update. Pure; never throws.
 *
 * `acpTitle` / `acpKind` / `rawInput` are generic ACP passthrough. `piTool` /
 * `command` are only derived when `agentName === 'pi'`: they encode pi-acp's
 * title convention (execute title = the command; other titles = the pi tool
 * name), and the web uses `piTool` as evidence that a session *is* pi. Gemini's
 * execute titles look like `rm f [cwd /x] (desc)` and must not become `command`.
 */
export function deriveAcpToolArgs(
  update: {
    title?: unknown;
    kind?: unknown;
    rawInput?: unknown;
  },
  options: { agentName?: string } = {}
): AcpToolArgs {
  const args: AcpToolArgs = {};
  const title = typeof update.title === 'string' ? update.title : undefined;
  const kind = typeof update.kind === 'string' ? update.kind : undefined;

  if (title !== undefined) args.acpTitle = title;
  if (kind !== undefined) args.acpKind = kind;

  if (update.rawInput && typeof update.rawInput === 'object' && !Array.isArray(update.rawInput)) {
    const rawInput = update.rawInput as Record<string, unknown>;
    if (serializedSize(rawInput) <= ACP_RAW_INPUT_MAX_BYTES) {
      args.rawInput = rawInput;
    } else {
      args.rawInputTruncated = true;
    }
  }

  if (options.agentName !== 'pi') return args;

  if (kind === 'execute') {
    args.piTool = 'bash';
    if (title !== undefined) args.command = title;
  } else if (title !== undefined && PI_TOOL_NAME_RE.test(title)) {
    args.piTool = title;
  }

  return args;
}

function serializedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Resolve the id / tool name / `arguments` for an ACP `request_permission`.
 *
 * The permission id is `toolCall.id` (legacy transports) or a fresh UUID —
 * deliberately NOT ACP's `toolCall.toolCallId`: `AcpBackend` answers an
 * approval with a `tool-result` keyed by the permission id, and if that id were
 * the real tool call id the web would close the tool row at approval time and
 * drop the genuine completed/failed result that follows (Gemini flow; review
 * of B-353 lane I). pi-acp's gate ids (`pi-ui-<n>`) never appear as a
 * standalone `tool_call`, so pi does not need the stable id either.
 *
 * `input` prefers explicit `input`/`arguments`, then pi-acp's `rawInput`, then
 * `content`; pi gate title / reason are merged in as optional fields.
 * Pure apart from the UUID; never throws.
 */
export function resolveAcpPermissionRequest(params: {
  toolCall?: {
    id?: string;
    toolCallId?: string;
    title?: string;
    kind?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    arguments?: Record<string, unknown>;
    rawInput?: Record<string, unknown>;
    content?: Record<string, unknown>;
  };
  kind?: string;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  content?: Record<string, unknown>;
}, newId: () => string): { toolCallId: string; toolName: string; input: Record<string, unknown> } {
  const toolCall = params.toolCall;
  const toolName = toolCall?.kind || toolCall?.toolName || params.kind || 'Unknown tool';
  const toolCallId = toolCall?.id || newId();

  let input: Record<string, unknown>;
  if (toolCall) {
    input = toolCall.input || toolCall.arguments || toolCall.rawInput || toolCall.content || {};
  } else {
    input = params.input || params.arguments || params.content || {};
  }
  // B-353: surface ACP title/kind so the web ask card can show pi's gate rule id + reason
  // (pi-acp puts them in toolCall.title / rawInput.{title,message}) instead of a bare "other".
  input = { ...input, ...buildAcpPermissionMeta(toolCall) };

  return { toolCallId, toolName, input };
}

export interface AcpTerminalMeta {
  outputDelta?: string;
  exitCode?: number;
}

/**
 * Read pi-acp's bash streaming meta from a `tool_call_update`. Pure; never throws.
 */
export function readAcpTerminalMeta(update: Record<string, unknown>): AcpTerminalMeta {
  const meta = update._meta;
  if (!meta || typeof meta !== 'object') return {};
  const record = meta as Record<string, unknown>;
  const result: AcpTerminalMeta = {};

  const output = record.terminal_output;
  if (output && typeof output === 'object') {
    const data = (output as Record<string, unknown>).data;
    if (typeof data === 'string' && data.length > 0) result.outputDelta = data;
  }

  const exit = record.terminal_exit;
  if (exit && typeof exit === 'object') {
    const code = (exit as Record<string, unknown>).exit_code;
    if (typeof code === 'number' && Number.isFinite(code)) result.exitCode = code;
  }

  return result;
}

/**
 * Append a streamed output chunk, keeping the tail within
 * ACP_TERMINAL_OUTPUT_MAX_BYTES (the head is what the model saw first and is
 * the least useful part to keep once the buffer overflows).
 */
export function appendTerminalOutput(previous: string, delta: string): string {
  const next = previous + delta;
  if (Buffer.byteLength(next, 'utf8') <= ACP_TERMINAL_OUTPUT_MAX_BYTES) return next;
  const buf = Buffer.from(next, 'utf8');
  return buf.subarray(buf.length - ACP_TERMINAL_OUTPUT_MAX_BYTES).toString('utf8');
}

export interface AcpBashResult {
  text: string;
  exitCode: number | undefined;
  truncated?: true;
}

/**
 * Build the tool result carried on `tool-call-end` for a bash call. The wire
 * schema already has `result.{text,isError,truncated}` (B-260-P2), so no
 * schema change is needed for the web to display it.
 */
export function buildAcpBashResult(output: string | undefined, exitCode: number | undefined): AcpBashResult | undefined {
  if (output === undefined && exitCode === undefined) return undefined;
  const text = output ?? '';
  const truncated = Buffer.byteLength(text, 'utf8') >= ACP_TERMINAL_OUTPUT_MAX_BYTES;
  return {
    text,
    exitCode,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * Additive fields for a permission request's `arguments` so the web ask card
 * can show pi's gate rule id / reason. pi-acp's `request_permission` carries
 * `toolCall.title` (the gate's confirm title) and `rawInput.{method,title,message}`.
 * Pure; never throws; returns {} when nothing usable is present.
 */
export function buildAcpPermissionMeta(toolCall: { title?: unknown; kind?: unknown; rawInput?: unknown } | undefined): {
  acpTitle?: string;
  acpKind?: string;
  message?: string;
} {
  if (!toolCall) return {};
  const meta: { acpTitle?: string; acpKind?: string; message?: string } = {};
  if (typeof toolCall.title === 'string' && toolCall.title.length > 0) meta.acpTitle = toolCall.title;
  if (typeof toolCall.kind === 'string' && toolCall.kind.length > 0) meta.acpKind = toolCall.kind;
  const raw = toolCall.rawInput;
  if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).message === 'string') {
    meta.message = (raw as Record<string, unknown>).message as string;
  }
  return meta;
}
