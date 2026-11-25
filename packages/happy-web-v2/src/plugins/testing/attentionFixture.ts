/** Test fixture: a complete wire `AttentionItemAny` (only the fields under test vary). */
export function attentionItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'att_1', sessionId: null, pluginInstallId: null, teamId: null, projectId: null, source: 'plugin', kind: 'decision', key: 'k', title: 'T', bodyMd: null,
    options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null,
    resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: null, pushedAt: null, version: 1, payload: null,
    ...over,
  };
}

/** A wire `AttentionPluginPayload` for a plugin card. */
export function pluginPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, type: 'plugin', pluginId: 'hello-board', pluginName: 'Hello', machineId: 'm1', decisionKind: 'choice', pluginState: 'open', ...over };
}
