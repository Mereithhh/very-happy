import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => null }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://srv.test' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'client' }));

const { parsePluginDecision, parseOwnerSystemCard, handlePluginAttentionUpdate, usePluginDecisions } = await import('./pluginDecisions');
const { attentionItem, pluginPayload } = await import('@/plugins/testing/attentionFixture');

// DESIGN r5: item = wire AttentionItemAny + pluginInstallId; plugin fields in payload (AttentionPluginPayloadSchema).
const payload = pluginPayload();
const base = attentionItem({ pluginInstallId: 'pi_1', payload });

describe('parsePluginDecision (r5 payload)', () => {
  it('only wire-valid plugin items with an install and a plugin payload', () => {
    expect(parsePluginDecision({ ...base, needsOwner: undefined })).toBeNull();
    expect(parsePluginDecision({ ...base, payload: { v: 1, type: 'wrapup' } })).toBeNull();
    expect(parsePluginDecision({ ...base, source: 'agent' })).toBeNull();
    expect(parsePluginDecision({ ...base, pluginInstallId: undefined })).toBeNull();
  });

  it('choice: ≤ 4 options, styles from payload.optionStyles', () => {
    const d = parsePluginDecision({ ...base, options: [1, 2, 3, 4, 5].map((n) => ({ id: `o${n}`, label: `L${n}` })), payload: { ...payload, optionStyles: { o2: 'danger', o3: 'neon' } } })!;
    expect(d.kind).toBe('choice');
    expect(d.options.map((o) => `${o.id}:${o.style}`)).toEqual(['o1:default', 'o2:danger', 'o3:default', 'o4:default']);
  });

  it('input (multiline) and notice come from payload.decisionKind', () => {
    const i = parsePluginDecision({ ...base, kind: 'input', payload: { ...payload, decisionKind: 'input', input: { placeholder: 'p', maxLength: 99999, multiline: true } } })!;
    expect(i.input).toEqual({ placeholder: 'p', maxLength: 2000, multiline: true });
    expect(parsePluginDecision({ ...base, kind: 'report', payload: { ...payload, decisionKind: 'notice' } })!.kind).toBe('notice');
  });

  it('pluginState / response / delivery; 24h without ack → unacknowledged unless failed or delivered', () => {
    const now = 100 * 3600_000;
    const at = now - 25 * 3600_000;
    const responded = (extra: object) => parsePluginDecision({ ...base, state: 'answered', payload: { ...payload, pluginState: 'responded', response: { action: 'choose', choice: 'keep', at }, ...extra } }, now)!;
    expect(responded({ delivery: 'pending' })).toMatchObject({ state: 'responded', response: { choice: 'keep' }, unacknowledged: true });
    expect(responded({ delivery: 'failed' }).unacknowledged).toBe(false);
    expect(responded({ delivery: 'delivered' }).unacknowledged).toBe(false);
    expect(responded({ delivery: 'delivered', unacknowledged: true }).unacknowledged).toBe(true);
  });

  it('related session from links (sessionId stays null, r4); panelPath with #fragment', () => {
    const d = parsePluginDecision({ ...base, links: [{ type: 'url', ref: 'x' }, { type: 'session', ref: 's9' }], payload: { ...payload, panelPath: '/case/3#esc' } })!;
    expect(d).toMatchObject({ sessionId: 's9', panelPath: '/case/3#esc', pluginName: 'Hello', machineId: 'm1' });
  });
});

describe('owner-system cards', () => {
  it('parse and open state', () => {
    expect(parseOwnerSystemCard(attentionItem({ id: 'o1', source: 'owner-system', pluginInstallId: 'pi_2', title: '插件安装待批准' }))).toMatchObject({ installId: 'pi_2', open: true });
    expect(parseOwnerSystemCard(attentionItem({ id: 'o1', source: 'owner-system', state: 'resolved' }))).toMatchObject({ open: false });
    expect(parseOwnerSystemCard(attentionItem({ source: 'plugin' }))).toBeNull();
  });
});

describe('socket routing', () => {
  it('plugin and owner-system items are taken (sessionId null); session items are left to sync', () => {
    expect(handlePluginAttentionUpdate({ t: 'attention-item', item: base })).toBe(true);
    expect(usePluginDecisions.getState().items.att_1.title).toBe('T');
    expect(handlePluginAttentionUpdate({ t: 'attention-item', item: { ...base, title: 'older', version: 0 } })).toBe(true);
    expect(usePluginDecisions.getState().items.att_1.title).toBe('T');
    expect(handlePluginAttentionUpdate({ t: 'attention-item', item: attentionItem({ id: 'o1', source: 'owner-system', pluginInstallId: 'pi_2', title: 'Approve' }) })).toBe(true);
    expect(usePluginDecisions.getState().system.o1.installId).toBe('pi_2');
    // any other sessionless item is swallowed (never reaches session code); session items go on to ApiUpdateSchema
    expect(handlePluginAttentionUpdate({ t: 'attention-item', item: { id: 'x', source: 'agent', sessionId: null } })).toBe(true);
    // a malformed plugin item is dropped alone
    expect(handlePluginAttentionUpdate({ t: 'attention-item', item: { id: 'bad', source: 'plugin', sessionId: null } })).toBe(true);
    expect(usePluginDecisions.getState().items.bad).toBeUndefined();
    expect(handlePluginAttentionUpdate({ t: 'attention-item', item: { ...base, source: 'agent', sessionId: 's', pluginInstallId: null } })).toBe(false);
    expect(handlePluginAttentionUpdate({ t: 'new-message' })).toBe(false);
  });
});
