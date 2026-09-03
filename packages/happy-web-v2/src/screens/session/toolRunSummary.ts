import type { ToolCall } from '@/sync/typesMessage';
import { toolLabel } from './toolInfo';
import { normalizePiToolCall } from '@/components/tools/piToolMapping';

/** Paseo-style overview without hiding the underlying calls: collapse a run
 * into a short, stable activity scan, while each row remains expandable. */
function activityLabel(rawTool: ToolCall): string {
  const tool = normalizePiToolCall(rawTool);   // B-353: pi bash/read/edit → Terminal/Read/Edit, not Execute/Other
  switch (tool.name) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Write':
      return 'Edit';
    case 'Read':
      return 'Read';
    case 'Bash':
      return 'Terminal';
    case 'Glob':
    case 'Grep':
    case 'LS':
    case 'WebFetch':
    case 'WebSearch':
      return 'Search';
    case 'Task':
    case 'Agent':
      return 'Task';
    default:
      return toolLabel(tool);
  }
}

export function toolRunSummary(tools: readonly ToolCall[], maxKinds = 3): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const label = activityLabel(tool);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  const visible = entries.slice(0, Math.max(1, maxKinds));
  const parts = visible.map(([label, count]) => count > 1 ? `${label} ×${count}` : label);
  const hiddenCalls = entries
    .slice(visible.length)
    .reduce((sum, [, count]) => sum + count, 0);
  if (hiddenCalls > 0) parts.push(`+${hiddenCalls}`);
  return parts.join(' · ');
}
