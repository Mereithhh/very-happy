import { describe, expect, it } from 'vitest';
import {
  parseSessionStreamFrame,
  sessionStreamFrameSchema,
  STREAM_DELTA_MAX_CHARS,
  streamKeyOf,
} from './streamProtocol';
import { createEnvelope, sessionEnvelopeSchema } from './sessionProtocol';

describe('session stream frames', () => {
  it('accepts every frame kind', () => {
    const frames = [
      { t: 'block-start', mid: 'msg_1', idx: 0, kind: 'thinking' },
      { t: 'block-delta', mid: 'msg_1', idx: 0, text: 'hel' },
      { t: 'block-end', mid: 'msg_1', idx: 0 },
      { t: 'progress', thinkingTokens: 120, outputTokens: 4, status: 'requesting' },
      { t: 'turn-end' },
    ];
    for (const frame of frames) {
      expect(sessionStreamFrameSchema.safeParse(frame).success).toBe(true);
    }
  });

  it('returns null rather than throwing on a malformed frame', () => {
    expect(parseSessionStreamFrame({ t: 'nope' })).toBeNull();
    expect(parseSessionStreamFrame({ t: 'block-delta', mid: 'm', idx: -1, text: 'x' })).toBeNull();
    expect(parseSessionStreamFrame(null)).toBeNull();
    expect(parseSessionStreamFrame({ t: 'block-start', mid: '', idx: 0, kind: 'text' })).toBeNull();
  });

  it('rejects a delta past the per-frame ceiling', () => {
    const oversized = { t: 'block-delta', mid: 'm', idx: 0, text: 'x'.repeat(STREAM_DELTA_MAX_CHARS + 1) };
    expect(parseSessionStreamFrame(oversized)).toBeNull();
  });

  it('builds the key a persisted envelope matches against', () => {
    expect(streamKeyOf('msg_01ABC', 2)).toBe('msg_01ABC:2');
  });
});

describe('envelope streamKey', () => {
  it('round-trips when provided and stays absent otherwise', () => {
    const withKey = createEnvelope('agent', { t: 'text', text: 'hi' }, { streamKey: 'msg_1:0' });
    expect(withKey.streamKey).toBe('msg_1:0');
    const without = createEnvelope('agent', { t: 'text', text: 'hi' });
    expect(without.streamKey).toBeUndefined();
    expect('streamKey' in without).toBe(false);
  });

  it('is optional, so envelopes from producers that never set it still parse', () => {
    const legacy = { id: 'a', time: 1, role: 'agent', ev: { t: 'text', text: 'hi' } };
    expect(sessionEnvelopeSchema.safeParse(legacy).success).toBe(true);
  });
});
