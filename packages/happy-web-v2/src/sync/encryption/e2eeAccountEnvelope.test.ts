import { describe, expect, it } from 'vitest';
import { E2EE_PROTOCOL_VERSION, E2EE_SUITE_V1 } from '@slopus/happy-wire';
import {
    accountEnvelopeAad,
    decryptAccountEnvelopeJson,
    encryptAccountEnvelopeJson,
    parseAccountEnvelope,
    serializeAccountEnvelope,
} from './e2eeAccountEnvelope';
import { utf8String } from './e2eeEncoding';

const EPOCH_ONE = Uint8Array.from({ length: 32 }, (_, index) => 64 + index);
const CONTEXT = {
    origin: 'https://happy.example',
    accountId: 'acc_vector_1',
    epochSecret: EPOCH_ONE,
};

describe('E2EE account envelope', () => {
    const expectedNotesContext = {
        expectedDomain: 'notes' as const,
        expectedObjectId: 'vh.note.v1.n1',
        expectedField: 'body',
    };

    it('matches the fixed AES-GCM/JCS vector', async () => {
        expect(utf8String(accountEnvelopeAad({
            v: E2EE_PROTOCOL_VERSION,
            suite: E2EE_SUITE_V1,
            origin: CONTEXT.origin,
            accountId: CONTEXT.accountId,
            epoch: 1,
            domain: 'tasks',
            objectId: 'vh.board-tasks.v1',
            field: 'tasks',
            nonce: 'gIGCg4SFhoeIiYqL',
        }))).toBe(
            '{"accountId":"acc_vector_1","domain":"tasks","epoch":1,"field":"tasks","nonce":"gIGCg4SFhoeIiYqL","objectId":"vh.board-tasks.v1","origin":"https://happy.example","suite":"vh-e2ee-1","v":1}',
        );
        const envelope = await encryptAccountEnvelopeJson({
            ...CONTEXT,
            epoch: 1,
            domain: 'tasks',
            objectId: 'vh.board-tasks.v1',
            field: 'tasks',
            value: { tasks: [{ title: 'ship E2EE', id: 'task-1' }] },
            nonce: Uint8Array.from({ length: 12 }, (_, index) => 128 + index),
        });
        expect(envelope.nonce).toBe('gIGCg4SFhoeIiYqL');
        expect(envelope.ciphertext)
            .toBe('-2PEIH6LGu1pGwXdK4J5_g-GajVaKGnIP2_hACLpVxadNBqaFpPk4SFIpMQ0FLQf30DaBb-Kcf8Ra2Zjh4lg');
        await expect(decryptAccountEnvelopeJson({
            ...CONTEXT,
            envelope,
            expectedDomain: 'tasks',
            expectedObjectId: 'vh.board-tasks.v1',
            expectedField: 'tasks',
        })).resolves.toEqual({ tasks: [{ id: 'task-1', title: 'ship E2EE' }] });
        const serialized = serializeAccountEnvelope(envelope);
        expect(serialized).toBe(
            '{"accountId":"acc_vector_1","ciphertext":"-2PEIH6LGu1pGwXdK4J5_g-GajVaKGnIP2_hACLpVxadNBqaFpPk4SFIpMQ0FLQf30DaBb-Kcf8Ra2Zjh4lg","domain":"tasks","epoch":1,"field":"tasks","nonce":"gIGCg4SFhoeIiYqL","objectId":"vh.board-tasks.v1","origin":"https://happy.example","suite":"vh-e2ee-1","v":1}',
        );
        expect(parseAccountEnvelope(serialized)).toEqual(envelope);
    });

    it('binds account, origin, domain, object, epoch and ciphertext', async () => {
        const envelope = await encryptAccountEnvelopeJson({
            ...CONTEXT, epoch: 1, domain: 'notes', objectId: 'vh.note.v1.n1', field: 'body',
            value: { body: 'secret' },
            nonce: new Uint8Array(12),
        });
        await expect(decryptAccountEnvelopeJson({
            ...CONTEXT,
            ...expectedNotesContext,
            accountId: 'acc_other',
            envelope,
        }))
            .rejects.toThrow(/context/);
        await expect(decryptAccountEnvelopeJson({
            ...CONTEXT,
            ...expectedNotesContext,
            envelope,
            expectedDomain: 'tasks',
        }))
            .rejects.toThrow(/domain/);
        await expect(decryptAccountEnvelopeJson({
            ...CONTEXT,
            ...expectedNotesContext,
            envelope,
            expectedField: 'title',
        }))
            .rejects.toThrow(/field/);
        await expect(decryptAccountEnvelopeJson({
            ...CONTEXT,
            ...expectedNotesContext,
            envelope: { ...envelope, objectId: 'vh.note.v1.n2' },
        }))
            .rejects.toThrow(/object/);
        await expect(decryptAccountEnvelopeJson({
            ...CONTEXT,
            ...expectedNotesContext,
            envelope: {
                ...envelope,
                ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`,
            },
        })).rejects.toThrow();
        await expect(decryptAccountEnvelopeJson({
            ...CONTEXT,
            envelope,
        } as never)).rejects.toThrow(/domain/);
        expect(() => parseAccountEnvelope(serializeAccountEnvelope({ ...envelope }) + '\n'))
            .toThrow(/Non-canonical/);
    });
});
