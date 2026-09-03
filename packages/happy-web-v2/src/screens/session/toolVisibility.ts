import { knownTools } from '@/components/tools/knownTools';
import type { ToolCall, ToolCallMessage } from '@/sync/typesMessage';
import { normalizePiToolCall } from '@/components/tools/piToolMapping';
import { parseMcpName } from './toolInfo';

export function isHiddenToolName(name: string): boolean {
    const bareName = parseMcpName(name)?.tool ?? name;
    const definition = knownTools[bareName as keyof typeof knownTools];
    return definition !== undefined && 'hidden' in definition && definition.hidden === true;
}

/** Hidden check on the rendered identity: a pi `change_title` arrives as `other` + `piTool` (B-353). */
export function isHiddenToolCall(tool: ToolCall): boolean {
    return isHiddenToolName(normalizePiToolCall(tool).name);
}

export function visibleToolCalls(messages: ToolCallMessage[]): ToolCallMessage[] {
    return messages.filter((message) => !isHiddenToolCall(message.tool));
}
