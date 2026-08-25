import { knownTools } from '@/components/tools/knownTools';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { parseMcpName } from './toolInfo';

export function isHiddenToolName(name: string): boolean {
    const bareName = parseMcpName(name)?.tool ?? name;
    const definition = knownTools[bareName as keyof typeof knownTools];
    return definition !== undefined && 'hidden' in definition && definition.hidden === true;
}

export function visibleToolCalls(messages: ToolCallMessage[]): ToolCallMessage[] {
    return messages.filter((message) => !isHiddenToolName(message.tool.name));
}
